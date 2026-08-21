import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parsePackageManifestSnapshot } from './inventory.js'
import { dependencyGraphDigest } from './graph.js'
import { satisfiesSemverRange } from './semver.js'
import {
  DEPENDENCY_GRAPH_SCHEMA,
  type DependencyEdge,
  type DependencyHostRuntimeSource,
  type DependencyGraph,
  type DependencyKind,
  type DependencyNode,
  type PackageCoordinate,
  type PackageManifestSnapshot,
  type RootPeerContract,
} from './radar-types.js'

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_NODES = 100_000
const MAX_EDGES = 250_000
const DSH_RUNTIME_PACKAGE_NAME = '@deepseek-ai/dsh'

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

const HOST_RUNTIME_EDGE_KIND: DependencyKind = 'host-runtime'

/**
 * Installed npm manifests are source material, not Radar configuration. Some
 * packages in the DSH host tree publish an empty or non-string optional
 * `main`/`type` field; it carries no dependency information, so omit it only
 * at this read-only graph boundary and keep the stricter inventory parser
 * unchanged.
 */
function parseInstalledManifestSnapshot(value: unknown): PackageManifestSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return parsePackageManifestSnapshot(value)
  }
  const normalized = { ...(value as Record<string, unknown>) }
  if (typeof normalized.main !== 'string' || normalized.main.length === 0) delete normalized.main
  if (typeof normalized.type !== 'string' || normalized.type.length === 0) delete normalized.type
  return parsePackageManifestSnapshot(normalized)
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
  const add = (value: unknown, kind: DependencyKind, selectKind?: (name: string) => DependencyKind): void => {
    for (const [name, spec] of Object.entries(asStringRecord(value))) {
      selected.set(name, { spec, kind: selectKind?.(name) ?? kind })
    }
  }
  add(item.dependencies, 'runtime')
  add(item.peerDependencies, 'peer', name => item.peerDependenciesMeta?.[name]?.optional === true ? 'optional' : 'peer')
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

