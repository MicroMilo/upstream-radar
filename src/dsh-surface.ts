import { createHash } from 'node:crypto'
import { parseDshStartupConfiguration, type DshStartupConfiguration } from './dsh-startup-configuration.js'

import { parseDshProfileEnvironment, type DshProfileEnvironment } from './dsh-profile-environment.js'
import { parseDshCompatibilityLedger, parseDshProfileResolutionEvidence, type DshCompatibilityLedgerEntry } from './dsh-compatibility-ledger.js'
import { parseDshHeadlessAgentPlans, type DshHeadlessAgentPlans } from './dsh-headless-agent-plan.js'
import { parseDshSurfaceAgentPlans, type DshSurfaceAgentPlans } from './dsh-surface-agent-plan.js'
import { extractPnpmRequiredDependencyBuilds } from './dsh-install-observation.js'
import {
  DSH_SURFACE_OBSERVATION_SCHEMA,
  DSH_SURFACE_EXECUTION_CONTRACT,
  type DshExecutionPlane,
  type DshSurfaceObservationReport,
  type DshSurfaceObservationResult,
  type DshSurfaceStage,
  type DshTuiSurfaceEvidence,
  type DshWebSurfaceEvidence,
} from './dsh-surface-observation.js'
import { parseNpmSpec } from './npm.js'
import { isExclusiveDshWebPeer } from './dsh-peer-planes.js'
import { parseDshWebContractEvidence } from './dsh-web-contract.js'
import type { DshInstallPlan } from './dsh-install-plan.js'
import { parseDshHostBuildInventory, parseDshHostNativeLoadFailures, type DshHostBuildInventory, type DshHostNativeLoadFailure } from './dsh-host-builds.js'
import { assertDshHostBuildApproval, parseDshHostBuildApproval, type DshHostBuildApproval } from './dsh-host-build-policy.js'
import { parseDshHostBuildExecution, type DshHostBuildExecution } from './dsh-host-build-execution.js'

function startupFields(value: unknown): { startupConfiguration?: DshStartupConfiguration } {
  const startupConfiguration = parseDshStartupConfiguration(value)
  return startupConfiguration === undefined ? {} : { startupConfiguration }
}

function hostBuildFields(value: unknown, dshVersion: unknown, runtime: unknown, result: unknown, failures: unknown, hostStage: DshSurfaceStage): {
  hostBuildInventory?: DshHostBuildInventory; hostBuildFailures?: DshHostNativeLoadFailure[]
} {
  if (value === undefined) {
    if (failures !== undefined) throw new Error('host native-load failures require independent host build inventory')
    return {}
  }
  const hostBuildInventory = parseDshHostBuildInventory(value)
  if (hostBuildInventory.dshVersion !== dshVersion) throw new Error('host build inventory DSH version does not match the surface')
  if (hostBuildInventory.pnpmVersion !== undefined && hostBuildInventory.pnpmVersion !== record(runtime, 'surface runtime').pnpmVersion) {
    throw new Error('host build inventory pnpm version does not match the surface')
  }
  if (result === 'compatible' && hostBuildInventory.coverageGaps.length) throw new Error('a compatible surface cannot have incomplete host build inventory coverage')
  const hostBuildFailures = failures === undefined ? undefined : parseDshHostNativeLoadFailures(failures, hostBuildInventory)
  if (hostBuildFailures?.length && (result !== 'environment-unsupported' || hostStage.status !== 'failed')) {
    throw new Error('host native-load failures require an environment-unsupported result and a failed host stage')
  }
  return { hostBuildInventory, ...(hostBuildFailures === undefined ? {} : { hostBuildFailures }) }
}

function hostExecutionFields(root: Record<string, unknown>, requested: unknown, inventory: DshHostBuildInventory | undefined,
  stages: DshSurfaceObservationReport['stages'], result: DshSurfaceObservationResult): {
    requestedHostBuildApproval?: DshHostBuildApproval; hostBuildExecution?: DshHostBuildExecution
  } {
  const permission = requested === undefined ? undefined : parseDshHostBuildApproval(requested)
  if (root.hostBuildExecution === undefined) {
    if (permission !== undefined && stages.registration.status === 'passed') throw new Error('the requested host build permission has no execution attempt')
    return permission === undefined ? {} : { requestedHostBuildApproval: permission }
  }
  if (!permission || !inventory) throw new Error('a host rebuild requires its requested permission and independent inventory')
  const artifact = record(root.artifact, 'surface artifact')
  const hostBuildExecution = parseDshHostBuildExecution(root.hostBuildExecution, { inventory,
    context: { caseId: caseId(root.caseId, 'surface case id'), plugin: exactSpec(root.plugin, 'surface plugin'),
      artifactSha256: bareSha256(artifact.sha256, 'surface artifact'), sourceFingerprint: fingerprint(root.sourceFingerprint, 'surface source'),
      dshVersion: exactVersion(root.dshVersion, 'surface DSH'), plane: executionPlane(root.plane, 'surface plane'),
      profile: profileName(root.profile, 'surface profile'), runtime: parseRuntime(root.runtime, 'surface runtime'),
      profileEnvironment: parseDshProfileEnvironment(root.profileEnvironment), ...startupFields(root.startupConfiguration) } })
  if (JSON.stringify(permission) !== JSON.stringify(hostBuildExecution.requestedApproval)) throw new Error('host rebuild differs from its requested permission')
  if (hostBuildExecution.status === 'failed' && result === 'compatible') throw new Error('a failed host rebuild cannot establish a compatible surface')
  return { requestedHostBuildApproval: permission, hostBuildExecution }
}

export const DSH_SURFACE_TARGETS_SCHEMA = 'upstream-radar.dsh-surface-targets/v1alpha1' as const
export const DSH_SURFACE_LEDGER_SCHEMA = 'upstream-radar.dsh-surface-ledger/v1alpha1' as const
export const DSH_SURFACE_IR_SCHEMA = 'upstream-radar.dsh-surface-ir/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const BARE_SHA256 = /^[a-f0-9]{64}$/
const RESULTS = new Set<DshSurfaceObservationResult>(['compatible', 'surface-incompatible', 'environment-unsupported', 'unknown'])
const STAGE_STATUS = new Set(['passed', 'failed', 'skipped'])
const DEFAULT_REFRESH_AFTER_HOURS = 7 * 24
const MAX_CONFIGURED_TARGETS = 400
const MAX_RUN_TARGETS = 32
const MAX_LEDGER_ENTRIES = 512
const SURFACE_CONTRACT_REVISION = 'dsh-surface-contract/14'

export interface DshSurfaceTarget {
  startupConfiguration?: DshStartupConfiguration
  profileEnvironment?: DshProfileEnvironment
  environmentGap?: string
  id: string
  sourceCaseId: string
  plane: DshExecutionPlane
  profile: string
  runtimeId: string
  reason: string
}

export interface DshSurfaceTargets {
  schema: typeof DSH_SURFACE_TARGETS_SCHEMA
  refreshAfterHours: number
  autoDiscover?: {
    webClientGaps: boolean
  }
  surfaces: DshSurfaceTarget[]
}

export interface DshSurfaceExpectedCase {
  hostBuildApproval?: DshHostBuildApproval
  startupConfiguration?: DshStartupConfiguration
  profileEnvironment?: DshProfileEnvironment
  id: string
  sourceCaseId: string
  plugin: string
  dshVersion: string
  nodeMajor: number
  platform?: 'linux'
  architecture?: 'x64' | 'arm64'
  plane: DshExecutionPlane
  profile: string
  runtimeId: string
  artifactSha256: string
  allowedBuilds: string
  sourceFingerprint: string
  contractFingerprint: string
  reasons: string[]
}

export interface DshSurfacePlan {
  run: boolean
  matrix: { include: DshSurfaceExpectedCase[] }
  blocked: Array<{ id: string; reason: string }>
  reason: string
}

