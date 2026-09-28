import { createHash } from 'node:crypto'
import { parseNpmSpec } from './npm.js'
import { parseDshProfileEnvironment, type DshProfileEnvironment } from './dsh-profile-environment.js'
import { parseDshStartupConfiguration, type DshStartupConfiguration } from './dsh-startup-configuration.js'
import { parseDshHostBuildInventory, parseDshHostNativeLoadFailures, type DshHostBuildInventory, type DshHostNativeLoadFailure } from './dsh-host-builds.js'

export interface DshHostBuildContext {
  caseId: string
  plugin: string
  artifactSha256: string
  sourceFingerprint: string
  dshVersion: string
  plane: 'web' | 'tui'
  profile: string
  runtime: { nodeMajor: number; nodeVersion: string; platform: string; architecture: string; pnpmVersion?: string }
  profileEnvironment?: DshProfileEnvironment
  startupConfiguration?: DshStartupConfiguration
}

/** A permission for one observation context, never a compatibility conclusion. */
export interface DshHostBuildApproval {
  revision: 'dsh-host-build-approval/1'
  scope: 'dsh-host-dependency-builds'
  contextFingerprint: string
  inventoryFingerprint: string
  packages: string[]
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const bounded = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new Error('host build permission string exceeds its bound')
  return value
}
function exactVersion(value: unknown): string {
  const version = bounded(value, 128)
  if (!EXACT_VERSION.test(version)) throw new Error('host build permission requires an exact version')
  return version
}
function exactSpec(value: unknown): string {
  const spec = bounded(value, 344)
  const parsed = parseNpmSpec(spec)
  exactVersion(parsed.version)
  if (spec !== `${parsed.name}@${parsed.version}`) throw new Error('host build permission requires an exact package coordinate')
  return spec
}
function packages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) throw new Error('host build permission requires 1–16 exact packages')
  const result = value.map(exactSpec)
  if (new Set(result).size !== result.length) throw new Error('duplicate host build permission package')
  return result.sort()
}

export function parseDshHostBuildApproval(input: unknown): DshHostBuildApproval {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('host build permission must be an object')
  const value = input as Record<string, unknown>
  if (value.revision !== 'dsh-host-build-approval/1' || value.scope !== 'dsh-host-dependency-builds') throw new Error('unsupported host build permission revision or scope')
  const fingerprint = (value: unknown): string => {
    const result = bounded(value, 71)
    if (!FINGERPRINT.test(result)) throw new Error('host build permission requires SHA-256 fingerprints')
    return result
  }
  return { revision: value.revision, scope: value.scope, contextFingerprint: fingerprint(value.contextFingerprint),
    inventoryFingerprint: fingerprint(value.inventoryFingerprint), packages: packages(value.packages) }
}

function contextFingerprint(context: DshHostBuildContext, inventory: DshHostBuildInventory): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bounded(context.caseId, 64))) throw new Error('host build context case id is invalid')
  if (!/^[a-f0-9]{64}$/.test(bounded(context.artifactSha256, 64)) || !FINGERPRINT.test(bounded(context.sourceFingerprint, 71))) throw new Error('host build context requires exact artifact and source identity')
  if (!['web', 'tui'].includes(context.plane) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(bounded(context.profile, 64))
    || (context.plane === 'web') !== (context.profile === 'web')) throw new Error('host build context profile is invalid')
  const runtime = context.runtime
  if (!runtime || runtime.platform !== 'linux' || !['x64', 'arm64'].includes(runtime.architecture)) throw new Error('host build context requires a supported isolated runtime')
  const nodeVersion = exactVersion(runtime.nodeVersion)
  if (!Number.isSafeInteger(runtime.nodeMajor) || Number(nodeVersion.split('.')[0]) !== runtime.nodeMajor || runtime.nodeMajor < 16 || runtime.nodeMajor > 40) throw new Error('host build context Node identity is inconsistent')
  const pnpmVersion = exactVersion(runtime.pnpmVersion)
  const dshVersion = exactVersion(context.dshVersion)
  const profileEnvironment = parseDshProfileEnvironment(context.profileEnvironment)
  if (inventory.dshVersion !== dshVersion || inventory.pnpmVersion !== pnpmVersion || profileEnvironment.pnpmVersion !== pnpmVersion) throw new Error('host build context does not match its DSH/pnpm inventory')
  return digest({ revision: 'dsh-host-build-context/1', caseId: context.caseId, plugin: exactSpec(context.plugin),
    artifactSha256: context.artifactSha256, sourceFingerprint: context.sourceFingerprint, dshVersion, plane: context.plane, profile: context.profile,
    runtime: { nodeMajor: runtime.nodeMajor, nodeVersion, platform: runtime.platform, architecture: runtime.architecture, pnpmVersion },
    profileEnvironment, startupConfiguration: parseDshStartupConfiguration(context.startupConfiguration) })
}

