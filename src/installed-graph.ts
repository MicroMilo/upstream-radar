import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parsePackageManifestSnapshot } from './inventory.js'
import { dependencyGraphDigest } from './graph.js'
import {
  DEPENDENCY_GRAPH_SCHEMA,
  type DependencyEdge,
  type DependencyGraph,
  type DependencyKind,
  type DependencyNode,
  type PackageManifestSnapshot,
} from './radar-types.js'

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_NODES = 100_000
const MAX_EDGES = 250_000

interface RootPackage {
  name: string
  version: string
}

interface InstalledPackage {
  id: string
  directory: string
  source: 'profile' | 'dsh-host'
  manifest: PackageManifestSnapshot
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string') result[name] = spec
  }
  return result
}

function dependencyEntries(item: PackageManifestSnapshot): Array<{ name: string; spec: string; kind: DependencyKind }> {
  const selected = new Map<string, { spec: string; kind: DependencyKind }>()
  const add = (value: unknown, kind: DependencyKind): void => {
    for (const [name, spec] of Object.entries(asStringRecord(value))) selected.set(name, { spec, kind })
  }
  add(item.dependencies, 'runtime')
  add(item.peerDependencies, 'peer')
  add(item.optionalDependencies, 'optional')
  return [...selected.entries()].map(([name, value]) => ({ name, ...value }))
}

function isLexicallyInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function isPackageName(value: string): boolean {
  return /^(?:@[^/\\]+\/[^/\\]+|[^/\\/]+)$/.test(value)
    && !value.includes('..')
    && value !== '.'
}

function nodeId(rootDirectory: string, packageDirectory: string): string {
  const value = relative(rootDirectory, resolve(packageDirectory))
  if (value === '' || value.startsWith(`..${sep}`) || value === '..' || isAbsolute(value)) {
    throw new Error(`installed package path escapes the DSH profile: ${packageDirectory}`)
  }
  return value.split(sep).join('/')
}

function hostNodeId(hostNodeModulesDirectory: string, packageDirectory: string): string {
  const value = relative(dirname(hostNodeModulesDirectory), resolve(packageDirectory))
  if (value === '' || value.startsWith(`..${sep}`) || value === '..' || isAbsolute(value)) {
    throw new Error(`DSH host package path escapes the shared dependency plane: ${packageDirectory}`)
  }
  return `dsh-host/${value.split(sep).join('/')}`
}

async function readProfileManifest(
  packageDirectory: string,
  profileRoot: string,
  profileRootReal: string,
): Promise<InstalledPackage> {
  const realDirectory = await realpath(packageDirectory)
  if (!isLexicallyInside(profileRootReal, realDirectory)) {
    throw new Error(`installed package path escapes the DSH profile: ${packageDirectory}`)
  }
  const manifestPath = await realpath(join(packageDirectory, 'package.json'))
  if (!isLexicallyInside(profileRootReal, manifestPath)) {
    throw new Error(`installed package manifest escapes the DSH profile: ${packageDirectory}`)
  }
  const contents = await readFile(manifestPath, 'utf8')
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES) {
    throw new Error(`installed package manifest exceeds the ${MAX_MANIFEST_BYTES} byte limit: ${packageDirectory}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    throw new Error(`installed package manifest is not valid JSON: ${packageDirectory}`)
  }
  const manifest = parsePackageManifestSnapshot(parsed)
  return { id: nodeId(profileRoot, packageDirectory), directory: packageDirectory, source: 'profile', manifest }
}

async function readHostManifest(
  packageDirectory: string,
  hostNodeModulesDirectory: string,
): Promise<InstalledPackage> {
  const realDirectory = await realpath(packageDirectory)
  const manifestPath = await realpath(join(packageDirectory, 'package.json'))
  const contents = await readFile(manifestPath, 'utf8')
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES) {
    throw new Error(`DSH host package manifest exceeds the ${MAX_MANIFEST_BYTES} byte limit: ${packageDirectory}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    throw new Error(`DSH host package manifest is not valid JSON: ${packageDirectory}`)
  }
  const manifest = parsePackageManifestSnapshot(parsed)
  return {
    id: hostNodeId(hostNodeModulesDirectory, packageDirectory),
    directory: realDirectory,
    source: 'dsh-host',
    manifest,
  }
}

