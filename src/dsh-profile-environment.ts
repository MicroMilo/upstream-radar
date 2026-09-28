import type { DshAuthorEnvironment } from './dsh-author-environment.js'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseNpmSpec } from './npm.js'
import { satisfiesSemverRange } from './semver.js'

/** The data-only configuration an isolated profile runner must establish. */
export interface DshProfileEnvironment {
  pnpmVersion: string
  overrides: Record<string, string>
}

export function parseDshProfileEnvironment(value: unknown = { pnpmVersion: '11.7.0', overrides: {} }): DshProfileEnvironment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('profile environment must be an object')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => key !== 'pnpmVersion' && key !== 'overrides')) throw new Error('profile environment contains unexpected keys')
  if (typeof item.pnpmVersion !== 'string') throw new Error('profile environment requires an exact pnpmVersion')
  const pnpmVersion = parseNpmSpec(`pnpm@${item.pnpmVersion}`).version
  if (typeof item.overrides !== 'object' || item.overrides === null || Array.isArray(item.overrides)) throw new Error('profile overrides must be an object')
  const entries = Object.entries(item.overrides)
  if (entries.length > 64) throw new Error('profile overrides exceed 64 entries')
  const overrides = Object.fromEntries(entries.map(([name, range]) => {
    if (parseNpmSpec(`${name}@1.0.0`).name !== name) throw new Error('profile override requires an npm package name')
    if (typeof range !== 'string' || range.length > 512 || satisfiesSemverRange('0.0.0', range) === undefined) throw new Error('profile override requires a bounded registry version range')
    return [name, range]
  }).sort(([left], [right]) => left!.localeCompare(right!)))
  return { pnpmVersion, overrides }
}

/** Development settings do not configure an installed user profile. */
export function selectDshProfileEnvironment(author?: DshAuthorEnvironment, profile = 'headless', nodeMajor?: number): DshProfileEnvironment {
  if (nodeMajor !== undefined && (!Number.isSafeInteger(nodeMajor) || nodeMajor < 20 || nodeMajor > 40)) {
    throw new Error('profile environment requires a supported isolated Node major')
  }
  const applies = (item: { profile?: string }) => item.profile === undefined || item.profile === profile
  const managers = author?.packageManagers.filter(item => item.scope !== 'development' && applies(item)) ?? []
  if (managers.some(item => item.name !== 'pnpm')) throw new Error(`${managers.find(item => item.name !== 'pnpm')!.name} profile package manager is unsupported by the DSH pnpm runner`)
  const versions = [...new Set(managers.map(item => item.version))]
  if (versions.length > 1) throw new Error('conflicting author profile package-manager versions require review')
  const overrides: Record<string, string> = {}
  for (const group of author?.overrides.filter(item => item.scope === 'profile' && applies(item)) ?? []) {
    for (const [name, version] of Object.entries(group.values)) {
      if (Object.hasOwn(overrides, name) && overrides[name] !== version) throw new Error(`conflicting profile override for ${name} requires review`)
      Object.defineProperty(overrides, name, { value: version, enumerable: true, configurable: true })
    }
  }
  const pnpmVersion = versions[0] ?? (nodeMajor !== undefined && nodeMajor < 22 ? '10.33.0' : '11.7.0')
  if (nodeMajor !== undefined && nodeMajor < 22 && Number(pnpmVersion.split('.')[0]) > 10) {
    throw new Error(`Node ${nodeMajor} cannot run the exact profile pnpm ${pnpmVersion}; review a compatible author requirement`)
  }
  return parseDshProfileEnvironment({ pnpmVersion, overrides })
}

/** Called inside the isolated executor, before the first target install. */
export async function prepareDshProfileOverrides(dshHome: string, profile: string, environment: DshProfileEnvironment): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || profile === 'node_modules') throw new Error('unsafe profile configuration name')
  if (Object.keys(environment.overrides).length === 0) return
  let current = dshHome
  for (const part of ['', 'profiles', profile]) {
    current = join(current, part)
    if (part !== '') {
      try { await mkdir(current, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('profile configuration path is not a regular directory')
  }
  // JSON is a YAML subset. Never replace a pre-existing configuration or link.
  await writeFile(join(current, 'pnpm-workspace.yaml'), `${JSON.stringify({ overrides: environment.overrides }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

export function verifyDshProfileOverrides(environment: DshProfileEnvironment, stdout: string): DshProfileEnvironment {
  if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error('profile overrides output exceeds its byte budget')
  const actual = parseDshProfileEnvironment({ pnpmVersion: environment.pnpmVersion, overrides: JSON.parse(stdout) })
  if (JSON.stringify(actual) !== JSON.stringify(environment)) throw new Error('effective pnpm profile overrides do not match the execution plan')
  return actual
}
