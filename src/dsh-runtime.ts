import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const MAX_MANIFEST_BYTES = 1 * 1024 * 1024
const MAX_ANCESTORS = 64
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

function packageManifest(path: string): { name: string; version: string } | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return typeof record.name === 'string' && record.name === DSH_PACKAGE_NAME
      && typeof record.version === 'string' && record.version.length > 0
      ? { name: record.name, version: record.version }
      : undefined
  } catch {
    return undefined
  }
}

function packageRoot(entrypoint: string): string | undefined {
  let cursor: string
  try {
    cursor = resolve(realpathSync(entrypoint))
  } catch {
    return undefined
  }
  try {
    if (statSync(cursor).isFile()) cursor = dirname(cursor)
  } catch {
    return undefined
  }

  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const manifest = packageManifest(join(cursor, 'package.json'))
    if (manifest !== undefined) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return undefined
}

function usableNodeModulesDirectory(path: string): string | undefined {
  try {
    const resolved = realpathSync(path)
    if (!statSync(resolved).isDirectory()) return undefined
    const entries = readdirSync(resolved, { withFileTypes: true })
    return entries.some(entry => entry.name !== '.bin') ? resolved : undefined
  } catch {
    return undefined
  }
}

function runtimeNodeModulesDirectory(root: string): string | undefined {
  const packageLocal = usableNodeModulesDirectory(join(root, 'node_modules'))
  if (packageLocal !== undefined) return packageLocal

  let cursor = root
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (basename(cursor) === 'node_modules') {
      const parentPlane = usableNodeModulesDirectory(cursor)
      if (parentPlane !== undefined) return parentPlane
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return undefined
}

/**
 * Find the DSH CLI's own dependency plane without importing or executing it.
 * The entrypoint is normally process.argv[1] inside a running DSH process.
 */
export function discoverDshRuntimeNodeModulesDirectory(
  entrypoint = process.argv[1],
): string | undefined {
  if (typeof entrypoint !== 'string' || entrypoint.trim() === '') return undefined
  const root = packageRoot(entrypoint)
  if (root === undefined) return undefined
  return runtimeNodeModulesDirectory(root)
}