function hostNodeId(hostNodeModulesDirectoryReal: string, packageDirectoryReal: string): string {
  const value = relative(dirname(hostNodeModulesDirectoryReal), resolve(packageDirectoryReal))
  if (value === '' || value.startsWith(`..${sep}`) || value === '..' || isAbsolute(value)) {
    throw new Error(`DSH host package path escapes the shared dependency plane: ${packageDirectoryReal}`)
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
  const manifest = parseInstalledManifestSnapshot(parsed)
  return { id: nodeId(profileRoot, packageDirectory), directory: packageDirectory, source: 'profile', manifest }
}

async function readHostManifest(
  packageDirectory: string,
  hostNodeModulesDirectory: string,
  hostNodeModulesDirectoryReal: string,
): Promise<InstalledPackage> {
  const realDirectory = await realpath(packageDirectory)
  if (!isLexicallyInside(hostNodeModulesDirectoryReal, realDirectory)) {
    throw new Error(`DSH host package path escapes the shared dependency plane: ${packageDirectory}`)
  }
  const manifestPath = await realpath(join(packageDirectory, 'package.json'))
  if (!isLexicallyInside(hostNodeModulesDirectoryReal, manifestPath)) {
    throw new Error(`DSH host package manifest escapes the shared dependency plane: ${packageDirectory}`)
  }
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
  const manifest = parseInstalledManifestSnapshot(parsed)
  return {
    id: hostNodeId(hostNodeModulesDirectoryReal, realDirectory),
    directory: realDirectory,
    source: 'dsh-host',
    manifest,
  }
}

/** Read the DSH executable package when it lives beside, rather than inside, its dependency plane. */
async function readRuntimeManifest(packageDirectory: string): Promise<InstalledPackage> {
  const realDirectory = await realpath(packageDirectory)
  const manifestPath = await realpath(join(packageDirectory, 'package.json'))
  const contents = await readFile(manifestPath, 'utf8')
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES) {
    throw new Error(`DSH runtime package manifest exceeds the ${MAX_MANIFEST_BYTES} byte limit: ${packageDirectory}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    throw new Error(`DSH runtime package manifest is not valid JSON: ${packageDirectory}`)
  }
  const manifest = parseInstalledManifestSnapshot(parsed)
  if (manifest.name !== DSH_RUNTIME_PACKAGE_NAME) {
    throw new Error(`DSH runtime package manifest name does not match ${DSH_RUNTIME_PACKAGE_NAME}: ${packageDirectory}`)
  }
  return { id: 'dsh-host/runtime', directory: realDirectory, source: 'dsh-host', manifest }
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
  parentDirectory: string,
  dependencyName: string,
  hostNodeModulesDirectory: string,
  hostNodeModulesDirectoryReal: string,
): Promise<InstalledPackage | undefined> {
  if (!isPackageName(dependencyName)) return undefined
  let cursor: string
  try {
    cursor = await realpath(parentDirectory)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  if (!isLexicallyInside(hostNodeModulesDirectoryReal, cursor)) {
    try {
      const adjacentNodeModules = await realpath(join(cursor, 'node_modules'))
      if (adjacentNodeModules !== hostNodeModulesDirectoryReal) return undefined
      cursor = hostNodeModulesDirectoryReal
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  }

  /**
   * pnpm resolves a package's dependencies from the package-local virtual
   * `node_modules`, then walks outward. Looking only at the outer host plane
   * misses the links beside `@deepseek-ai/dsh` itself, which is how `pnpm dlx`
   * stores most of DSH's runtime dependencies.
   */
  while (isLexicallyInside(hostNodeModulesDirectoryReal, cursor)) {
    const dependencyDirectory = cursor === hostNodeModulesDirectoryReal
      ? resolve(cursor, ...dependencyName.split('/'))
      : resolve(cursor, 'node_modules', ...dependencyName.split('/'))
    if (isLexicallyInside(hostNodeModulesDirectoryReal, dependencyDirectory)) {
      try {
        const target = await readHostManifest(dependencyDirectory, hostNodeModulesDirectory, hostNodeModulesDirectoryReal)
        if (target.manifest.name !== dependencyName) {
          throw new Error(`DSH host package manifest name does not match resolved dependency: ${dependencyName}`)
        }
        return target
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      }
    }
    if (cursor === hostNodeModulesDirectoryReal) break
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  return undefined
}

/** Read the package tree that DSH can actually resolve from its installed profile. */
export async function parseInstalledNodeModulesGraph(
  profileDirectory: string,
  rootPackage: RootPackage,
  options: {
    hostNodeModulesDirectory?: string
    hostRuntimeSource?: DependencyHostRuntimeSource
    hostRuntimePackage?: PackageCoordinate
    hostRuntimePackageDirectory?: string
  } = {},
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
  if (options.hostRuntimePackage !== undefined
    && (options.hostRuntimePackage.ecosystem !== 'npm' || options.hostRuntimePackage.name !== DSH_RUNTIME_PACKAGE_NAME)) {
    throw new Error(`DSH host runtime package must be ${DSH_RUNTIME_PACKAGE_NAME}`)
  }
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
  const rootPeerContracts: RootPeerContract[] = []
  const queue = [root.id]
  if (hostNodeModulesDirectoryReal !== undefined && options.hostRuntimePackage !== undefined) {
    const resolvedHostNodeModulesDirectory = hostNodeModulesDirectory
    if (resolvedHostNodeModulesDirectory === undefined) throw new Error('DSH host dependency plane is unexpectedly unavailable')
    const runtimePackageDirectory = options.hostRuntimePackageDirectory
    let runtimeRoot: InstalledPackage | undefined
    if (runtimePackageDirectory !== undefined) {
      let runtimeDirectoryReal: string | undefined
      try {
        runtimeDirectoryReal = await realpath(runtimePackageDirectory)
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      }
      if (runtimeDirectoryReal !== undefined) {
        runtimeRoot = isLexicallyInside(hostNodeModulesDirectoryReal, runtimeDirectoryReal)
          ? await readHostManifest(runtimePackageDirectory, resolvedHostNodeModulesDirectory, hostNodeModulesDirectoryReal)
          : await readRuntimeManifest(runtimePackageDirectory)
      }
    } else {
      runtimeRoot = await findHostPackage(
        resolvedHostNodeModulesDirectory,
        '@deepseek-ai/dsh',
        resolvedHostNodeModulesDirectory,
        hostNodeModulesDirectoryReal,
      )
    }
    if (runtimeRoot !== undefined) {
      if (runtimeRoot.manifest.name !== options.hostRuntimePackage.name) {
        throw new Error(`DSH runtime package manifest name does not match discovered coordinate: expected ${options.hostRuntimePackage.name}, found ${runtimeRoot.manifest.name}`)
      }
      if (runtimeRoot.manifest.version !== options.hostRuntimePackage.version) {
        throw new Error(`DSH runtime package does not match discovered coordinate: expected @deepseek-ai/dsh@${options.hostRuntimePackage.version}, found ${runtimeRoot.manifest.version}`)
      }
      if (!packages.has(runtimeRoot.id)) {
        if (packages.size >= MAX_NODES) throw new Error(`installed dependency graph exceeds the ${MAX_NODES} node limit`)
        packages.set(runtimeRoot.id, runtimeRoot)
        queue.push(runtimeRoot.id)
      }
      if (!edges.some(edge => edge.from === root.id && edge.to === runtimeRoot.id && edge.kind === HOST_RUNTIME_EDGE_KIND)) {
        if (edges.length >= MAX_EDGES) throw new Error(`installed dependency graph exceeds the ${MAX_EDGES} edge limit`)
        edges.push({ from: root.id, to: runtimeRoot.id, kind: HOST_RUNTIME_EDGE_KIND })
      }
    } else {
      unresolved.push({
        from: root.id,
        name: options.hostRuntimePackage.name,
        kind: HOST_RUNTIME_EDGE_KIND,
        spec: `=${options.hostRuntimePackage.version}`,
      })
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const currentId = queue[index]
    if (currentId === undefined) break
    const current = packages.get(currentId)
    if (current === undefined) continue
    for (const dependency of dependencyEntries(current.manifest)) {
      const target = current.source === 'dsh-host'
        ? (hostNodeModulesDirectory === undefined || hostNodeModulesDirectoryReal === undefined
            ? undefined
            : await findHostPackage(
              current.directory,
              dependency.name,
              hostNodeModulesDirectory,
              hostNodeModulesDirectoryReal,
            ))
        : (await findProfilePackage(current.directory, dependency.name, profileRoot, profileRootReal)
          ?? (hostNodeModulesDirectory === undefined || hostNodeModulesDirectoryReal === undefined
              ? undefined
              : await findHostPackage(
                hostNodeModulesDirectory,
                dependency.name,
                hostNodeModulesDirectory,
                hostNodeModulesDirectoryReal,
              )))
      if (target === undefined) {
        unresolved.push({ from: current.id, ...dependency })
        if (unresolved.length > MAX_EDGES) throw new Error(`installed dependency graph exceeds the ${MAX_EDGES} edge limit`)
        if (current.id === root.id && dependency.kind === 'peer') {
          rootPeerContracts.push({ name: dependency.name, required: dependency.spec, status: 'missing' })
        }
        continue
      }
      if (edges.length >= MAX_EDGES) throw new Error(`installed dependency graph exceeds the ${MAX_EDGES} edge limit`)
      edges.push({ from: current.id, to: target.id, kind: dependency.kind })
      if (current.id === root.id && dependency.kind === 'peer') {
        const evaluation = satisfiesSemverRange(target.manifest.version, dependency.spec)
        rootPeerContracts.push({
          name: dependency.name,
          required: dependency.spec,
          status: evaluation === true ? 'satisfied' : evaluation === false ? 'mismatched' : 'indeterminate',
          resolvedVersion: target.manifest.version,
        })
      }
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
        source: options.hostRuntimeSource ?? 'dsh-profile-fallback',
        resolvedNodes: [...packages.values()].filter(item => item.source === 'dsh-host').length,
        ...(options.hostRuntimePackage === undefined ? {} : { package: { ...options.hostRuntimePackage } }),
      },
    }),
    ...(rootPeerContracts.length === 0 ? {} : {
      rootPeerContracts: rootPeerContracts.sort((left, right) => left.name.localeCompare(right.name)),
    }),
    ...(reachableUnresolved.length === 0 ? {} : { unresolved: reachableUnresolved }),
  }
}