export interface DshSurfaceLedgerEntry {
  requestedHostBuildApproval?: DshHostBuildApproval
  hostBuildExecution?: DshHostBuildExecution
  hostBuildInventory?: DshHostBuildInventory
  hostBuildFailures?: DshHostNativeLoadFailure[]
  startupConfiguration?: DshStartupConfiguration
  profileEnvironment?: DshProfileEnvironment
  caseId: string
  sourceCaseId: string
  plugin: string
  dshVersion: string
  plane: DshExecutionPlane
  profile: string
  runtimeId: string
  approvedDependencyBuilds?: string[]
  requiredDependencyBuilds?: string[]
  sourceFingerprint: string
  contractFingerprint: string
  observedAt: string
  runtime: DshSurfaceObservationReport['runtime']
  artifact: { sha256: string; bytes?: number; integrity?: string }
  stages: DshSurfaceObservationReport['stages']
  evidence: DshWebSurfaceEvidence | DshTuiSurfaceEvidence
  resolution?: DshSurfaceObservationReport['resolution']
  result: DshSurfaceObservationResult
  reason: string
  observer: { schema: typeof DSH_SURFACE_OBSERVATION_SCHEMA; version: string }
}

export interface DshSurfaceLedger {
  schema: typeof DSH_SURFACE_LEDGER_SCHEMA
  entries: DshSurfaceLedgerEntry[]
}

export interface DshSurfaceTransition {
  caseId: string
  status: 'compatible' | 'new-incompatibility' | 'changed-incompatibility' | 'resolved-incompatibility' | 'persisting-incompatibility' | 'new-infrastructure-gap' | 'persisting-infrastructure-gap'
  result: DshSurfaceObservationResult
  reason: string
  previousResult?: DshSurfaceObservationResult
}

export interface DshSurfaceLedgerMerge {
  ledger: DshSurfaceLedger
  transitions: DshSurfaceTransition[]
  acceptedCaseIds: string[]
  missingCaseIds: string[]
  rejectedReports: string[]
}

export interface DshSurfaceIR {
  schema: typeof DSH_SURFACE_IR_SCHEMA
  generatedAt: string
  cells: Array<{
    startupConfiguration?: DshStartupConfiguration
    id: string
    sourceCaseId: string
    plane: DshExecutionPlane
    profile: string
    runtimeId: string
    plugin: { spec: string; artifactSha256: string }
    upstream: { package: '@deepseek-ai/dsh'; dshVersion: string }
    runtime: DshSurfaceObservationReport['runtime']
    observation: {
      requestedHostBuildApproval?: DshHostBuildApproval
      hostBuildExecution?: DshHostBuildExecution
      hostBuildInventory?: DshHostBuildInventory
      hostBuildFailures?: DshHostNativeLoadFailure[]
      observedAt: string
      result: DshSurfaceObservationResult
      reason: string
      requiredDependencyBuilds?: string[]
      stages: DshSurfaceObservationReport['stages']
      evidence: DshWebSurfaceEvidence | DshTuiSurfaceEvidence
    }
  }>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

function caseId(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!CASE_ID.test(parsed)) throw new Error(`${label} must be a short lowercase label`)
  return parsed
}

function profileName(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!PROFILE_NAME.test(parsed)) throw new Error(`${label} must be a short safe DSH profile name`)
  return parsed
}

function fingerprint(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 71)
  if (!FINGERPRINT.test(parsed)) throw new Error(`${label} must be a sha256 fingerprint`)
  return parsed
}

function bareSha256(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!BARE_SHA256.test(parsed)) throw new Error(`${label} must be a SHA-256 hex digest`)
  return parsed
}

function exactSpec(value: unknown, label: string): string {
  const parsed = parseNpmSpec(boundedString(value, label, 512))
  if (!EXACT_VERSION.test(parsed.version)) throw new Error(`${label} must be an exact npm package coordinate`)
  return `${parsed.name}@${parsed.version}`
}

function exactVersion(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 256)
  if (!EXACT_VERSION.test(parsed)) throw new Error(`${label} must be an exact semantic version`)
  return parsed
}

function executionPlane(value: unknown, label: string): DshExecutionPlane {
  if (value !== 'web' && value !== 'tui') throw new Error(`${label} must be web or tui`)
  return value
}

function nodeMajor(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 16 || (value as number) > 40) {
    throw new Error(`${label} must be a supported Node.js major version`)
  }
  return value as number
}

