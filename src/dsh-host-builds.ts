import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, opendir, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { parsePnpmLockGraph } from './graph.js'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const LOCATOR = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\([^\r\n]*\))?$/
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const childPath = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`

export interface DshHostBuildPackage {
  spec: string
  /** Physical location relative to the controlled cache; never a followed alias. */
  location: string
  manifestSha256: string
  lifecycleScripts: Partial<Record<'preinstall' | 'install' | 'postinstall', string>>
  /** pnpm metadata for this coordinate, not proof that a build is still needed. */
  reportedLocators: string[]
  metadataSources: Array<'pendingBuilds' | 'ignoredBuilds'>
}

export interface DshHostBuildInventory {
  revision: 'dsh-host-build-inventory/1'
  scope: 'dsh-host-build-facts'
  dshVersion: string
  pnpmVersion?: string
  installation?: {
    location: string
    manifestSha256: string
    hostManifestSha256: string
    lockfileSha256: string
    /** The declared lock graph, deliberately not called an installed runtime graph. */
    lockGraphDigest: string
  }
  packages: DshHostBuildPackage[]
  coverageGaps: string[]
}

export interface DshHostNativeLoadFailure {
  scope: 'dsh-host-native-load-failure'
  packageSpec: string
  manifestSha256: string
  /** Reported by the process, not a claim that a build was approved or succeeded. */
  missingModule: string
  requiringFile: string
  outputSha256: string
}

function nativeFailurePackage(inventory: DshHostBuildInventory, requiringFile: string, missingModule: string): DshHostBuildPackage | undefined {
  try { parts(requiringFile) } catch { return undefined }
  if (missingModule.length > 2_048 || !/^\.\.?\/[^\r\n\\\u0000]+\.node$/.test(missingModule)) return undefined
  const item = inventory.packages.find(item => requiringFile.startsWith(`${item.location}/`))
  if (!item || Object.keys(item.lifecycleScripts).length === 0) return undefined
  // The relative native target must also stay inside this physical package.
  const target = posix.normalize(posix.join(posix.dirname(requiringFile), missingModule))
  return target.startsWith(`${item.location}/`) ? item : undefined
}

/** Correlate the error's first requiring file with an independently collected
 * host package. These facts request investigation; they never grant execution.
 */
export function collectDshHostNativeLoadFailures(inventory: DshHostBuildInventory, cacheHome: string, output: string): DshHostNativeLoadFailure[] {
  if (inventory.coverageGaps.length || !inventory.installation || Buffer.byteLength(output) > 256 * 1024) return []
  if (!cacheHome.startsWith('/')) return []
  try { parts(cacheHome.slice(1)) } catch { return [] }
  const result: DshHostNativeLoadFailure[] = []
  const pattern = /Cannot find module ['"](\.[^'"\r\n]{1,2048}\.node)['"][ \t]*\r?\n[ \t]*Require stack:[ \t]*\r?\n[ \t]*- ([^\r\n]{1,4096})/g
  for (const match of output.matchAll(pattern)) {
    const path = match[2]!.trim()
    if (!path.startsWith(`${cacheHome}/`)) continue
    const requiringFile = path.slice(cacheHome.length + 1)
    const missingModule = match[1]!
    const item = nativeFailurePackage(inventory, requiringFile, missingModule)
    if (!item || result.some(row => row.requiringFile === requiringFile && row.missingModule === missingModule)) continue
    result.push({ scope: 'dsh-host-native-load-failure', packageSpec: item.spec, manifestSha256: item.manifestSha256,
      missingModule, requiringFile, outputSha256: digest(Buffer.from(output)) })
    if (result.length >= 16) break
  }
  return result
}

export function parseDshHostNativeLoadFailures(input: unknown, inventory: DshHostBuildInventory): DshHostNativeLoadFailure[] {
  if (!Array.isArray(input) || input.length > 16) throw new Error('host native-load failures exceed their evidence bound')
  if (input.length && (inventory.coverageGaps.length || !inventory.installation)) throw new Error('host native-load failure requires complete physical inventory')
  const seen = new Set<string>()
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('host native-load failure must be an object')
    const row = value as Record<string, unknown>
    if (row.scope !== 'dsh-host-native-load-failure' || typeof row.requiringFile !== 'string' || typeof row.missingModule !== 'string') throw new Error('unsupported host native-load evidence')
    const item = nativeFailurePackage(inventory, row.requiringFile, row.missingModule)
    if (!item || item.spec !== row.packageSpec || item.manifestSha256 !== row.manifestSha256) throw new Error('host native-load failure does not match its physical package')
    if (typeof row.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.outputSha256)) throw new Error('host native-load output requires a SHA-256 digest')
    const key = `${row.requiringFile}\n${row.missingModule}`
    if (seen.has(key)) throw new Error('duplicate host native-load failure')
    seen.add(key)
    return { scope: row.scope, packageSpec: item.spec, manifestSha256: item.manifestSha256,
      missingModule: row.missingModule, requiringFile: row.requiringFile, outputSha256: row.outputSha256 }
  })
}

function parts(path: string): string[] {
  const result = path.split('/')
  if (Buffer.byteLength(path) > 2_048 || /[\\\u0000-\u001f\u007f]/.test(path)
    || result.some(part => part === '' || part === '.' || part === '..')) throw new Error('host inventory path must stay within its bounded root')
  return result
}

async function directoryAt(parent: FileHandle, path: string): Promise<FileHandle> {
  let current: FileHandle | undefined
  try {
    for (const part of parts(path)) {
      const next = await open(childPath(current ?? parent, part), DIRECTORY)
      await current?.close()
      current = next
    }
    return current!
  } catch (error) { await current?.close(); throw error }
}

function object(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error(`${label} is not supported JSON metadata`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

/** Parse persisted, untrusted facts without granting a build permission. */
export function parseDshHostBuildInventory(input: unknown): DshHostBuildInventory {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('host build inventory must contain objects')
    return value as Record<string, unknown>
  }
  const text = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new Error('host build inventory string exceeds its bound')
    return value
  }
  const exact = (value: unknown): string => {
    const result = text(value, 128)
    if (!VERSION.test(result)) throw new Error('host build inventory requires an exact version')
    return result
  }
  const sha = (value: unknown): string => {
    const result = text(value, 64)
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('host build inventory requires a SHA-256 digest')
    return result
  }
  const list = (value: unknown, maximum: number): unknown[] => {
    if (!Array.isArray(value) || value.length > maximum) throw new Error('host build inventory list exceeds its bound')
    return value
  }
  const location = (value: unknown): string => {
    const result = text(value, 2_048)
    const names = parts(result)
    if (names.length < 4 || names[0] !== 'pnpm' || names[1] !== 'dlx') throw new Error('host build inventory location must stay within the DLX cache')
    return result
  }
  const root = record(input)
  if (root.revision !== 'dsh-host-build-inventory/1' || root.scope !== 'dsh-host-build-facts') throw new Error('unsupported host build inventory scope or revision')
  const result: DshHostBuildInventory = { revision: root.revision, scope: root.scope, dshVersion: exact(root.dshVersion),
    ...(root.pnpmVersion === undefined ? {} : { pnpmVersion: exact(root.pnpmVersion) }),
    packages: [], coverageGaps: list(root.coverageGaps, 16).map(value => text(value, 256)) }
  if (root.installation !== undefined) {
    const item = record(root.installation)
    const path = location(item.location)
    if (parts(path).length !== 4) throw new Error('host installation must be an exact DLX instance')
    const graph = text(item.lockGraphDigest, 71)
    if (!/^sha256:[a-f0-9]{64}$/.test(graph)) throw new Error('host inventory requires an exact lock graph digest')
    result.installation = { location: path, manifestSha256: sha(item.manifestSha256), hostManifestSha256: sha(item.hostManifestSha256),
      lockfileSha256: sha(item.lockfileSha256), lockGraphDigest: graph }
  }
  const seen = new Set<string>()
  result.packages = list(root.packages, 128).map(value => {
    const item = record(value)
    const spec = text(item.spec, 344)
    const match = LOCATOR.exec(spec)
    if (!match || spec !== `${match[1]}@${match[2]}` || match[1]!.length > 214) throw new Error('host build package requires an exact package coordinate')
    const path = location(item.location)
    const names = parts(path)
    const prefix = result.installation?.location ?? names.slice(0, 4).join('/')
    if (!path.startsWith(`${prefix}/node_modules/.pnpm/`) || names[7] !== 'node_modules'
      || names.slice(8).join('/') !== match[1]) throw new Error('host build package is outside its physical installation')
    if (seen.has(path)) throw new Error('duplicate physical host build package location')
    seen.add(path)
    const scripts = record(item.lifecycleScripts)
    const lifecycleScripts: DshHostBuildPackage['lifecycleScripts'] = {}
    for (const name of ['preinstall', 'install', 'postinstall'] as const) {
      if (scripts[name] === undefined) continue
      if (typeof scripts[name] !== 'string' || scripts[name].length > 4_096) throw new Error('host lifecycle script exceeds its evidence bound')
      lifecycleScripts[name] = scripts[name]
    }
    const reportedLocators = list(item.reportedLocators, 128).map(value => {
      const locator = text(value, 2_048)
      const found = LOCATOR.exec(locator)
      if (!found || `${found[1]}@${found[2]}` !== spec) throw new Error('host build locator does not match its physical package')
      return locator
    })
    const metadataSources = list(item.metadataSources, 2).map(value => {
      if (value !== 'pendingBuilds' && value !== 'ignoredBuilds') throw new Error('unsupported host build metadata source')
      return value
    })
    if (!reportedLocators.length || !metadataSources.length || new Set(reportedLocators).size !== reportedLocators.length
      || new Set(metadataSources).size !== metadataSources.length) throw new Error('host build metadata sources must be nonempty and unique')
    return { spec, location: path, manifestSha256: sha(item.manifestSha256), lifecycleScripts,
      reportedLocators: reportedLocators.sort(), metadataSources: metadataSources.sort() }
  })
  if (!result.coverageGaps.length && (!result.installation || !result.pnpmVersion)) throw new Error('complete host build inventory requires installation and package-manager identity')
  return result
}

/** Collect host build investigation inputs without executing code or following
 * target-controlled links. pnpm 11 JSON modules metadata is supported; other
 * formats stay explicit coverage gaps. A pending entry is never a verdict.
 */
export async function collectDshHostBuildInventory(cacheHome: string, dshVersion: string): Promise<DshHostBuildInventory> {
  if (dshVersion.length > 128 || !VERSION.test(dshVersion)) throw new Error('host inventory requires an exact DSH version')
  if (!cacheHome.startsWith('/')) throw new Error('host inventory requires an absolute controlled cache')
  parts(cacheHome.slice(1))
  const result: DshHostBuildInventory = { revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts', dshVersion,
    packages: [], coverageGaps: [] }
  const gap = (message: string): void => {
    const text = message.slice(0, 256)
    if (result.coverageGaps.includes(text)) return
    if (result.coverageGaps.length < 16) result.coverageGaps.push(text)
    else result.coverageGaps[15] = 'additional host inventory coverage gaps omitted after the diagnostic bound'
  }
  if (process.platform !== 'linux') { gap('safe host build inventory requires Linux directory-descriptor APIs'); return result }
  const deadline = Date.now() + 30_000
  let entries = 0, totalBytes = 0
  const check = (): void => {
    if (Date.now() >= deadline || entries > 50_000 || totalBytes > 64 * 1024 * 1024) throw new Error('host inventory collection budget exceeded')
  }
  const read = async (directory: FileHandle, name: string, maximum: number): Promise<Buffer> => {
    check()
    const handle = await open(childPath(directory, name), FILE)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > maximum) throw new Error(`${name} is not a bounded regular file`)
      totalBytes += before.size
      check()
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        check()
        const next = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!next.bytesRead) break
        offset += next.bytesRead
      }
      const after = await handle.stat()
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${name} changed during host inventory collection`)
      return bytes.subarray(0, offset)
    } finally { await handle.close() }
  }
  const directories = async (directory: FileHandle, maximum: number): Promise<string[]> => {
    const found: string[] = []
    const stream = await opendir(childPath(directory, '.'))
    for await (const entry of stream) {
      entries += 1
      check()
      if (!entry.isDirectory()) continue // Normal pnpm aliases are not traversal roots.
      if (found.length >= maximum) throw new Error('host inventory directory count exceeds its bound')
      found.push(entry.name)
    }
    return found.sort()
  }
  let slash: FileHandle | undefined, cache: FileHandle | undefined, dlx: FileHandle | undefined
  try {
    slash = await open('/', DIRECTORY)
    cache = await directoryAt(slash, cacheHome.slice(1))
    dlx = await directoryAt(cache, 'pnpm/dlx')
    const candidates: Array<{ location: string; manifest: Buffer }> = []
    for (const key of await directories(dlx, 8)) {
      const cacheKey = await directoryAt(dlx, key)
      try {
        for (const instance of await directories(cacheKey, 8)) {
          const directory = await directoryAt(cacheKey, instance)
          try {
            let bytes: Buffer
            try { bytes = await read(directory, 'package.json', 1024 * 1024) }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
            const manifest = object(bytes, 'DLX manifest')
            const dependencies = manifest.dependencies as Record<string, unknown> | undefined
            if (dependencies?.['@deepseek-ai/dsh'] === dshVersion) candidates.push({ location: `pnpm/dlx/${key}/${instance}`, manifest: bytes })
          } finally { await directory.close() }
        }
      } finally { await cacheKey.close() }
    }
    if (candidates.length !== 1) throw new Error(`host inventory requires one exact DSH installation; found ${candidates.length}`)
    const candidate = candidates[0]!
    const installation = await directoryAt(cache, candidate.location)
    try {
      const manifest = await read(installation, 'package.json', 1024 * 1024)
      if (digest(manifest) !== digest(candidate.manifest)) throw new Error('DLX manifest changed during discovery')
      const lockfile = await read(installation, 'pnpm-lock.yaml', 8 * 1024 * 1024)
      // Resolve through the actual importer so a peer-suffixed host snapshot
      // cannot be replaced with its dependency-free package metadata entry.
      const graph = parsePnpmLockGraph(lockfile.toString('utf8'), { name: '@deepseek-ai/dsh', version: dshVersion }, { importer: '.' })
      if (!graph.digest || !graph.edges.some(edge => edge.from === graph.rootNodeId
        && graph.nodes.some(node => node.id === edge.to && node.name === '@deepseek-ai/dsh' && node.version === dshVersion))) throw new Error('the lock importer does not establish the exact DSH host')
      if (graph.unresolved?.some(edge => edge.kind !== 'optional')) gap('the host lock graph contains unresolved required dependencies')
      const modulesDirectory = await directoryAt(installation, 'node_modules')
      try {
        const modules = object(await read(modulesDirectory, '.modules.yaml', 4 * 1024 * 1024), 'pnpm modules manifest')
        const manager = typeof modules.packageManager === 'string' ? /^pnpm@(.+)$/.exec(modules.packageManager) : null
        if (!manager || manager[1]!.length > 128 || !VERSION.test(manager[1]!) || modules.virtualStoreDir !== '.pnpm') throw new Error('unsupported pnpm host metadata version or virtual-store layout')
        result.pnpmVersion = manager[1]!
        if (!Array.isArray(modules.pendingBuilds)) throw new Error('pnpm pending-build coverage is absent')
        const pending = new Map<string, { name: string; locators: Set<string>; sources: Set<'pendingBuilds' | 'ignoredBuilds'> }>()
        for (const source of ['pendingBuilds', 'ignoredBuilds'] as const) {
          const values = modules[source]
          if (values === undefined && source === 'ignoredBuilds') continue
          if (!Array.isArray(values) || values.length > 64) throw new Error('pnpm build metadata entries exceed their bound')
          for (const value of values) {
            if (typeof value !== 'string' || value.length > 2_048) throw new Error('pnpm build locator exceeds its bound')
            const match = LOCATOR.exec(value)
            if (!match || match[1]!.length > 214 || `${match[1]}@${match[2]}`.length > 344) throw new Error('unsupported or oversized pnpm build locator')
            const spec = `${match[1]}@${match[2]}`
            const item = pending.get(spec) ?? { name: match[1]!, locators: new Set<string>(), sources: new Set<'pendingBuilds' | 'ignoredBuilds'>() }
            item.locators.add(value); item.sources.add(source); pending.set(spec, item)
            if (!graph.nodes.some(node => node.name === match[1] && node.version === match[2])) gap(`reported build coordinate is absent from the host lock graph: ${spec}`)
          }
        }
        const wanted = new Set(['@deepseek-ai/dsh', ...[...pending.values()].map(item => item.name)])
        const hostManifests: string[] = []
        const store = await directoryAt(modulesDirectory, '.pnpm')
        const inspect = async (directory: FileHandle, location: string, name: string): Promise<void> => {
          if (!wanted.has(name)) return
          parts(location)
          const bytes = await read(directory, 'package.json', 1024 * 1024)
          const value = object(bytes, 'physical package manifest')
          if (value.name !== name || typeof value.version !== 'string' || !VERSION.test(value.version)) throw new Error('physical package coordinates do not match the host inventory')
          if (name === '@deepseek-ai/dsh' && value.version === dshVersion) hostManifests.push(digest(bytes))
          const spec = `${name}@${value.version}`
          const metadata = pending.get(spec)
          if (!metadata) return
          if (result.packages.length >= 128) throw new Error('physical host build packages exceed their bound')
          const lifecycleScripts: DshHostBuildPackage['lifecycleScripts'] = {}
          if (value.scripts !== undefined) {
            if (!value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) throw new Error('host package scripts metadata must be an object')
            for (const name of ['preinstall', 'install', 'postinstall'] as const) {
              const command = (value.scripts as Record<string, unknown>)[name]
              if (command === undefined) continue
              if (typeof command !== 'string' || command.length > 4_096) throw new Error('host lifecycle script exceeds its evidence bound')
              lifecycleScripts[name] = command
            }
          }
          result.packages.push({ spec, location, manifestSha256: digest(bytes), lifecycleScripts,
            reportedLocators: [...metadata.locators].sort(), metadataSources: [...metadata.sources].sort() })
        }
        try {
          for (const storeKey of await directories(store, 12_000)) {
            // pnpm places public hoisted aliases here, alongside physical
            // package snapshots. It is not another package snapshot.
            if (storeKey === 'node_modules') continue
            const packageModules = await directoryAt(store, `${storeKey}/node_modules`)
            try {
              for (const name of await directories(packageModules, 512)) {
                if (!name.startsWith('@') && !wanted.has(name)) continue
                const directory = await directoryAt(packageModules, name)
                try {
                  const base = `${candidate.location}/node_modules/.pnpm/${storeKey}/node_modules/${name}`
                  if (!name.startsWith('@')) await inspect(directory, base, name)
                  else for (const leaf of await directories(directory, 512)) {
                    if (!wanted.has(`${name}/${leaf}`)) continue
                    const child = await directoryAt(directory, leaf)
                    try { await inspect(child, `${base}/${leaf}`, `${name}/${leaf}`) }
                    finally { await child.close() }
                  }
                } finally { await directory.close() }
              }
            } finally { await packageModules.close() }
          }
        } finally { await store.close() }
        if (hostManifests.length !== 1) throw new Error('the exact physical DSH host manifest is absent or ambiguous')
        for (const spec of pending.keys()) if (!result.packages.some(item => item.spec === spec)) gap(`physical manifest unavailable for reported host build: ${spec}`)
        result.installation = { location: candidate.location, manifestSha256: digest(manifest), hostManifestSha256: hostManifests[0]!,
          lockfileSha256: digest(lockfile), lockGraphDigest: graph.digest }
      } finally { await modulesDirectory.close() }
    } finally { await installation.close() }
  } catch (error) { gap(error instanceof Error ? error.message : String(error)) }
  finally { await dlx?.close(); await cache?.close(); await slash?.close() }
  result.packages.sort((a, b) => a.spec.localeCompare(b.spec) || a.location.localeCompare(b.location))
  return result
}
