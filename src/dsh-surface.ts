import { createHash } from 'node:crypto'
import { parseDshCompatibilityLedger, type DshCompatibilityLedgerEntry } from './dsh-compatibility-ledger.js'
import { parseDshHeadlessAgentPlans, type DshHeadlessAgentPlans } from './dsh-headless-agent-plan.js'
import {
  DSH_SURFACE_OBSERVATION_SCHEMA,
  type DshExecutionPlane,
  type DshSurfaceObservationReport,
  type DshSurfaceObservationResult,
  type DshSurfaceStage,
  type DshTuiSurfaceEvidence,
  type DshWebSurfaceEvidence,
} from './dsh-surface-observation.js'
import { parseNpmSpec } from './npm.js'

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
const MAX_TARGETS = 32
const MAX_LEDGER_ENTRIES = 128
const SURFACE_CONTRACT_REVISION = 'dsh-surface-contract/4'

export interface DshSurfaceTarget {
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
  id: string
  sourceCaseId: string
  plugin: string
  dshVersion: string
  nodeMajor: number
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
  caseId: string
  sourceCaseId: string
  plugin: string
  dshVersion: string
  plane: DshExecutionPlane
  profile: string
  runtimeId: string
  approvedDependencyBuilds?: string[]
  sourceFingerprint: string
  contractFingerprint: string
  observedAt: string
  runtime: DshSurfaceObservationReport['runtime']
  artifact: { sha256: string; bytes?: number; integrity?: string }
  stages: DshSurfaceObservationReport['stages']
  evidence: DshWebSurfaceEvidence | DshTuiSurfaceEvidence
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
    id: string
    sourceCaseId: string
    plane: DshExecutionPlane
    profile: string
    runtimeId: string
    plugin: { spec: string; artifactSha256: string }
    upstream: { package: '@deepseek-ai/dsh'; dshVersion: string }
    runtime: DshSurfaceObservationReport['runtime']
    observation: {
      observedAt: string
      result: DshSurfaceObservationResult
      reason: string
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
  if (!Array.isArray(root.surfaces) || root.surfaces.length === 0 || root.surfaces.length > MAX_TARGETS) {
    throw new Error(`DSH surface targets must contain between 1 and ${MAX_TARGETS} surfaces`)
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
    const pair = `${sourceCaseId}\u0000${plane}`
    if (pairs.has(pair)) throw new Error(`duplicate DSH surface plane for source case: ${sourceCaseId} ${plane}`)
    pairs.add(pair)
    return { id, sourceCaseId, plane, profile, runtimeId, reason }
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
  return dshCompatibilityGapNames(entry).some(isWebClientPackage)
}

/**
 * True only when the headless result is unresolved exclusively because the
 * stock Web profile is absent. The intended Web plane may cover this gap; a
 * host/runtime mismatch must remain visible even when browser boot succeeds.
 */
export function isDshWebClientOnlyCoverageGap(entry: DshCompatibilityLedgerEntry): boolean {
  if (entry.result !== 'peer-contract-incompatible' && entry.result !== 'unknown') return false
  const names = dshCompatibilityGapNames(entry)
  return names.length > 0 && names.every(isWebClientPackage)
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

function sourceFingerprint(entry: DshCompatibilityLedgerEntry): string {
  return digest({
    caseId: entry.caseId,
    plugin: entry.plugin,
    dshVersion: entry.dshVersion,
    nodeMajor: entry.runtime.nodeMajor,
    artifactSha256: entry.artifact.sha256,
    staticFingerprint: entry.staticFingerprint,
    contractFingerprint: entry.contractFingerprint,
    approvedDependencyBuilds: entry.approvedDependencyBuilds ?? [],
    observerSchema: entry.observer.schema,
  })
}

function contractFingerprint(
  target: DshSurfaceTarget,
  entry: DshCompatibilityLedgerEntry,
  runtimeId: string,
  approvedDependencyBuilds: readonly string[],
): string {
  return digest({
    revision: SURFACE_CONTRACT_REVISION,
    plane: target.plane,
    profile: target.profile,
    runtimeId,
    nodeMajor: entry.runtime.nodeMajor,
    approvedDependencyBuilds,
    web: target.plane === 'web'
      ? { browser: 'chromium', root: '#root', manifest: '__DSH_BOOT__', bootHandoff: '[data-dsh-boot] removed after graph activation', externalRequests: 'blocked' }
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
): DshSurfaceExpectedCase | undefined {
  // The headless result may legitimately remain unknown when the unresolved
  // edges belong to the Web or TUI host that this target is about to provide.
  // An explicit surface target needs only exact artifact provenance here; the
  // plane observer independently reinstalls the package, verifies this digest,
  // and establishes its own result.
  if (source.artifact.sha256 === undefined || !BARE_SHA256.test(source.artifact.sha256)) return undefined
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
    plane: target.plane,
    profile: target.profile,
    runtimeId,
    artifactSha256: source.artifact.sha256,
    allowedBuilds: [...approvedDependencyBuilds].sort().join(','),
    sourceFingerprint: sourceFingerprint(source),
    contractFingerprint: contractFingerprint(target, source, runtimeId, approvedDependencyBuilds),
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
    return {
      plane: 'web',
      url: boundedString(item.url, `${label}.url`, 2_048),
      ...(optionalInteger(item.httpStatus, `${label}.httpStatus`) === undefined ? {} : { httpStatus: optionalInteger(item.httpStatus, `${label}.httpStatus`) as number }),
      ...(item.title === undefined ? {} : { title: boundedString(item.title, `${label}.title`, 256) }),
      rootMounted: item.rootMounted as boolean,
      bootManifestPresent: item.bootManifestPresent as boolean,
      ...(item.bootEntryIds === undefined ? {} : { bootEntryIds: stringArray(item.bootEntryIds, `${label}.bootEntryIds`) }),
      pluginEntryPresent: item.pluginEntryPresent as boolean,
      ...(item.pluginBundleUrl === undefined ? {} : { pluginBundleUrl: boundedString(item.pluginBundleUrl, `${label}.pluginBundleUrl`, 2_048) }),
      ...(optionalInteger(item.pluginBundleStatus, `${label}.pluginBundleStatus`) === undefined ? {} : { pluginBundleStatus: optionalInteger(item.pluginBundleStatus, `${label}.pluginBundleStatus`) as number }),
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
  return {
    schema: DSH_SURFACE_OBSERVATION_SCHEMA,
    tool: { name: 'upstream-radar', version: boundedString(tool.version, 'report.tool.version', 64) },
    probe: 'dsh-surface',
    scope: 'surface-runtime-behavior',
    startedAt: isoDate(root.startedAt, 'report.startedAt'),
    completedAt: isoDate(root.completedAt, 'report.completedAt'),
    caseId: caseId(root.caseId, 'report.caseId'),
    sourceCaseId: caseId(root.sourceCaseId, 'report.sourceCaseId'),
    sourceFingerprint: fingerprint(root.sourceFingerprint, 'report.sourceFingerprint'),
    contractFingerprint: fingerprint(root.contractFingerprint, 'report.contractFingerprint'),
    plugin: exactSpec(root.plugin, 'report.plugin'),
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
    stages: parseStages(root.stages, 'report.stages'),
    evidence: parseEvidence(root.evidence, plane, 'report.evidence'),
    result,
    reason: boundedString(root.reason, 'report.reason', 2_048),
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
    return {
      caseId: parsedCaseId,
      sourceCaseId: caseId(item.sourceCaseId, `entries[${index}].sourceCaseId`),
      plugin: exactSpec(item.plugin, `entries[${index}].plugin`),
      dshVersion: exactVersion(item.dshVersion, `entries[${index}].dshVersion`),
      plane,
      profile: profileName(item.profile, `entries[${index}].profile`),
      runtimeId: boundedString(item.runtimeId, `entries[${index}].runtimeId`, 214),
      ...(item.approvedDependencyBuilds === undefined ? {} : { approvedDependencyBuilds: packageNames(item.approvedDependencyBuilds, `entries[${index}].approvedDependencyBuilds`) }),
      sourceFingerprint: fingerprint(item.sourceFingerprint, `entries[${index}].sourceFingerprint`),
      contractFingerprint: fingerprint(item.contractFingerprint, `entries[${index}].contractFingerprint`),
      observedAt: isoDate(item.observedAt, `entries[${index}].observedAt`),
      runtime: parseRuntime(item.runtime, `entries[${index}].runtime`),
      artifact: {
        sha256: bareSha256(artifact.sha256, `entries[${index}].artifact.sha256`),
        ...(optionalInteger(artifact.bytes, `entries[${index}].artifact.bytes`) === undefined ? {} : { bytes: optionalInteger(artifact.bytes, `entries[${index}].artifact.bytes`) as number }),
        ...(artifact.integrity === undefined ? {} : { integrity: boundedString(artifact.integrity, `entries[${index}].artifact.integrity`, 1_024) }),
      },
      stages: parseStages(item.stages, `entries[${index}].stages`),
      evidence: parseEvidence(item.evidence, plane, `entries[${index}].evidence`),
      result,
      reason: boundedString(item.reason, `entries[${index}].reason`, 2_048),
      observer: {
        schema: DSH_SURFACE_OBSERVATION_SCHEMA,
        version: boundedString(observer.version, `entries[${index}].observer.version`, 64),
      },
    }
  })
  entries.sort((left, right) => left.caseId.localeCompare(right.caseId))
  return { schema: DSH_SURFACE_LEDGER_SCHEMA, entries }
}

export function buildDshSurfacePlan(
  targetsInput: unknown,
  sourceLedgerInput: unknown,
  surfaceLedgerInput: unknown,
  now = new Date(),
  agentPlansInput?: unknown,
): DshSurfacePlan {
  const targets = parseDshSurfaceTargets(targetsInput)
  const sourceLedger = parseDshCompatibilityLedger(sourceLedgerInput)
  const surfaceLedger = parseDshSurfaceLedger(surfaceLedgerInput)
  const agentPlans: DshHeadlessAgentPlans | undefined = agentPlansInput === undefined
    ? undefined
    : parseDshHeadlessAgentPlans(agentPlansInput)
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
      if (desiredTargets.length >= MAX_TARGETS) {
        blocked.push({ id, reason: `automatic Web observation skipped because the ${MAX_TARGETS}-surface run budget is full` })
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
    const approvedDependencyBuilds = [...new Set([
      ...(source.approvedDependencyBuilds ?? []),
      ...(retainedAgentPlan?.approvedBuilds ?? []),
    ])].sort()
    const desired = desiredCase(target, source, approvedDependencyBuilds)
    if (desired === undefined) {
      const hasExactArtifact = source.artifact.sha256 !== undefined && BARE_SHA256.test(source.artifact.sha256)
      blocked.push({
        id: target.id,
        reason: hasExactArtifact
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
    if (desired.reasons.length > 0) include.push(desired)
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
    ['plane', expected.plane, report.plane],
    ['profile', expected.profile, report.profile],
    ['runtime id', expected.runtimeId, report.runtimeId],
    ['approved dependency builds', expected.allowedBuilds, report.boundary.approvedDependencyBuilds.join(',')],
    ['artifact SHA-256', expected.artifactSha256, report.artifact.sha256],
    ['source fingerprint', expected.sourceFingerprint, report.sourceFingerprint],
    ['contract fingerprint', expected.contractFingerprint, report.contractFingerprint],
  ]
  const changed = comparisons.find(([, left, right]) => left !== right)
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
  if (input.expected.length > MAX_TARGETS) throw new Error(`surface reconciliation accepts at most ${MAX_TARGETS} expected cases`)
  if (input.reports.length > MAX_TARGETS) throw new Error(`surface reconciliation accepts at most ${MAX_TARGETS} reports`)
  const expectedById = new Map<string, DshSurfaceExpectedCase>()
  for (const value of input.expected) {
    const id = caseId(value.id, 'expected.id')
    if (expectedById.has(id)) throw new Error(`duplicate expected DSH surface case: ${id}`)
    const allowedBuilds = value.allowedBuilds === ''
      ? []
      : packageNames(value.allowedBuilds.split(','), `expected ${id}.allowedBuilds`)
    expectedById.set(id, {
      id,
      sourceCaseId: caseId(value.sourceCaseId, `expected ${id}.sourceCaseId`),
      plugin: exactSpec(value.plugin, `expected ${id}.plugin`),
      dshVersion: exactVersion(value.dshVersion, `expected ${id}.dshVersion`),
      nodeMajor: nodeMajor(value.nodeMajor, `expected ${id}.nodeMajor`),
      plane: executionPlane(value.plane, `expected ${id}.plane`),
      profile: profileName(value.profile, `expected ${id}.profile`),
      runtimeId: boundedString(value.runtimeId, `expected ${id}.runtimeId`, 214),
      artifactSha256: bareSha256(value.artifactSha256, `expected ${id}.artifactSha256`),
      allowedBuilds: allowedBuilds.join(','),
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
      runtimeId: report.runtimeId,
      ...(report.boundary.approvedDependencyBuilds.length === 0 ? {} : { approvedDependencyBuilds: report.boundary.approvedDependencyBuilds }),
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
      evidence: report.evidence,
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
      plugin: { spec: entry.plugin, artifactSha256: entry.artifact.sha256 },
      upstream: { package: '@deepseek-ai/dsh', dshVersion: entry.dshVersion },
      runtime: entry.runtime,
      observation: {
        observedAt: entry.observedAt,
        result: entry.result,
        reason: entry.reason,
        stages: entry.stages,
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