function inventoryFingerprint(inventory: DshHostBuildInventory, selected: string[]): string {
  if (inventory.coverageGaps.length || !inventory.installation) throw new Error('host build permission requires complete inventory coverage')
  for (const spec of selected) if (!inventory.packages.some(item => item.spec === spec)) throw new Error('host build permission package is absent from its inventory')
  const { location, ...installation } = inventory.installation
  // pnpm's volatile DLX instance directory is not package identity. Preserve
  // every selected physical snapshot within it, including peer variants.
  const physical = inventory.packages.filter(item => selected.includes(item.spec)).map(item => ({
    spec: item.spec, location: item.location.slice(location.length + 1), manifestSha256: item.manifestSha256,
    reportedLocators: [...item.reportedLocators].sort(),
  })).sort((a, b) => a.location < b.location ? -1 : a.location > b.location ? 1 : 0)
  return digest({ revision: inventory.revision, dshVersion: inventory.dshVersion, pnpmVersion: inventory.pnpmVersion, installation, packages: physical })
}

/** Turn an explicit reviewed subset into a scope-bound permission. Pending
 * metadata by itself is insufficient; the selected package needs a failure.
 */
export function createDshHostBuildApproval(input: {
  inventory: DshHostBuildInventory; failures: readonly DshHostNativeLoadFailure[]; context: DshHostBuildContext; packages: readonly string[]
  previousApproval?: DshHostBuildApproval
}): DshHostBuildApproval {
  const inventory = parseDshHostBuildInventory(input.inventory)
  const selected = packages(input.packages)
  const failures = parseDshHostNativeLoadFailures(input.failures, inventory)
  const previous = input.previousApproval === undefined ? undefined : assertDshHostBuildApproval(input.previousApproval, inventory, input.context)
  if (previous?.packages.some(spec => !selected.includes(spec))) throw new Error('a staged host permission must retain its previously approved packages')
  if (selected.some(spec => !failures.some(failure => failure.packageSpec === spec) && !previous?.packages.includes(spec))) throw new Error('host build permission is absent from the observed native-load failures')
  return { revision: 'dsh-host-build-approval/1', scope: 'dsh-host-dependency-builds', packages: selected,
    contextFingerprint: contextFingerprint(input.context, inventory), inventoryFingerprint: inventoryFingerprint(inventory, selected) }
}

/** Recollect before execution; reject stale permissions without running code. */
export function assertDshHostBuildApproval(input: unknown, facts: DshHostBuildInventory, context: DshHostBuildContext): DshHostBuildApproval {
  const approval = parseDshHostBuildApproval(input)
  const inventory = parseDshHostBuildInventory(facts)
  if (approval.contextFingerprint !== contextFingerprint(context, inventory)) throw new Error('host build permission context changed')
  if (approval.inventoryFingerprint !== inventoryFingerprint(inventory, approval.packages)) throw new Error('host build permission inventory changed')
  return approval
}