async function findProfilePackage(
  parentDirectory: string,
  dependencyName: string,
  profileRoot: string,
  profileRootReal: string,
): Promise<InstalledPackage | undefined> {
  if (!isPackageName(dependencyName)) return undefined
  let cursor = resolve(parentDirectory)
  while (isLexicallyInside(profileRoot, cursor)) {
    const dependencyDirectory = resolve(cursor, 'node_modules', ...dependencyName.split('/'))
    if (!isLexicallyInside(profileRoot, dependencyDirectory)) return undefined
    try {
      return await readProfileManifest(dependencyDirectory, profileRoot, profileRootReal)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    if (cursor === profileRoot) break
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  return undefined
}

async function findHostPackage(
  dependencyName: string,
  hostNodeModulesDirectory: string,
): Promise<InstalledPackage | undefined> {
  if (!isPackageName(dependencyName)) return undefined
  const dependencyDirectory = resolve(hostNodeModulesDirectory, ...dependencyName.split('/'))
  if (!isLexicallyInside(hostNodeModulesDirectory, dependencyDirectory)) return undefined
  try {
    const target = await readHostManifest(dependencyDirectory, hostNodeModulesDirectory)
    if (target.manifest.name !== dependencyName) {
      throw new Error(`DSH host package manifest name does not match resolved dependency: ${dependencyName}`)
    }
    return target
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    return undefined
  }
}

/** Read the package tree that DSH can actually resolve from its installed profile. */
export async function parseInstalledNodeModulesGraph(
  profileDirectory: string,
  rootPackage: RootPackage,
  options: { hostNodeModulesDirectory?: string } = {},
): Promise<DependencyGraph> {
  const profileRoot = resolve(profileDirectory)
  const profileRootReal = await realpath(profileRoot)
  const hostNodeModulesDirectory = options.hostNodeModulesDirectory === undefined
    ? undefined
    : resolve(options.hostNodeModulesDirectory)
  let hostNodeModulesDirectoryReal: string | undefined
  if (hostNodeModulesDirectory !== undefined) {
    try {
      hostNodeModulesDirectoryReal = await realpath(hostNodeModulesDirectory)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
  }
  if (!isPackageName(rootPackage.name)) throw new Error(`invalid installed root package name: ${rootPackage.name}`)
  const root = await findProfilePackage(profileRoot, rootPackage.name, profileRoot, profileRootReal)
  if (root === undefined) {
    throw new Error(`installed root package is not present in the DSH profile: ${rootPackage.name}@${rootPackage.version}`)
  }
  if (root.manifest.name !== rootPackage.name || root.manifest.version !== rootPackage.version) {
    throw new Error(`installed root package does not match requested coordinate: ${rootPackage.name}@${rootPackage.version}`)
  }

  const packages = new Map<string, InstalledPackage>([[root.id, root]])
  const edges: DependencyEdge[] = []
  const unresolved: NonNullable<DependencyGraph['unresolved']> = []
  const queue = [root.id]
  for (let index = 0; index < queue.length; index += 1) {
    const currentId = queue[index]
    if (currentId === undefined) break
    const current = packages.get(currentId)
    if (current === undefined) continue
    for (const dependency of dependencyEntries(current.manifest)) {
      const target = current.source === 'dsh-host'
        ? (hostNodeModulesDirectory === undefined ? undefined : await findHostPackage(dependency.name, hostNodeModulesDirectory))
        : (await findProfilePackage(current.directory, dependency.name, profileRoot, profileRootReal)
          ?? (hostNodeModulesDirectory === undefined ? undefined : await findHostPackage(dependency.name, hostNodeModulesDirectory)))
      if (target === undefined) {
        unresolved.push({ from: current.id, ...dependency })
        if (unresolved.length > MAX_EDGES) throw new Error(`installed dependency graph exceeds the ${MAX_EDGES} edge limit`)
        continue
      }
      if (edges.length >= MAX_EDGES) throw new Error(`installed dependency graph exceeds the ${MAX_EDGES} edge limit`)
      edges.push({ from: current.id, to: target.id, kind: dependency.kind })
      if (packages.has(target.id)) continue
      if (packages.size >= MAX_NODES) throw new Error(`installed dependency graph exceeds the ${MAX_NODES} node limit`)
      packages.set(target.id, target)
      queue.push(target.id)
    }
  }

  const nodes: DependencyNode[] = [...packages.values()]
    .map(item => ({ id: item.id, name: item.manifest.name, version: item.manifest.version, source: item.source }))
    .sort((left, right) => left.id === root.id ? -1 : right.id === root.id ? 1 : left.id.localeCompare(right.id))
  const sortedEdges = edges.sort((left, right) => (
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind)
  ))
  const reachableUnresolved = unresolved
    .sort((left, right) => left.from.localeCompare(right.from) || left.name.localeCompare(right.name))

  return {
    schema: DEPENDENCY_GRAPH_SCHEMA,
    rootNodeId: root.id,
    nodes,
    edges: sortedEdges,
    source: 'installed-node-modules',
    digest: dependencyGraphDigest(nodes, sortedEdges),
    ...(hostNodeModulesDirectoryReal === undefined ? {} : {
      hostRuntime: {
        source: 'dsh-profile-fallback' as const,
        resolvedNodes: [...packages.values()].filter(item => item.source === 'dsh-host').length,
      },
    }),
    ...(reachableUnresolved.length === 0 ? {} : { unresolved: reachableUnresolved }),
  }
}
