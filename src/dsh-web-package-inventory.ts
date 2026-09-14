import { constants } from 'node:fs'
import { open, opendir, readlink, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { parseDshClientContract } from './dsh-peer-planes.js'
import { DSH_WEB_PROVENANCE_LIMITS as limits, type DshWebPackageInventory } from './dsh-web-package-provenance.js'

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const fdPath = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`
function safePath(path: string): string[] {
  if (Buffer.byteLength(path) > 2048 || /[\\\u0000-\u001f\u007f]/.test(path)) throw new Error('inventory path exceeds its bound')
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error('inventory path must stay inside its root')
  return parts
}

/** Open every component relative to a pinned directory, never through a target-controlled link. */
async function directoryAt(parent: FileHandle, path: string): Promise<FileHandle> {
  let current: FileHandle | undefined
  try {
    for (const part of safePath(path)) {
      const next = await open(fdPath(current ?? parent, part), DIRECTORY)
      await current?.close()
      current = next
    }
    return current!
  } catch (error) { await current?.close(); throw error }
}

/** Collect physical package candidates, not Node resolver answers. Linux openat-style
 * directory descriptors also protect ancestor components against link replacement.
 * This runs inside the disposable observer, never imports inspected package code.
 */
export async function collectDshWebPackageInventory(sandbox: string, roots: string[], wantedIds: string[]): Promise<DshWebPackageInventory> {
  const result: DshWebPackageInventory = { artifacts: [], gaps: [] }
  const gap = (message: string): void => {
    const bounded = message.slice(0, 120) // <= 480 UTF-8 bytes even for four-byte characters
    if (result.gaps.includes(bounded)) return
    if (result.gaps.length < limits.gaps) result.gaps.push(bounded)
    else result.gaps[limits.gaps - 1] = 'additional inventory gaps omitted after the diagnostic bound'
  }
  if (process.platform !== 'linux') { gap('safe client inventory requires Linux directory-descriptor APIs'); return result }
  if (!sandbox.startsWith('/') || roots.length === 0 || roots.length > 4 || wantedIds.length > 512) throw new Error('inventory scope exceeds its bound')
  safePath(sandbox.slice(1)); roots.forEach(safePath)
  const wanted = new Set(wantedIds)
  const visited = new Set<string>()
  const links: Array<{ location: string; destination: string }> = []
  let entries = 0
  let manifestBytes = 0
  let clientBytes = 0
  const deadline = Date.now() + 30_000
  const check = (): void => {
    if (Date.now() > deadline || entries > 100_000 || visited.size > 20_000) throw new Error('inventory traversal budget exceeded')
  }
  const read = async (directory: FileHandle, name: string, kind: 'manifest' | 'client'): Promise<Buffer> => {
    check()
    const file = await open(fdPath(directory, name), FILE)
    try {
      const before = await file.stat()
      const maximum = kind === 'manifest' ? limits.manifestBytes : limits.clientBytes
      if (!before.isFile() || before.size > maximum) throw new Error(`${kind} is not a bounded regular file`)
      if (kind === 'manifest') manifestBytes += before.size
      else clientBytes += before.size
      if (manifestBytes > limits.totalManifestBytes || clientBytes > limits.totalClientBytes) throw new Error('inventory byte budget exceeded')
      const buffer = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < buffer.length) {
        check()
        const next = await file.read(buffer, length, buffer.length - length, length)
        if (next.bytesRead === 0) break
        length += next.bytesRead
      }
      const after = await file.stat()
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${kind} changed during collection`)
      return buffer.subarray(0, length)
    } finally { await file.close() }
  }
  const walk = async (directory: FileHandle, location: string, depth: number): Promise<void> => {
    check()
    if (depth > 32 || Buffer.byteLength(location) > 2048) throw new Error('inventory directory depth or path budget exceeded')
    visited.add(location)
    let manifest: Buffer | undefined
    try { manifest = await read(directory, 'package.json', 'manifest') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gap(`package manifest unavailable at ${location}`) }
    if (manifest !== undefined) {
      try {
        const value = JSON.parse(manifest.toString('utf8')) as Record<string, unknown>
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('package manifest must be an object')
        if (typeof value.name === 'string' && wanted.has(value.name)) {
          const contract = parseDshClientContract(value)
          if (contract?.platform === 'web') {
            for (const clientPath of contract.entryPoints) {
              const parts = safePath(clientPath)
              const name = parts.pop()!
              let child: FileHandle | undefined
              try {
                if (parts.length) child = await directoryAt(directory, parts.join('/'))
                const client = await read(child ?? directory, name, 'client')
                if (result.artifacts.length >= limits.artifacts) throw new Error('inventory artifact count budget exceeded')
                result.artifacts.push({ location, manifest, clientPath, client })
              } finally { await child?.close() }
            }
          }
        }
      } catch { gap(`client metadata or bytes unavailable at ${location}`) }
    }
    const children = await opendir(fdPath(directory, '.'))
    for await (const child of children) {
      entries += 1
      check()
      // A package's executable assets, examples and scripts are not package-discovery roots.
      if (child.name === '.bin' || (manifest !== undefined && child.name !== 'node_modules')) continue
      const childLocation = `${location}/${child.name}`
      if (child.isSymbolicLink()) {
        try {
          const target = await readlink(fdPath(directory, child.name))
          const destination = target.startsWith('/') ? posix.relative(sandbox, target) : posix.normalize(posix.join(location, target))
          links.push({ location: childLocation, destination })
        } catch { gap(`package alias unavailable at ${childLocation}`) }
      } else if (child.isDirectory()) {
        let next: FileHandle | undefined
        try {
          next = await directoryAt(directory, child.name)
          await walk(next, childLocation, depth + 1)
        } catch { gap(`package directory unavailable or bounded at ${childLocation}`) }
        finally { await next?.close() }
      }
    }
  }
  let anchor: FileHandle | undefined
  const slash = await open('/', DIRECTORY)
  try {
    anchor = await directoryAt(slash, sandbox.slice(1))
    for (const root of roots) {
      let directory: FileHandle | undefined
      try { directory = await directoryAt(anchor, root); await walk(directory, root, 0) }
      catch { gap(`package inventory root unavailable or bounded: ${root}`) }
      finally { await directory?.close() }
    }
    // Aliases are not followed. They are covered only if their physical destination
    // was independently visited; external targets and alias chains remain gaps.
    for (const link of links) if (!visited.has(link.destination)) gap(`uninspected package alias at ${link.location}`)
  } catch { gap('the sandbox directory could not be pinned without following links') }
  finally { await anchor?.close(); await slash.close() }
  return result
}