function isoDate(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${label} must be an ISO timestamp`)
  }
  return parsed
}

export function parseDshSurfaceTargets(input: unknown): DshSurfaceTargets {
  const root = record(input, 'DSH surface targets')
  if (root.schema !== DSH_SURFACE_TARGETS_SCHEMA) throw new Error(`DSH surface targets schema must be ${DSH_SURFACE_TARGETS_SCHEMA}`)
  const refreshAfterHours = root.refreshAfterHours === undefined ? DEFAULT_REFRESH_AFTER_HOURS : Number(root.refreshAfterHours)
  if (!Number.isSafeInteger(refreshAfterHours) || refreshAfterHours < 1 || refreshAfterHours > 90 * 24) {
    throw new Error('DSH surface target refreshAfterHours must be an integer between 1 and 2160')
  }
  if (!Array.isArray(root.surfaces) || root.surfaces.length > MAX_CONFIGURED_TARGETS) {
    throw new Error(`DSH surface targets must contain at most ${MAX_CONFIGURED_TARGETS} surfaces`)
  }
  const autoDiscoverRecord = root.autoDiscover === undefined
    ? undefined
    : record(root.autoDiscover, 'DSH surface targets autoDiscover')
  if (autoDiscoverRecord !== undefined && typeof autoDiscoverRecord.webClientGaps !== 'boolean') {
    throw new Error('DSH surface targets autoDiscover.webClientGaps must be boolean')
  }
  const autoDiscover = autoDiscoverRecord === undefined
    ? undefined
    : { webClientGaps: autoDiscoverRecord.webClientGaps as boolean }
  const ids = new Set<string>()
  const pairs = new Set<string>()
  const surfaces = root.surfaces.map((value, index): DshSurfaceTarget => {
    const item = record(value, `surfaces[${index}]`)
    const id = caseId(item.id, `surfaces[${index}].id`)
    if (ids.has(id)) throw new Error(`duplicate DSH surface target id: ${id}`)
    ids.add(id)
    const sourceCaseId = caseId(item.sourceCaseId, `surfaces[${index}].sourceCaseId`)
    const plane = executionPlane(item.plane, `surfaces[${index}].plane`)
    const profile = profileName(item.profile, `surfaces[${index}].profile`)
    if (plane === 'web' && profile !== 'web') throw new Error('a Web target must use the official web profile')
    if (plane === 'tui' && profile === 'web') throw new Error('a TUI target cannot use the reserved web profile')
    const runtimeId = boundedString(item.runtimeId, `surfaces[${index}].runtimeId`, 214)
    const reason = boundedString(item.reason, `surfaces[${index}].reason`, 2_048)
    const startup = startupFields(item.startupConfiguration)
    const pair = `${sourceCaseId}\u0000${plane}\u0000${JSON.stringify(startup.startupConfiguration?.environment ?? {})}`
    if (pairs.has(pair)) throw new Error(`duplicate DSH surface plane for source case: ${sourceCaseId} ${plane}`)
    pairs.add(pair)
    return { id, sourceCaseId, plane, profile, runtimeId, reason, ...startup,
      ...(item.environmentGap === undefined ? {} : { environmentGap: boundedString(item.environmentGap, `surfaces[${index}].environmentGap`, 2_048) }),
      ...(item.profileEnvironment === undefined ? {} : { profileEnvironment: parseDshProfileEnvironment(item.profileEnvironment) }) }
  })
  surfaces.sort((left, right) => left.id.localeCompare(right.id))
  return {
    schema: DSH_SURFACE_TARGETS_SCHEMA,
    refreshAfterHours,
    ...(autoDiscover === undefined ? {} : { autoDiscover }),
    surfaces,
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function isWebClientPackage(name: string): boolean {
  return name.startsWith('@deepseek-ai/dsh-client-')
}

function dshCompatibilityGapNames(entry: DshCompatibilityLedgerEntry): string[] {
  const runtimeGraph = entry.resolution?.runtimeGraph
  return [
    ...(runtimeGraph?.unresolvedDependencies ?? []).map(item => item.name),
    ...(runtimeGraph?.pluginPeerContracts?.issues ?? []).map(item => item.name),
  ]
}

/** Route any review cell with a DSH browser-client gap into Web observation. */
export function hasDshWebClientCoverageGap(entry: DshCompatibilityLedgerEntry): boolean {
  if (entry.result !== 'peer-contract-incompatible' && entry.result !== 'unknown') return false
  return entry.artifact.client?.platform === 'web' || dshCompatibilityGapNames(entry).some(isWebClientPackage)
}

/**
 * Syntactic routing evidence only; it does not establish browser peer versions
 * and must never erase Node gaps after a successful Web boot.
 */
export function isDshWebClientOnlyCoverageGap(entry: DshCompatibilityLedgerEntry): boolean {
  if (entry.result !== 'peer-contract-incompatible' && entry.result !== 'unknown') return false
  const names = dshCompatibilityGapNames(entry)
  const graph = entry.resolution?.runtimeGraph
  if (entry.artifact.client?.platform !== 'web' || graph === undefined
    || graph.unresolved !== (graph.unresolvedDependencies?.length ?? 0)) return false
  return names.length > 0 && names.every(name => graph.pluginPeerContracts?.relations
    .some(relation => relation.name === name && isExclusiveDshWebPeer(relation)))
}

function automaticWebTargetId(sourceCaseId: string, usedIds: ReadonlySet<string>): string {
  const direct = `${sourceCaseId}-web`
  if (direct.length <= 64 && !usedIds.has(direct)) return direct
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `-${createHash('sha256').update(`${sourceCaseId}\u0000web\u0000${attempt}`).digest('hex').slice(0, 8)}`
    const candidate = `${sourceCaseId.slice(0, 64 - suffix.length)}${suffix}`
    if (!usedIds.has(candidate)) return candidate
  }
  throw new Error(`could not derive a unique automatic Web target id for ${sourceCaseId}`)
}

export function createDshSurfaceSourceFingerprint(entry: DshCompatibilityLedgerEntry): string {
  return digest({
    caseId: entry.caseId,
    plugin: entry.plugin,
    dshVersion: entry.dshVersion,
    nodeMajor: entry.runtime.nodeMajor,
    platform: entry.runtime.platform,
    architecture: entry.runtime.architecture,
    pnpmVersion: entry.runtime.pnpmVersion,
    profileEnvironment: entry.profileEnvironment,
    artifactSha256: entry.artifact.sha256,
    runtimeGraphDigest: entry.resolution?.runtimeGraph?.digest,
    staticFingerprint: entry.staticFingerprint,
    contractFingerprint: entry.contractFingerprint,
    approvedDependencyBuilds: entry.approvedDependencyBuilds ?? [],
    observerSchema: entry.observer.schema,
  })
}

function contractFingerprint(
  target: DshSurfaceTarget,
  entry: Pick<DshCompatibilityLedgerEntry, 'runtime' | 'profileEnvironment'>,
  runtimeId: string,
  approvedDependencyBuilds: readonly string[],
  hostBuildApproval?: DshHostBuildApproval,
): string {
  return digest({
    revision: SURFACE_CONTRACT_REVISION,
    plane: target.plane,
    profile: target.profile,
    runtimeId,
    nodeMajor: entry.runtime.nodeMajor,
    platform: entry.runtime.platform,
    architecture: entry.runtime.architecture,
    profileEnvironment: parseDshProfileEnvironment(target.profileEnvironment ?? entry.profileEnvironment),
    ...startupFields(target.startupConfiguration),
    graphEvidence: 'independent-profile-plus-exact-dsh-host',
    approvedDependencyBuilds,
    ...(hostBuildApproval === undefined ? {} : { hostBuildApproval: parseDshHostBuildApproval(hostBuildApproval) }),
    web: target.plane === 'web'
      ? { browser: 'chromium', root: '#root', manifest: '__DSH_BOOT__', bootHandoff: '[data-dsh-boot] removed after graph activation',
          authentication: 'generated-exact-loopback-login-url', bundleFetch: 'authenticated-browser-context',
          clientEntryRequired: 'only-if-exact-packed-manifest-declares-web-client', externalRequests: 'blocked' }
      : undefined,
    tui: target.plane === 'tui'
      ? { terminal: 'xterm-256color', columns: 100, rows: 32, frame: 'ansi-and-printable', interaction: 'ctrl-l', shutdown: 'double-ctrl-c' }
      : undefined,
  })
}

function desiredCase(
  target: DshSurfaceTarget,
  source: DshCompatibilityLedgerEntry,
  approvedDependencyBuilds: readonly string[],
  hostBuildApproval?: DshHostBuildApproval,
): DshSurfaceExpectedCase | undefined {
  // The headless result may legitimately remain unknown when the unresolved
  // edges belong to the Web or TUI host that this target is about to provide.
  // An explicit surface target needs only exact artifact provenance here; the
  // plane observer independently reinstalls the package, verifies this digest,
  // and establishes its own result.
  if (source.artifact.sha256 === undefined || !BARE_SHA256.test(source.artifact.sha256)) return undefined
  if (source.runtime.platform !== 'linux' || !['x64', 'arm64'].includes(source.runtime.architecture)) return undefined
  if (source.result === 'build-approval-required' || source.result === 'runtime-incompatible'
    || source.result === 'install-failed' || source.result === 'load-failed') return undefined
  if (source.result === 'unknown' && source.resolution?.runtimeGraph?.digest === undefined) return undefined
  // DSH's browser manifest is keyed by the client package name. The Cordis
  // patch row id is a different namespace and may remain stable while a
  // package migrates. Deriving this value from the exact observed coordinate
  // prevents a stale loader id from becoming a false incompatibility.
  const runtimeId = target.plane === 'web' ? parseNpmSpec(source.plugin).name : target.runtimeId
  return {
    id: target.id,
    sourceCaseId: source.caseId,
    plugin: source.plugin,
    dshVersion: source.dshVersion,
    nodeMajor: source.runtime.nodeMajor,
    platform: 'linux',
    architecture: source.runtime.architecture as 'x64' | 'arm64',
    plane: target.plane,
    profile: target.profile,
    runtimeId,
    artifactSha256: source.artifact.sha256,
    profileEnvironment: parseDshProfileEnvironment(target.profileEnvironment ?? source.profileEnvironment),
    ...startupFields(target.startupConfiguration),
    allowedBuilds: [...approvedDependencyBuilds].sort().join(','),
    ...(hostBuildApproval === undefined ? {} : { hostBuildApproval }),
    sourceFingerprint: createDshSurfaceSourceFingerprint(source),
    contractFingerprint: contractFingerprint(target, source, runtimeId, approvedDependencyBuilds, hostBuildApproval),
    reasons: [],
  }
}

export function emptyDshSurfaceLedger(): DshSurfaceLedger {
  return { schema: DSH_SURFACE_LEDGER_SCHEMA, entries: [] }
}

function parseStage(value: unknown, label: string): DshSurfaceStage {
  const item = record(value, label)
  if (!STAGE_STATUS.has(item.status as string)) throw new Error(`${label}.status is unsupported`)
  const status = item.status as DshSurfaceStage['status']
  const code = item.code === undefined || item.code === null
    ? item.code as null | undefined
    : Number.isSafeInteger(item.code) ? item.code as number : (() => { throw new Error(`${label}.code must be an integer or null`) })()
  const detail = item.detail === undefined ? undefined : boundedString(item.detail, `${label}.detail`, 2_048)
  return {
    status,
    ...(code === undefined ? {} : { code }),
    ...(detail === undefined ? {} : { detail }),
    ...(item.timedOut === true ? { timedOut: true } : {}),
    ...(item.outputExceeded === true ? { outputExceeded: true } : {}),
  }
}

function parseStages(value: unknown, label: string): DshSurfaceObservationReport['stages'] {
  const item = record(value, label)
  return {
    runtime: parseStage(item.runtime, `${label}.runtime`),
    artifact: parseStage(item.artifact, `${label}.artifact`),
    profile: parseStage(item.profile, `${label}.profile`),
    install: parseStage(item.install, `${label}.install`),
    registration: parseStage(item.registration, `${label}.registration`),
    host: parseStage(item.host, `${label}.host`),
    surface: parseStage(item.surface, `${label}.surface`),
    interaction: parseStage(item.interaction, `${label}.interaction`),
    shutdown: parseStage(item.shutdown, `${label}.shutdown`),
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be an array of at most 32 strings`)
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, 512))
}

function packageNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be an array of at most 32 package names`)
  const names = value.map((item, index) => {
    const name = boundedString(item, `${label}[${index}]`, 214)
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`${label}[${index}] is not a package name`)
    return name
  })
  if (new Set(names).size !== names.length) throw new Error(`${label} contains duplicate package names`)
  return names.sort()
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) throw new Error(`${label} must be a bounded non-negative integer`)
  return value as number
}

function parseEvidence(value: unknown, plane: DshExecutionPlane, label: string): DshWebSurfaceEvidence | DshTuiSurfaceEvidence {
  const item = record(value, label)
  if (item.plane !== plane) throw new Error(`${label}.plane does not match the report plane`)
  if (plane === 'web') {
    const booleanKeys = ['rootMounted', 'bootManifestPresent', 'pluginEntryPresent', 'pluginMaterialized'] as const
    for (const key of booleanKeys) if (typeof item[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`)
    if (item.pluginClientDeclared !== undefined && typeof item.pluginClientDeclared !== 'boolean') throw new Error(`${label}.pluginClientDeclared must be boolean`)
    return {
      plane: 'web',
      ...(item.pluginClientDeclared === undefined ? {} : { pluginClientDeclared: item.pluginClientDeclared as boolean }),
      ...(item.clientContract === undefined ? {} : { clientContract: parseDshWebContractEvidence(item.clientContract)! }),
      url: boundedString(item.url, `${label}.url`, 2_048),
      ...(optionalInteger(item.httpStatus, `${label}.httpStatus`) === undefined ? {} : { httpStatus: optionalInteger(item.httpStatus, `${label}.httpStatus`) as number }),
      ...(item.title === undefined ? {} : { title: boundedString(item.title, `${label}.title`, 256) }),
      rootMounted: item.rootMounted as boolean,
      bootManifestPresent: item.bootManifestPresent as boolean,
      ...(item.bootEntryIds === undefined ? {} : { bootEntryIds: stringArray(item.bootEntryIds, `${label}.bootEntryIds`) }),
      pluginEntryPresent: item.pluginEntryPresent as boolean,
      ...(item.pluginBundleUrl === undefined ? {} : { pluginBundleUrl: boundedString(item.pluginBundleUrl, `${label}.pluginBundleUrl`, 2_048) }),
      ...(optionalInteger(item.pluginBundleStatus, `${label}.pluginBundleStatus`) === undefined ? {} : { pluginBundleStatus: optionalInteger(item.pluginBundleStatus, `${label}.pluginBundleStatus`) as number }),
      ...(item.pluginBundleCollectionError === undefined ? {} : { pluginBundleCollectionError: boundedString(item.pluginBundleCollectionError, `${label}.pluginBundleCollectionError`, 512) }),
      applicationMounted: typeof item.applicationMounted === 'boolean'
        ? item.applicationMounted
        : item.pluginMaterialized as boolean,
      pluginMaterialized: item.pluginMaterialized as boolean,
      ...(item.bootFailureText === undefined ? {} : { bootFailureText: boundedString(item.bootFailureText, `${label}.bootFailureText`, 512) }),
      consoleErrors: stringArray(item.consoleErrors, `${label}.consoleErrors`),
      pageErrors: stringArray(item.pageErrors, `${label}.pageErrors`),
      failedRequests: stringArray(item.failedRequests, `${label}.failedRequests`),
      ...(item.blockedExternalRequests === undefined ? {} : { blockedExternalRequests: stringArray(item.blockedExternalRequests, `${label}.blockedExternalRequests`) }),
      ...(item.screenshot === undefined ? {} : { screenshot: boundedString(item.screenshot, `${label}.screenshot`, 256) }),
      ...(item.trace === undefined ? {} : { trace: boundedString(item.trace, `${label}.trace`, 256) }),
      ...(item.hostLog === undefined ? {} : { hostLog: boundedString(item.hostLog, `${label}.hostLog`, 256) }),
    }
  }
  for (const key of ['frameObserved', 'inputSent', 'exitedAfterShutdown', 'truncated']) {
    if (typeof item[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`)
  }
  if (item.terminal !== 'xterm-256color') throw new Error(`${label}.terminal must be xterm-256color`)
  return {
    plane: 'tui',
    terminal: 'xterm-256color',
    columns: optionalInteger(item.columns, `${label}.columns`) ?? 0,
    rows: optionalInteger(item.rows, `${label}.rows`) ?? 0,
    frameObserved: item.frameObserved as boolean,
    inputSent: item.inputSent as boolean,
    exitedAfterShutdown: item.exitedAfterShutdown as boolean,
    ...(optionalInteger(item.exitCode, `${label}.exitCode`) === undefined ? {} : { exitCode: optionalInteger(item.exitCode, `${label}.exitCode`) as number }),
    ...(optionalInteger(item.signal, `${label}.signal`) === undefined ? {} : { signal: optionalInteger(item.signal, `${label}.signal`) as number }),
    ...(item.transcript === undefined ? {} : { transcript: boundedString(item.transcript, `${label}.transcript`, 256) }),
    normalizedFrame: typeof item.normalizedFrame === 'string' && item.normalizedFrame.length <= 8_192 ? item.normalizedFrame : (() => { throw new Error(`${label}.normalizedFrame must be a bounded string`) })(),
    capturedBytes: optionalInteger(item.capturedBytes, `${label}.capturedBytes`) ?? 0,
    truncated: item.truncated as boolean,
  }
}

function parseRuntime(value: unknown, label: string): DshSurfaceObservationReport['runtime'] {
  const item = record(value, label)
  return {
    nodeMajor: nodeMajor(item.nodeMajor, `${label}.nodeMajor`),
    nodeVersion: exactVersion(item.nodeVersion, `${label}.nodeVersion`),
    platform: boundedString(item.platform, `${label}.platform`, 64),
    architecture: boundedString(item.architecture, `${label}.architecture`, 64),
    ...(item.pnpmVersion === undefined ? {} : { pnpmVersion: exactVersion(item.pnpmVersion, `${label}.pnpmVersion`) }),
  }
}

function parseReport(input: unknown): DshSurfaceObservationReport {
  const root = record(input, 'DSH surface report')
  if (root.schema !== DSH_SURFACE_OBSERVATION_SCHEMA || root.probe !== 'dsh-surface' || root.scope !== 'surface-runtime-behavior') {
    throw new Error(`report schema must be ${DSH_SURFACE_OBSERVATION_SCHEMA}`)
  }
  const tool = record(root.tool, 'report.tool')
  if (tool.name !== 'upstream-radar') throw new Error('report.tool.name must be upstream-radar')
  const plane = executionPlane(root.plane, 'report.plane')
  const artifact = record(root.artifact, 'report.artifact')
  const result = boundedString(root.result, 'report.result', 64) as DshSurfaceObservationResult
  if (!RESULTS.has(result)) throw new Error('report.result is unsupported')
  const boundary = record(root.boundary, 'report.boundary')
  const plugin = exactSpec(root.plugin, 'report.plugin')
  const stages = parseStages(root.stages, 'report.stages')
  const reason = boundedString(root.reason, 'report.reason', 2_048)
  const requiredDependencyBuilds = boundary.requiredDependencyBuilds === undefined
    ? (result === 'environment-unsupported'
        ? extractPnpmRequiredDependencyBuilds(`${stages.install.detail ?? ''}\n${reason}`, parseNpmSpec(plugin).name)
        : [])
    : packageNames(boundary.requiredDependencyBuilds, 'report.boundary.requiredDependencyBuilds')
  if (requiredDependencyBuilds.length > 0 && result !== 'environment-unsupported') {
    throw new Error('report may require dependency builds only for environment-unsupported')
  }
  const resolution = parseDshProfileResolutionEvidence(root.resolution, 'report.resolution')
  const hostFacts = hostBuildFields(root.hostBuildInventory, root.dshVersion, root.runtime, result, root.hostBuildFailures, stages.host)
  const hostExecution = hostExecutionFields(root, boundary.requestedHostBuildApproval, hostFacts.hostBuildInventory, stages, result)
  if (result === 'compatible') {
    const graph = resolution?.runtimeGraph
    if (graph === undefined) throw new Error('a compatible surface report must establish its independent profile/host graph')
    if (graph.hostRuntime?.source !== 'dsh-process' || graph.hostRuntime.dshVersion !== root.dshVersion) {
      throw new Error('a compatible surface report must establish the exact DSH host in its independent graph')
    }
  }
  return {
    schema: DSH_SURFACE_OBSERVATION_SCHEMA,
    tool: { name: 'upstream-radar', version: boundedString(tool.version, 'report.tool.version', 64) },
    probe: 'dsh-surface',
    scope: 'surface-runtime-behavior',
    ...(root.profileEnvironment === undefined ? {} : { profileEnvironment: parseDshProfileEnvironment(root.profileEnvironment) }),
    ...startupFields(root.startupConfiguration),
    ...(root.executionContract === undefined ? {} : { executionContract: (() => {
      if (root.executionContract !== DSH_SURFACE_EXECUTION_CONTRACT && root.executionContract !== 'dsh-surface/v1alpha8'
        && root.executionContract !== 'dsh-surface/v1alpha9' && root.executionContract !== 'dsh-surface/v1alpha10'
        && root.executionContract !== 'dsh-surface/v1alpha11' && root.executionContract !== 'dsh-surface/v1alpha12'
        && root.executionContract !== 'dsh-surface/v1alpha13' && root.executionContract !== 'dsh-surface/v1alpha14'
        && root.executionContract !== 'dsh-surface/v1alpha15') throw new Error('report execution contract is unsupported')
      return root.executionContract
    })() }),
    startedAt: isoDate(root.startedAt, 'report.startedAt'),
    completedAt: isoDate(root.completedAt, 'report.completedAt'),
    caseId: caseId(root.caseId, 'report.caseId'),
    sourceCaseId: caseId(root.sourceCaseId, 'report.sourceCaseId'),
    sourceFingerprint: fingerprint(root.sourceFingerprint, 'report.sourceFingerprint'),
    contractFingerprint: fingerprint(root.contractFingerprint, 'report.contractFingerprint'),
    plugin,
    dshVersion: exactVersion(root.dshVersion, 'report.dshVersion'),
    plane,
    profile: profileName(root.profile, 'report.profile'),
    runtimeId: boundedString(root.runtimeId, 'report.runtimeId', 214),
    runtime: parseRuntime(root.runtime, 'report.runtime'),
    artifact: {
      ...(artifact.sha256 === undefined ? {} : { sha256: bareSha256(artifact.sha256, 'report.artifact.sha256') }),
      ...(optionalInteger(artifact.bytes, 'report.artifact.bytes') === undefined ? {} : { bytes: optionalInteger(artifact.bytes, 'report.artifact.bytes') as number }),
      ...(artifact.integrity === undefined ? {} : { integrity: boundedString(artifact.integrity, 'report.artifact.integrity', 1_024) }),
    },
    stages,
    ...hostFacts,
    ...(hostExecution.hostBuildExecution === undefined ? {} : { hostBuildExecution: hostExecution.hostBuildExecution }),
    evidence: parseEvidence(root.evidence, plane, 'report.evidence'),
    ...(resolution === undefined ? {} : { resolution }),
    result,
    reason,
    boundary: {
      isolationProviderClaim: (() => {
        const value = boundary.isolationProviderClaim
        if (value !== 'github-actions-hosted-runner' && value !== 'firecracker' && value !== 'other') throw new Error('report.boundary.isolationProviderClaim is unsupported')
        return value
      })(),
      isolationVerifiedByRadar: false,
      disposableEnvironmentRequired: true,
      inheritedHostSecrets: false,
      externalBrowserRequestsBlocked: boundary.externalBrowserRequestsBlocked === true,
      approvedDependencyBuilds: packageNames(boundary.approvedDependencyBuilds ?? [], 'report.boundary.approvedDependencyBuilds'),
      ...(requiredDependencyBuilds.length === 0 ? {} : { requiredDependencyBuilds }),
      ...(hostExecution.requestedHostBuildApproval === undefined ? {} : { requestedHostBuildApproval: hostExecution.requestedHostBuildApproval }),
      note: boundedString(boundary.note, 'report.boundary.note', 2_048),
    },
  }
}

export function parseDshSurfaceLedger(input: unknown): DshSurfaceLedger {
  const root = record(input, 'DSH surface ledger')
  if (root.schema !== DSH_SURFACE_LEDGER_SCHEMA) throw new Error(`DSH surface ledger schema must be ${DSH_SURFACE_LEDGER_SCHEMA}`)
  if (!Array.isArray(root.entries) || root.entries.length > MAX_LEDGER_ENTRIES) throw new Error(`DSH surface ledger must contain at most ${MAX_LEDGER_ENTRIES} entries`)
  const ids = new Set<string>()
  const entries = root.entries.map((value, index): DshSurfaceLedgerEntry => {
    const item = record(value, `entries[${index}]`)
    const parsedCaseId = caseId(item.caseId, `entries[${index}].caseId`)
    if (ids.has(parsedCaseId)) throw new Error(`duplicate DSH surface ledger case: ${parsedCaseId}`)
    ids.add(parsedCaseId)
    const plane = executionPlane(item.plane, `entries[${index}].plane`)
    const artifact = record(item.artifact, `entries[${index}].artifact`)
    const observer = record(item.observer, `entries[${index}].observer`)
    if (observer.schema !== DSH_SURFACE_OBSERVATION_SCHEMA) throw new Error(`entries[${index}].observer.schema is unsupported`)
    const result = boundedString(item.result, `entries[${index}].result`, 64) as DshSurfaceObservationResult
    if (!RESULTS.has(result)) throw new Error(`entries[${index}].result is unsupported`)
    const plugin = exactSpec(item.plugin, `entries[${index}].plugin`)
    const stages = parseStages(item.stages, `entries[${index}].stages`)
    const reason = boundedString(item.reason, `entries[${index}].reason`, 2_048)
    const resolution = parseDshProfileResolutionEvidence(item.resolution, `entries[${index}].resolution`)
    const hostFacts = hostBuildFields(item.hostBuildInventory, item.dshVersion, item.runtime, result, item.hostBuildFailures, stages.host)
    const hostExecution = hostExecutionFields(item, item.requestedHostBuildApproval, hostFacts.hostBuildInventory, stages, result)
    const requiredDependencyBuilds = item.requiredDependencyBuilds === undefined
      ? (result === 'environment-unsupported'
          ? extractPnpmRequiredDependencyBuilds(`${stages.install.detail ?? ''}\n${reason}`, parseNpmSpec(plugin).name)
          : [])
      : packageNames(item.requiredDependencyBuilds, `entries[${index}].requiredDependencyBuilds`)
    if (requiredDependencyBuilds.length > 0 && result !== 'environment-unsupported') {
      throw new Error(`entries[${index}] may require dependency builds only for environment-unsupported`)
    }
    return {
      caseId: parsedCaseId,
      sourceCaseId: caseId(item.sourceCaseId, `entries[${index}].sourceCaseId`),
      plugin,
      dshVersion: exactVersion(item.dshVersion, `entries[${index}].dshVersion`),
      plane,
      profile: profileName(item.profile, `entries[${index}].profile`),
      ...(item.profileEnvironment === undefined ? {} : { profileEnvironment: parseDshProfileEnvironment(item.profileEnvironment) }),
      ...startupFields(item.startupConfiguration),
      runtimeId: boundedString(item.runtimeId, `entries[${index}].runtimeId`, 214),
      ...(item.approvedDependencyBuilds === undefined ? {} : { approvedDependencyBuilds: packageNames(item.approvedDependencyBuilds, `entries[${index}].approvedDependencyBuilds`) }),
      ...(requiredDependencyBuilds.length === 0 ? {} : { requiredDependencyBuilds }),
      sourceFingerprint: fingerprint(item.sourceFingerprint, `entries[${index}].sourceFingerprint`),
      contractFingerprint: fingerprint(item.contractFingerprint, `entries[${index}].contractFingerprint`),
      observedAt: isoDate(item.observedAt, `entries[${index}].observedAt`),
      runtime: parseRuntime(item.runtime, `entries[${index}].runtime`),
      artifact: {
        sha256: bareSha256(artifact.sha256, `entries[${index}].artifact.sha256`),
        ...(optionalInteger(artifact.bytes, `entries[${index}].artifact.bytes`) === undefined ? {} : { bytes: optionalInteger(artifact.bytes, `entries[${index}].artifact.bytes`) as number }),
        ...(artifact.integrity === undefined ? {} : { integrity: boundedString(artifact.integrity, `entries[${index}].artifact.integrity`, 1_024) }),
      },
      stages,
      ...hostFacts,
      ...hostExecution,
      evidence: parseEvidence(item.evidence, plane, `entries[${index}].evidence`),
      ...(resolution === undefined ? {} : { resolution }),
      result,
      reason,
      observer: {
        schema: DSH_SURFACE_OBSERVATION_SCHEMA,
        version: boundedString(observer.version, `entries[${index}].observer.version`, 64),
      },
    }
  })
  entries.sort((left, right) => left.caseId.localeCompare(right.caseId))
  return { schema: DSH_SURFACE_LEDGER_SCHEMA, entries }
}

/** Carry the same intended surface to every author baseline in the current native plan. */
export function expandDshSurfaceAuthorBaselines(targetsInput: unknown, native: Pick<DshInstallPlan, 'dshVersion' | 'matrix'>): DshSurfaceTargets {
  const configured = parseDshSurfaceTargets(targetsInput)
  const surfaces = [...configured.surfaces]
  for (const target of configured.surfaces) {
    const anchor = native.matrix.include.find(cell => cell.id === target.sourceCaseId)
    if (!anchor || anchor.dshVersion !== native.dshVersion) continue
    for (const baseline of native.matrix.include.filter(cell => cell.targetId === anchor.targetId
      && cell.nodeMajor === anchor.nodeMajor && cell.dshVersion !== anchor.dshVersion)) {
      if (surfaces.some(item => item.sourceCaseId === baseline.id && item.plane === target.plane && item.profile === target.profile
        && JSON.stringify(item.startupConfiguration?.environment ?? {}) === JSON.stringify(target.startupConfiguration?.environment ?? {}))) continue
      surfaces.push({ ...target, sourceCaseId: baseline.id,
        id: `${target.id.slice(0, 45)}-dsh-${createHash('sha256').update(`${target.id}\u0000${baseline.dshVersion}`).digest('hex').slice(0, 12)}` })
    }
  }
  return parseDshSurfaceTargets({ ...configured, surfaces })
}

export function buildDshSurfacePlan(
  targetsInput: unknown,
  sourceLedgerInput: unknown,
  surfaceLedgerInput: unknown,
  now = new Date(),
  agentPlansInput?: unknown,
  surfaceAgentPlansInput?: unknown,
): DshSurfacePlan {
  const targets = parseDshSurfaceTargets(targetsInput)
  const sourceLedger = parseDshCompatibilityLedger(sourceLedgerInput)
  const surfaceLedger = parseDshSurfaceLedger(surfaceLedgerInput)
  const agentPlans: DshHeadlessAgentPlans | undefined = agentPlansInput === undefined
    ? undefined
    : parseDshHeadlessAgentPlans(agentPlansInput)
  const surfaceAgentPlans: DshSurfaceAgentPlans | undefined = surfaceAgentPlansInput === undefined
    ? undefined
    : parseDshSurfaceAgentPlans(surfaceAgentPlansInput)
  const sourceById = new Map(sourceLedger.entries.map(entry => [entry.caseId, entry]))
  const currentById = new Map(surfaceLedger.entries.map(entry => [entry.caseId, entry]))
  const desiredTargets = [...targets.surfaces]
  const usedTargetIds = new Set(desiredTargets.map(target => target.id))
  const usedSurfacePairs = new Set(desiredTargets.map(target => `${target.sourceCaseId}\u0000${target.plane}`))
  const include: DshSurfaceExpectedCase[] = []
  const blocked: DshSurfacePlan['blocked'] = []
  if (targets.autoDiscover?.webClientGaps === true) {
    for (const source of [...sourceLedger.entries].sort((left, right) => left.caseId.localeCompare(right.caseId))) {
      const pair = `${source.caseId}\u0000web`
      if (usedSurfacePairs.has(pair) || !hasDshWebClientCoverageGap(source)) continue
      const id = automaticWebTargetId(source.caseId, usedTargetIds)
      if (desiredTargets.length >= MAX_CONFIGURED_TARGETS) {
        blocked.push({ id, reason: `automatic Web observation skipped because the ${MAX_CONFIGURED_TARGETS}-surface configured coverage bound is full` })
        continue
      }
      const runtimeId = parseNpmSpec(source.plugin).name
      desiredTargets.push({
        id,
        sourceCaseId: source.caseId,
        plane: 'web',
        profile: 'web',
        runtimeId,
        reason: 'Headless evidence contains only DSH browser-client dependency gaps; observe the exact artifact in the stock Web plane.',
      })
      usedTargetIds.add(id)
      usedSurfacePairs.add(pair)
    }
  }
  const staleBefore = now.getTime() - targets.refreshAfterHours * 60 * 60 * 1_000
  for (const target of desiredTargets) {
    if (target.environmentGap !== undefined) {
      blocked.push({ id: target.id, reason: target.environmentGap })
      continue
    }
    const source = sourceById.get(target.sourceCaseId)
    if (source === undefined) {
      blocked.push({ id: target.id, reason: `source compatibility case ${target.sourceCaseId} is missing` })
      continue
    }
    const retainedAgentPlan = agentPlans?.entries.find(plan => (
      plan.caseId === source.caseId
      && plan.targetId === source.targetId
      && plan.plugin === source.plugin
      && plan.dshVersion === source.dshVersion
      && plan.nodeMajor === source.runtime.nodeMajor
      && plan.artifactSha256 !== undefined
      && plan.artifactSha256 === source.artifact.sha256
    ))
    const expectedSourceFingerprint = createDshSurfaceSourceFingerprint(source)
    const retainedSurfaceAgentPlan = surfaceAgentPlans?.entries.find(plan => (
      plan.caseId === target.id
      && plan.sourceCaseId === source.caseId
      && plan.plugin === source.plugin
      && plan.dshVersion === source.dshVersion
      && plan.nodeMajor === source.runtime.nodeMajor
      && plan.plane === target.plane
      && plan.profile === target.profile
      && plan.sourceFingerprint === expectedSourceFingerprint
      && plan.artifactSha256 === source.artifact.sha256
    ))
    const approvedDependencyBuilds = [...new Set([
      ...(source.approvedDependencyBuilds ?? []),
      ...(retainedAgentPlan?.approvedBuilds ?? []),
      ...(retainedSurfaceAgentPlan?.approvedBuilds ?? []),
    ])].sort()
    let hostBuildApproval: DshHostBuildApproval | undefined
    if (retainedSurfaceAgentPlan?.hostBuildApproval !== undefined && retainedSurfaceAgentPlan.hostBuild !== undefined) {
      try {
        hostBuildApproval = assertDshHostBuildApproval(retainedSurfaceAgentPlan.hostBuildApproval,
          retainedSurfaceAgentPlan.hostBuild.inventory, {
            caseId: target.id, plugin: source.plugin, artifactSha256: source.artifact.sha256!, sourceFingerprint: expectedSourceFingerprint,
            dshVersion: source.dshVersion, plane: target.plane, profile: target.profile, runtime: source.runtime,
            profileEnvironment: parseDshProfileEnvironment(target.profileEnvironment ?? source.profileEnvironment),
            ...startupFields(target.startupConfiguration),
          })
      } catch { /* A stale permission is never sent for execution. Fresh facts require another review. */ }
    }
    const desired = desiredCase(target, source, approvedDependencyBuilds, hostBuildApproval)
    if (desired === undefined) {
      const hasExactArtifact = source.artifact.sha256 !== undefined && BARE_SHA256.test(source.artifact.sha256)
      blocked.push({
        id: target.id,
        reason: source.runtime.platform !== 'linux' || !['x64', 'arm64'].includes(source.runtime.architecture)
          ? `unsupported source runtime ${source.runtime.platform}/${source.runtime.architecture}; surface runners support Linux/x64 or Linux/arm64`
          : hasExactArtifact
            ? `source compatibility case ${target.sourceCaseId} is ${source.result}; its headless environment must be resolved before entering ${target.plane}`
            : `source compatibility case ${target.sourceCaseId} has no exact artifact bytes`,
      })
      continue
    }
    const current = currentById.get(target.id)
    if (current === undefined) desired.reasons.push('missing-evidence')
    else {
      if (current.sourceFingerprint !== desired.sourceFingerprint || current.artifact.sha256 !== desired.artifactSha256
        || current.plugin !== desired.plugin || current.dshVersion !== desired.dshVersion || current.runtime.nodeMajor !== desired.nodeMajor) {
        desired.reasons.push('source-evidence-changed')
      }
      if (current.contractFingerprint !== desired.contractFingerprint || current.plane !== desired.plane
        || current.profile !== desired.profile || current.runtimeId !== desired.runtimeId) {
        desired.reasons.push('surface-contract-changed')
      }
      if (Date.parse(current.observedAt) < staleBefore) desired.reasons.push('stale-evidence')
    }
    if (desired.reasons.length > 0) {
      if (include.length >= MAX_RUN_TARGETS) {
        blocked.push({ id: desired.id, reason: `deferred to a later reconciliation by the bounded ${MAX_RUN_TARGETS}-cell run budget` })
      } else {
        include.push(desired)
      }
    }
  }
  include.sort((left, right) => left.id.localeCompare(right.id))
  blocked.sort((left, right) => left.id.localeCompare(right.id))
  return {
    run: include.length > 0,
    matrix: { include },
    blocked,
    reason: include.length > 0
      ? `${include.length} execution-plane observation(s) need fresh exact evidence`
      : blocked.length > 0
        ? `no runnable execution-plane observations; ${blocked.length} source evidence gap(s) remain`
        : 'all configured execution planes have fresh exact evidence',
  }
}

function mismatch(expected: DshSurfaceExpectedCase, report: DshSurfaceObservationReport): string | undefined {
  const comparisons: Array<[string, unknown, unknown]> = [
    ['case id', expected.id, report.caseId],
    ['source case id', expected.sourceCaseId, report.sourceCaseId],
    ['plugin', expected.plugin, report.plugin],
    ['DSH version', expected.dshVersion, report.dshVersion],
    ['Node major', expected.nodeMajor, report.runtime.nodeMajor],
    ['platform', expected.platform ?? 'linux', report.runtime.platform],
    ['architecture', expected.architecture ?? 'x64', report.runtime.architecture],
    ['plane', expected.plane, report.plane],
    ['profile', expected.profile, report.profile],
    ['runtime id', expected.runtimeId, report.runtimeId],
    ['approved dependency builds', expected.allowedBuilds, report.boundary.approvedDependencyBuilds.join(',')],
    ['requested host build permission', JSON.stringify(expected.hostBuildApproval === undefined ? undefined : parseDshHostBuildApproval(expected.hostBuildApproval)), JSON.stringify(report.boundary.requestedHostBuildApproval)],
    ['artifact SHA-256', expected.artifactSha256, report.artifact.sha256],
    ['source fingerprint', expected.sourceFingerprint, report.sourceFingerprint],
    ['contract fingerprint', expected.contractFingerprint, report.contractFingerprint],
    ['startup configuration', JSON.stringify(expected.startupConfiguration), JSON.stringify(report.startupConfiguration)],
  ]
  const changed = comparisons.find(([, left, right]) => left !== right)
  const currentContract = contractFingerprint({ id: expected.id, sourceCaseId: expected.sourceCaseId,
    plane: expected.plane, profile: expected.profile, runtimeId: expected.runtimeId, reason: 'scheduled',
    ...startupFields(expected.startupConfiguration),
    ...(expected.profileEnvironment === undefined ? {} : { profileEnvironment: expected.profileEnvironment }) },
  { runtime: { nodeMajor: expected.nodeMajor, nodeVersion: report.runtime.nodeVersion,
    platform: expected.platform ?? 'linux', architecture: expected.architecture ?? 'x64' } },
  expected.runtimeId, expected.allowedBuilds === '' ? [] : expected.allowedBuilds.split(','), expected.hostBuildApproval)
  if (expected.hostBuildApproval !== undefined && report.executionContract !== DSH_SURFACE_EXECUTION_CONTRACT) return 'host rebuild requires the current execution contract'
  if (changed === undefined && expected.contractFingerprint !== currentContract) return 'expected surface contract does not match the current collector requirements'
  if (changed === undefined && expected.contractFingerprint === currentContract) {
    if (report.executionContract !== DSH_SURFACE_EXECUTION_CONTRACT) return 'report did not establish the scheduled plane-aware execution contract'
    if ((report.stages.profile.status === 'passed' || report.stages.install.status !== 'skipped') && report.hostBuildInventory === undefined) {
      return 'new surface report did not attempt the independent host build inventory collector'
    }
    if (report.plane === 'web' && report.result === 'compatible' && report.evidence.plane === 'web') {
      const proof = report.evidence.clientContract
      if (proof?.boot === undefined || report.evidence.pluginClientDeclared === undefined) return 'new Web report did not establish its independent browser contract'
      if (proof.revision !== 'dsh-web-client-contract/2' || proof.packageVersions === undefined) return 'new Web report did not collect independent package provenance'
      if (report.evidence.pluginClientDeclared && (proof.client?.platform !== 'web' || proof.pluginBundle === undefined
        || !proof.boot.entries.some(entry => entry.id === expected.runtimeId))) return 'new Web report did not bind the declared client entry and bundle'
    }
  }
  const expectedEnvironment = parseDshProfileEnvironment(expected.profileEnvironment)
  if (changed === undefined && (report.runtime.pnpmVersion !== undefined || report.result === 'compatible')
    && report.runtime.pnpmVersion !== expectedEnvironment.pnpmVersion) return `pnpm version mismatch: expected ${expectedEnvironment.pnpmVersion}`
  if (report.profileEnvironment !== undefined && JSON.stringify(report.profileEnvironment) !== JSON.stringify(expectedEnvironment)) return 'profile environment mismatch'
  if (report.result === 'compatible' && expected.profileEnvironment !== undefined && report.profileEnvironment === undefined) return 'report did not establish the scheduled profile environment'
  return changed === undefined ? undefined : `${changed[0]} mismatch: expected ${String(changed[1])}, observed ${String(changed[2])}`
}

function transition(previous: DshSurfaceLedgerEntry | undefined, current: DshSurfaceLedgerEntry): DshSurfaceTransition {
  const infrastructure = current.result === 'environment-unsupported' || current.result === 'unknown'
  let status: DshSurfaceTransition['status']
  if (previous === undefined) {
    status = current.result === 'compatible' ? 'compatible' : infrastructure ? 'new-infrastructure-gap' : 'new-incompatibility'
  } else if (current.result === 'compatible') {
    status = previous.result === 'compatible' ? 'compatible' : 'resolved-incompatibility'
  } else if (infrastructure) {
    status = previous.result === current.result && previous.reason === current.reason ? 'persisting-infrastructure-gap' : 'new-infrastructure-gap'
  } else {
    status = previous.result === current.result && previous.reason === current.reason ? 'persisting-incompatibility' : 'changed-incompatibility'
  }
  return {
    caseId: current.caseId,
    status,
    result: current.result,
    reason: current.reason,
    ...(previous === undefined ? {} : { previousResult: previous.result }),
  }
}

export function mergeDshSurfaceLedger(input: {
  ledger: unknown
  expected: readonly DshSurfaceExpectedCase[]
  reports: readonly unknown[]
}): DshSurfaceLedgerMerge {
  const ledger = parseDshSurfaceLedger(input.ledger)
  if (input.expected.length > MAX_RUN_TARGETS) throw new Error(`surface reconciliation accepts at most ${MAX_RUN_TARGETS} expected cases`)
  if (input.reports.length > MAX_RUN_TARGETS) throw new Error(`surface reconciliation accepts at most ${MAX_RUN_TARGETS} reports`)
  const expectedById = new Map<string, DshSurfaceExpectedCase>()
  for (const value of input.expected) {
    const id = caseId(value.id, 'expected.id')
    if (expectedById.has(id)) throw new Error(`duplicate expected DSH surface case: ${id}`)
    if (value.platform !== undefined && value.platform !== 'linux') throw new Error(`expected ${id}.platform is unsupported`)
    if (value.architecture !== undefined && value.architecture !== 'x64' && value.architecture !== 'arm64') throw new Error(`expected ${id}.architecture is unsupported`)
    const allowedBuilds = value.allowedBuilds === ''
      ? []
      : packageNames(value.allowedBuilds.split(','), `expected ${id}.allowedBuilds`)
    expectedById.set(id, {
      id,
      sourceCaseId: caseId(value.sourceCaseId, `expected ${id}.sourceCaseId`),
      plugin: exactSpec(value.plugin, `expected ${id}.plugin`),
      dshVersion: exactVersion(value.dshVersion, `expected ${id}.dshVersion`),
      nodeMajor: nodeMajor(value.nodeMajor, `expected ${id}.nodeMajor`),
      platform: value.platform ?? 'linux',
      architecture: value.architecture ?? 'x64',
      plane: executionPlane(value.plane, `expected ${id}.plane`),
      profile: profileName(value.profile, `expected ${id}.profile`),
      ...(value.profileEnvironment === undefined ? {} : { profileEnvironment: parseDshProfileEnvironment(value.profileEnvironment) }),
      ...startupFields(value.startupConfiguration),
      runtimeId: boundedString(value.runtimeId, `expected ${id}.runtimeId`, 214),
      artifactSha256: bareSha256(value.artifactSha256, `expected ${id}.artifactSha256`),
      allowedBuilds: allowedBuilds.join(','),
      ...(value.hostBuildApproval === undefined ? {} : { hostBuildApproval: parseDshHostBuildApproval(value.hostBuildApproval) }),
      sourceFingerprint: fingerprint(value.sourceFingerprint, `expected ${id}.sourceFingerprint`),
      contractFingerprint: fingerprint(value.contractFingerprint, `expected ${id}.contractFingerprint`),
      reasons: Array.isArray(value.reasons) ? value.reasons.map((reason, index) => boundedString(reason, `expected ${id}.reasons[${index}]`, 128)) : [],
    })
  }
  const previousById = new Map(ledger.entries.map(entry => [entry.caseId, entry]))
  const accepted = new Map<string, DshSurfaceLedgerEntry>()
  const rejectedReports: string[] = []
  for (const inputReport of input.reports) {
    let report: DshSurfaceObservationReport
    try {
      report = parseReport(inputReport)
    } catch (error: unknown) {
      rejectedReports.push(`invalid report: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const expected = expectedById.get(report.caseId)
    if (expected === undefined) {
      rejectedReports.push(`${report.caseId}: report was not scheduled`)
      continue
    }
    if (accepted.has(report.caseId)) {
      rejectedReports.push(`${report.caseId}: duplicate report`)
      accepted.delete(report.caseId)
      continue
    }
    const difference = mismatch(expected, report)
    if (difference !== undefined) {
      rejectedReports.push(`${report.caseId}: ${difference}`)
      continue
    }
    if (report.artifact.sha256 === undefined) {
      rejectedReports.push(`${report.caseId}: report did not establish exact artifact bytes`)
      continue
    }
    accepted.set(report.caseId, {
      caseId: report.caseId,
      sourceCaseId: report.sourceCaseId,
      plugin: report.plugin,
      dshVersion: report.dshVersion,
      plane: report.plane,
      profile: report.profile,
      ...(report.profileEnvironment === undefined ? {} : { profileEnvironment: report.profileEnvironment }),
      ...startupFields(report.startupConfiguration),
      runtimeId: report.runtimeId,
      ...(report.boundary.approvedDependencyBuilds.length === 0 ? {} : { approvedDependencyBuilds: report.boundary.approvedDependencyBuilds }),
      ...((report.boundary.requiredDependencyBuilds?.length ?? 0) === 0
        ? {}
        : { requiredDependencyBuilds: report.boundary.requiredDependencyBuilds }),
      sourceFingerprint: report.sourceFingerprint,
      contractFingerprint: report.contractFingerprint,
      observedAt: report.completedAt,
      runtime: report.runtime,
      artifact: {
        sha256: report.artifact.sha256,
        ...(report.artifact.bytes === undefined ? {} : { bytes: report.artifact.bytes }),
        ...(report.artifact.integrity === undefined ? {} : { integrity: report.artifact.integrity }),
      },
      stages: report.stages,
      ...(report.hostBuildInventory === undefined ? {} : { hostBuildInventory: report.hostBuildInventory }),
      ...(report.hostBuildFailures === undefined ? {} : { hostBuildFailures: report.hostBuildFailures }),
      ...(report.hostBuildExecution === undefined ? {} : { hostBuildExecution: report.hostBuildExecution }),
      ...(report.boundary.requestedHostBuildApproval === undefined ? {} : { requestedHostBuildApproval: report.boundary.requestedHostBuildApproval }),
      evidence: report.evidence,
      ...(report.resolution === undefined ? {} : { resolution: report.resolution }),
      result: report.result,
      reason: report.reason,
      observer: { schema: DSH_SURFACE_OBSERVATION_SCHEMA, version: report.tool.version },
    })
  }
  const next = new Map(previousById)
  for (const [id, entry] of accepted) next.set(id, entry)
  const entries = [...next.values()].sort((left, right) => left.caseId.localeCompare(right.caseId))
  if (entries.length > MAX_LEDGER_ENTRIES) throw new Error(`surface ledger exceeds ${MAX_LEDGER_ENTRIES} entries`)
  const acceptedCaseIds = [...accepted.keys()].sort()
  const missingCaseIds = [...expectedById.keys()].filter(id => !accepted.has(id)).sort()
  const transitions = acceptedCaseIds.map(id => transition(previousById.get(id), accepted.get(id) as DshSurfaceLedgerEntry))
  rejectedReports.sort()
  return {
    ledger: { schema: DSH_SURFACE_LEDGER_SCHEMA, entries },
    transitions,
    acceptedCaseIds,
    missingCaseIds,
    rejectedReports,
  }
}

export function buildDshSurfaceIR(ledgerInput: unknown): DshSurfaceIR {
  const ledger = parseDshSurfaceLedger(ledgerInput)
  return {
    schema: DSH_SURFACE_IR_SCHEMA,
    generatedAt: ledger.entries.reduce((latest, entry) => entry.observedAt > latest ? entry.observedAt : latest, '1970-01-01T00:00:00.000Z'),
    cells: ledger.entries.map(entry => ({
      id: entry.caseId,
      sourceCaseId: entry.sourceCaseId,
      plane: entry.plane,
      profile: entry.profile,
      runtimeId: entry.runtimeId,
      ...startupFields(entry.startupConfiguration),
      plugin: { spec: entry.plugin, artifactSha256: entry.artifact.sha256 },
      upstream: { package: '@deepseek-ai/dsh', dshVersion: entry.dshVersion },
      runtime: entry.runtime,
      observation: {
        observedAt: entry.observedAt,
        result: entry.result,
        reason: entry.reason,
        ...(entry.requiredDependencyBuilds === undefined ? {} : { requiredDependencyBuilds: entry.requiredDependencyBuilds }),
        stages: entry.stages,
        ...(entry.hostBuildInventory === undefined ? {} : { hostBuildInventory: entry.hostBuildInventory }),
        ...(entry.hostBuildFailures === undefined ? {} : { hostBuildFailures: entry.hostBuildFailures }),
        ...(entry.hostBuildExecution === undefined ? {} : { hostBuildExecution: entry.hostBuildExecution }),
        ...(entry.requestedHostBuildApproval === undefined ? {} : { requestedHostBuildApproval: entry.requestedHostBuildApproval }),
        evidence: entry.evidence,
      },
    })),
  }
}

export function renderDshSurfaceLedgerMerge(merge: DshSurfaceLedgerMerge): string {
  const lines = [
    '# DSH execution-plane reconciliation',
    '',
    `Accepted: ${merge.acceptedCaseIds.length}`,
    `Missing: ${merge.missingCaseIds.length}`,
    `Rejected: ${merge.rejectedReports.length}`,
    '',
  ]
  for (const transition of merge.transitions) {
    lines.push(`- ${transition.caseId}: **${transition.status}** — ${transition.result}: ${transition.reason}`)
  }
  if (merge.missingCaseIds.length > 0) lines.push('', `Missing cases: ${merge.missingCaseIds.join(', ')}`)
  if (merge.rejectedReports.length > 0) {
    lines.push('', 'Rejected reports:')
    for (const item of merge.rejectedReports) lines.push(`- ${item}`)
  }
  return `${lines.join('\n')}\n`
}
