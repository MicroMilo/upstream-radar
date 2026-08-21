import { createHash } from 'node:crypto'
import { parseNpmSpec } from './npm.js'
import type { DshInstallObservationResult } from './dsh-install-observation.js'

/**
 * Durable, current-state evidence for the exact plugin/DSH/runtime cells that
 * Radar promises to keep checking. This is deliberately a ledger, not a test
 * history database: one entry represents the latest trustworthy observation
 * for one active cell.
 */
export const DSH_COMPATIBILITY_LEDGER_SCHEMA = 'upstream-radar.dsh-compatibility-ledger/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const RESULTS = new Set<DshInstallObservationResult>(['compatible', 'runtime-incompatible', 'install-failed', 'load-failed', 'unknown'])
const MAX_ENTRIES = 500
const MAX_REPORTS = 100

export interface DshCompatibilityProfileLockfile {
  sha256: string
  bytes: number
  graphDigest?: string
  nodes?: number
  edges?: number
  unresolved?: number
  unresolvedDependencies?: DshCompatibilityProfileGraphGap[]
}

export interface DshCompatibilityProfileGraphGap {
  from: string
  name: string
  spec: string
  kind: 'runtime' | 'development' | 'optional' | 'peer' | 'host-runtime'
}

export interface DshCompatibilityRuntimeGraph {
  digest: string
  nodes: number
  edges: number
  unresolved: number
  unresolvedDependencies?: DshCompatibilityProfileGraphGap[]
  hostRuntime?: {
    source: 'dsh-profile-fallback' | 'dsh-process'
    resolvedNodes: number
    dshVersion?: string
  }
}

export interface DshCompatibilityLedgerEntry {
  caseId: string
  targetId: string
  plugin: string
  dshVersion: string
  runtime: {
    nodeMajor: number
    nodeVersion: string
    platform: string
    architecture: string
    pnpmVersion?: string
  }
  staticFingerprint: string
  contractFingerprint: string
  observedAt: string
  result: DshInstallObservationResult
  reason: string
  artifact: {
    lifecycleScripts: string[]
    sha256?: string
    integrity?: string
    nodeEngine?: string
  }
  resolution?: {
    profileLockfile?: DshCompatibilityProfileLockfile
    runtimeGraph?: DshCompatibilityRuntimeGraph
  }
  observer: {
    schema: string
    version: string
  }
}

export interface DshCompatibilityLedger {
  schema: typeof DSH_COMPATIBILITY_LEDGER_SCHEMA
  entries: DshCompatibilityLedgerEntry[]
}

/** One matrix entry sent from the static reconciler to the isolated runner. */
export interface DshCompatibilityExpectedCase {
  id: string
  targetId: string
  plugin: string
  dshVersion: string
  nodeMajor: number
  allowedBuilds: string
  staticFingerprint: string
  contractFingerprint: string
  reasons: string[]
}

export type DshCompatibilityTransitionStatus =
  | 'compatible'
  | 'artifact-drift'
  | 'resolution-drift'
  | 'new-incompatibility'
  | 'changed-incompatibility'
  | 'resolved-incompatibility'
  | 'persisting-incompatibility'

export interface DshCompatibilityTransition {
  caseId: string
  status: DshCompatibilityTransitionStatus
  result: DshInstallObservationResult
  reason: string
  previousResult?: DshInstallObservationResult
}

export interface DshCompatibilityLedgerMerge {
  ledger: DshCompatibilityLedger
  transitions: DshCompatibilityTransition[]
  acceptedCaseIds: string[]
  missingCaseIds: string[]
  rejectedReports: string[]
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

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum)
}

function exactVersion(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 256)
  if (!EXACT_VERSION.test(parsed)) throw new Error(`${label} must be an exact semantic version`)
  return parsed
}

function caseId(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!CASE_ID.test(parsed)) throw new Error(`${label} must be a short lowercase label`)
  return parsed
}

function exactSpec(value: unknown, label: string): string {
  const raw = boundedString(value, label, 512)
  const parsed = parseNpmSpec(raw)
  if (!EXACT_VERSION.test(parsed.version)) throw new Error(`${label} must be an exact npm package coordinate`)
  return `${parsed.name}@${parsed.version}`
}

function nodeMajor(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 16 || (value as number) > 40) {
    throw new Error(`${label} must be a supported Node.js major version`)
  }
  return value as number
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded non-negative integer`)
  }
  return value as number
}

function optionalDigest(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const digest = boundedString(value, label, 128)
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a sha256 digest`)
  return digest
}

function optionalBareSha256(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const digest = boundedString(value, label, 64)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 hex digest`)
  return digest
}

function parseLifecycleScripts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error(`${label} must be an array of at most four lifecycle script names`)
  const allowed = new Set(['preinstall', 'install', 'postinstall', 'prepare'])
  const scripts = value.map((item, index) => boundedString(item, `${label}[${index}]`, 32))
  if (scripts.some(script => !allowed.has(script))) throw new Error(`${label} contains an unsupported lifecycle script name`)
  if (new Set(scripts).size !== scripts.length) throw new Error(`${label} must not contain duplicate lifecycle script names`)
  return scripts.sort()
}

function parseGraphGaps(
  item: Record<string, unknown>,
  label: string,
  unresolved: number | undefined,
): DshCompatibilityProfileGraphGap[] | undefined {
  const rawGaps = item.unresolvedDependencies
  if (rawGaps !== undefined && (!Array.isArray(rawGaps) || rawGaps.length > 32)) {
    throw new Error(`${label}.unresolvedDependencies must be an array of at most 32 graph gaps`)
  }
  const unresolvedDependencies = rawGaps?.map((value, index): DshCompatibilityProfileGraphGap => {
    const gap = record(value, `${label}.unresolvedDependencies[${index}]`)
    const kind = boundedString(gap.kind, `${label}.unresolvedDependencies[${index}].kind`, 32)
    if (!['runtime', 'development', 'optional', 'peer', 'host-runtime'].includes(kind)) {
      throw new Error(`${label}.unresolvedDependencies[${index}].kind is unsupported`)
    }
    return {
      from: boundedString(gap.from, `${label}.unresolvedDependencies[${index}].from`, 512),
      name: boundedString(gap.name, `${label}.unresolvedDependencies[${index}].name`, 214),
      spec: boundedString(gap.spec, `${label}.unresolvedDependencies[${index}].spec`, 512),
      kind: kind as DshCompatibilityProfileGraphGap['kind'],
    }
  })
  if (unresolvedDependencies !== undefined && unresolved !== undefined && unresolvedDependencies.length > unresolved) {
    throw new Error(`${label}.unresolvedDependencies cannot exceed unresolved`)
  }
  return unresolvedDependencies
}

function parseProfileLockfile(value: unknown, label: string): DshCompatibilityProfileLockfile | undefined {
  if (value === undefined) return undefined
  const item = record(value, label)
  const sha256 = optionalBareSha256(item.sha256, `${label}.sha256`)
  if (sha256 === undefined) throw new Error(`${label}.sha256 is required`)
  const graphDigest = optionalDigest(item.graphDigest, `${label}.graphDigest`)
  const nodes = item.nodes === undefined ? undefined : positiveInteger(item.nodes, `${label}.nodes`, 100_000)
  const edges = item.edges === undefined ? undefined : positiveInteger(item.edges, `${label}.edges`, 250_000)
  const unresolved = item.unresolved === undefined ? undefined : positiveInteger(item.unresolved, `${label}.unresolved`, 250_000)
  const unresolvedDependencies = parseGraphGaps(item, label, unresolved)
  return {
    sha256,
    bytes: positiveInteger(item.bytes, `${label}.bytes`, 64 * 1024 * 1024),
    ...(graphDigest === undefined ? {} : { graphDigest }),
    ...(nodes === undefined ? {} : { nodes }),
    ...(edges === undefined ? {} : { edges }),
    ...(unresolved === undefined ? {} : { unresolved }),
    ...(unresolvedDependencies === undefined ? {} : { unresolvedDependencies }),
  }
}

function parseRuntimeGraph(value: unknown, label: string): DshCompatibilityRuntimeGraph | undefined {
  if (value === undefined) return undefined
  const item = record(value, label)
  const digest = optionalDigest(item.digest, `${label}.digest`)
  if (digest === undefined) throw new Error(`${label}.digest is required`)
  const unresolved = positiveInteger(item.unresolved, `${label}.unresolved`, 250_000)
  const hostRuntime = item.hostRuntime === undefined ? undefined : record(item.hostRuntime, `${label}.hostRuntime`)
  let parsedHostRuntime: DshCompatibilityRuntimeGraph['hostRuntime']
  if (hostRuntime !== undefined) {
    const source = boundedString(hostRuntime.source, `${label}.hostRuntime.source`, 64)
    if (source !== 'dsh-profile-fallback' && source !== 'dsh-process') {
      throw new Error(`${label}.hostRuntime.source is unsupported`)
    }
    const dshVersion = hostRuntime.dshVersion === undefined
      ? undefined
      : exactVersion(hostRuntime.dshVersion, `${label}.hostRuntime.dshVersion`)
    parsedHostRuntime = {
      source,
      resolvedNodes: positiveInteger(hostRuntime.resolvedNodes, `${label}.hostRuntime.resolvedNodes`, 100_000),
      ...(dshVersion === undefined ? {} : { dshVersion }),
    }
  }
  const unresolvedDependencies = parseGraphGaps(item, label, unresolved)
  return {
    digest,
    nodes: positiveInteger(item.nodes, `${label}.nodes`, 100_000),
    edges: positiveInteger(item.edges, `${label}.edges`, 250_000),
    unresolved,
    ...(unresolvedDependencies === undefined ? {} : { unresolvedDependencies }),
    ...(parsedHostRuntime === undefined ? {} : { hostRuntime: parsedHostRuntime }),
  }
}

function parseEntry(value: unknown, index: number): DshCompatibilityLedgerEntry {
  const item = record(value, `entries[${index}]`)
  const runtime = record(item.runtime, `entries[${index}].runtime`)
  const artifact = record(item.artifact, `entries[${index}].artifact`)
  const observer = record(item.observer, `entries[${index}].observer`)
  const result = boundedString(item.result, `entries[${index}].result`, 64) as DshInstallObservationResult
  if (!RESULTS.has(result)) throw new Error(`entries[${index}].result is not a supported install observation result`)
  const staticFingerprint = boundedString(item.staticFingerprint, `entries[${index}].staticFingerprint`, 80)
  const contractFingerprint = boundedString(item.contractFingerprint, `entries[${index}].contractFingerprint`, 80)
  if (!FINGERPRINT.test(staticFingerprint) || !FINGERPRINT.test(contractFingerprint)) {
    throw new Error(`entries[${index}] fingerprints must be SHA-256 digests`)
  }
  const observedAt = boundedString(item.observedAt, `entries[${index}].observedAt`, 64)
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`entries[${index}].observedAt must be an ISO timestamp`)
  const resolution = item.resolution === undefined ? undefined : record(item.resolution, `entries[${index}].resolution`)
  const profileLockfile = resolution === undefined ? undefined : parseProfileLockfile(resolution.profileLockfile, `entries[${index}].resolution.profileLockfile`)
  const runtimeGraph = resolution === undefined ? undefined : parseRuntimeGraph(resolution.runtimeGraph, `entries[${index}].resolution.runtimeGraph`)
  const sha256 = optionalBareSha256(artifact.sha256, `entries[${index}].artifact.sha256`)
  const integrity = optionalBoundedString(artifact.integrity, `entries[${index}].artifact.integrity`, 1_024)
  const nodeEngine = optionalBoundedString(artifact.nodeEngine, `entries[${index}].artifact.nodeEngine`, 512)
  const pnpmVersion = runtime.pnpmVersion === undefined ? undefined : exactVersion(runtime.pnpmVersion, `entries[${index}].runtime.pnpmVersion`)
  return {
    caseId: caseId(item.caseId, `entries[${index}].caseId`),
    targetId: caseId(item.targetId, `entries[${index}].targetId`),
    plugin: exactSpec(item.plugin, `entries[${index}].plugin`),
    dshVersion: exactVersion(item.dshVersion, `entries[${index}].dshVersion`),
    runtime: {
      nodeMajor: nodeMajor(runtime.nodeMajor, `entries[${index}].runtime.nodeMajor`),
      nodeVersion: exactVersion(runtime.nodeVersion, `entries[${index}].runtime.nodeVersion`),
      platform: boundedString(runtime.platform, `entries[${index}].runtime.platform`, 64),
      architecture: boundedString(runtime.architecture, `entries[${index}].runtime.architecture`, 64),
      ...(pnpmVersion === undefined ? {} : { pnpmVersion }),
    },
    staticFingerprint,
    contractFingerprint,
    observedAt,
    result,
    reason: boundedString(item.reason, `entries[${index}].reason`, 4_096),
    artifact: {
      lifecycleScripts: parseLifecycleScripts(artifact.lifecycleScripts, `entries[${index}].artifact.lifecycleScripts`),
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(integrity === undefined ? {} : { integrity }),
      ...(nodeEngine === undefined ? {} : { nodeEngine }),
    },
    ...(profileLockfile === undefined && runtimeGraph === undefined
      ? {}
      : { resolution: {
          ...(profileLockfile === undefined ? {} : { profileLockfile }),
          ...(runtimeGraph === undefined ? {} : { runtimeGraph }),
        } }),
    observer: {
      schema: boundedString(observer.schema, `entries[${index}].observer.schema`, 256),
      version: boundedString(observer.version, `entries[${index}].observer.version`, 256),
    },
  }
}

export function emptyDshCompatibilityLedger(): DshCompatibilityLedger {
  return { schema: DSH_COMPATIBILITY_LEDGER_SCHEMA, entries: [] }
}

export function parseDshCompatibilityLedger(input: unknown): DshCompatibilityLedger {
  const root = record(input, 'DSH compatibility ledger')
  if (root.schema !== DSH_COMPATIBILITY_LEDGER_SCHEMA) {
    throw new Error(`DSH compatibility ledger schema must be ${DSH_COMPATIBILITY_LEDGER_SCHEMA}`)
  }
  if (!Array.isArray(root.entries) || root.entries.length > MAX_ENTRIES) {
    throw new Error(`DSH compatibility ledger entries must be an array of at most ${MAX_ENTRIES} entries`)
  }
  const entries = root.entries.map(parseEntry)
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.caseId)) throw new Error(`duplicate DSH compatibility ledger caseId: ${entry.caseId}`)
    ids.add(entry.caseId)
  }
  entries.sort((left, right) => left.caseId.localeCompare(right.caseId))
  return { schema: DSH_COMPATIBILITY_LEDGER_SCHEMA, entries }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`
}

/** Static facts that may invalidate a prior runtime observation. */
export function createDshCompatibilityStaticFingerprint(value: unknown): string {
  return fingerprint(value)
}

/** The controlled execution contract, deliberately separate from source facts. */
export function createDshCompatibilityContractFingerprint(value: {
  plugin: string
  dshVersion: string
  nodeMajor: number
  allowedBuilds: readonly string[]
}): string {
  return fingerprint({
    probe: 'dsh-install/v1alpha1',
    platform: 'linux',
    architecture: 'x64',
    packageManager: 'pnpm@11.7.0',
    image: `node:${value.nodeMajor}-bookworm-slim`,
    plugin: value.plugin,
    dshVersion: value.dshVersion,
    allowedBuilds: [...value.allowedBuilds].sort(),
  })
}

export function dshCompatibilityCaseId(targetId: string, runtimeProfileId: string): string {
  const combined = `${targetId}-${runtimeProfileId}`
  if (!CASE_ID.test(combined)) throw new Error(`DSH compatibility case id is invalid: ${combined}`)
  return combined
}

function reportRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, unknown>
}

function reportString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value === '' || value.length > maximum) throw new Error(`${label} is invalid`)
  return value
}

function parseExpectedCases(input: readonly DshCompatibilityExpectedCase[]): Map<string, DshCompatibilityExpectedCase> {
  if (input.length > MAX_REPORTS) throw new Error(`compatibility reconciliation accepts at most ${MAX_REPORTS} expected cases`)
  const expected = new Map<string, DshCompatibilityExpectedCase>()
  for (const item of input) {
    const id = caseId(item.id, 'expected case id')
    if (expected.has(id)) throw new Error(`duplicate expected compatibility case id: ${id}`)
    const plugin = exactSpec(item.plugin, `expected case ${id} plugin`)
    const dshVersion = exactVersion(item.dshVersion, `expected case ${id} DSH version`)
    const allowedBuilds = item.allowedBuilds === '' ? [] : item.allowedBuilds.split(',')
    if (allowedBuilds.some(name => !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))) {
      throw new Error(`expected case ${id} contains an invalid approved dependency build`)
    }
    if (new Set(allowedBuilds).size !== allowedBuilds.length) throw new Error(`expected case ${id} contains duplicate approved dependency builds`)
    if (!FINGERPRINT.test(item.staticFingerprint) || !FINGERPRINT.test(item.contractFingerprint)) {
      throw new Error(`expected case ${id} has an invalid fingerprint`)
    }
    expected.set(id, {
      ...item,
      id,
      targetId: caseId(item.targetId, `expected case ${id} targetId`),
      plugin,
      dshVersion,
      nodeMajor: nodeMajor(item.nodeMajor, `expected case ${id} nodeMajor`),
      allowedBuilds: allowedBuilds.sort().join(','),
      reasons: [...new Set(item.reasons)].sort(),
    })
  }
  return expected
}

function parseObservationReport(value: unknown, expected: DshCompatibilityExpectedCase): DshCompatibilityLedgerEntry {
  const report = reportRecord(value, `report for ${expected.id}`)
  if (report.schema !== 'upstream-radar.dsh-install-observation/v1alpha1') throw new Error('report schema is not a DSH install observation')
  if (report.probe !== 'dsh-install' || report.scope !== 'install-and-load-behavior') throw new Error('report does not describe an install-and-load observation')
  if (caseId(report.caseId, 'report caseId') !== expected.id) throw new Error('report caseId does not match the scheduled case')
  const dshVersion = exactVersion(report.dshVersion, 'report dshVersion')
  if (dshVersion !== expected.dshVersion) throw new Error(`report DSH version ${dshVersion} does not match scheduled ${expected.dshVersion}`)
  const artifact = reportRecord(report.artifact, 'report artifact')
  const plugin = exactSpec(artifact.spec, 'report artifact spec')
  if (plugin !== expected.plugin) throw new Error(`report artifact ${plugin} does not match scheduled ${expected.plugin}`)
  const runtime = reportRecord(report.runtime, 'report runtime')
  const runtimeNodeVersion = exactVersion(runtime.nodeVersion, 'report runtime.nodeVersion')
  const actualMajor = Number(runtimeNodeVersion.split('.')[0])
  if (actualMajor !== expected.nodeMajor) throw new Error(`report Node ${runtimeNodeVersion} does not match scheduled Node ${expected.nodeMajor}`)
  const packageManager = reportRecord(runtime.packageManager, 'report runtime.packageManager')
  if (packageManager.name !== 'pnpm') throw new Error('report package manager is not pnpm')
  const pnpmVersion = packageManager.version === undefined ? undefined : exactVersion(packageManager.version, 'report runtime.packageManager.version')
  const boundary = reportRecord(report.boundary, 'report boundary')
  const approved = parseLifecycleBuilds(boundary.approvedDependencyBuilds, 'report boundary.approvedDependencyBuilds')
  if (approved.join(',') !== expected.allowedBuilds) throw new Error('report approved dependency builds do not match the scheduled policy')
  const result = reportString(report.result, 'report result', 64) as DshInstallObservationResult
  if (!RESULTS.has(result)) throw new Error('report result is unsupported')
  const lifecycleScripts = parseLifecycleScripts(artifact.lifecycleScripts, 'report artifact.lifecycleScripts')
  const sha256 = optionalBareSha256(artifact.sha256, 'report artifact.sha256')
  const integrity = optionalBoundedString(artifact.integrity, 'report artifact.integrity', 1_024)
  const nodeEngine = optionalBoundedString(artifact.nodeEngine, 'report artifact.nodeEngine', 512)
  const resolutionRecord = report.resolution === undefined ? undefined : reportRecord(report.resolution, 'report resolution')
  const profileLockfile = resolutionRecord === undefined ? undefined : parseProfileLockfile(resolutionRecord.profileLockfile, 'report resolution.profileLockfile')
  const runtimeGraph = resolutionRecord === undefined ? undefined : parseRuntimeGraph(resolutionRecord.runtimeGraph, 'report resolution.runtimeGraph')
  const tool = reportRecord(report.tool, 'report tool')
  if (tool.name !== 'upstream-radar') throw new Error('report was not produced by upstream-radar')
  const observedAt = reportString(report.completedAt, 'report completedAt', 64)
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('report completedAt is not a timestamp')
  return {
    caseId: expected.id,
    targetId: expected.targetId,
    plugin,
    dshVersion,
    runtime: {
      nodeMajor: expected.nodeMajor,
      nodeVersion: runtimeNodeVersion,
      platform: reportString(runtime.platform, 'report runtime.platform', 64),
      architecture: reportString(runtime.architecture, 'report runtime.architecture', 64),
      ...(pnpmVersion === undefined ? {} : { pnpmVersion }),
    },
    staticFingerprint: expected.staticFingerprint,
    contractFingerprint: expected.contractFingerprint,
    observedAt,
    result,
    reason: reportString(report.reason, 'report reason', 4_096),
    artifact: {
      lifecycleScripts,
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(integrity === undefined ? {} : { integrity }),
      ...(nodeEngine === undefined ? {} : { nodeEngine }),
    },
    ...(profileLockfile === undefined && runtimeGraph === undefined
      ? {}
      : { resolution: {
          ...(profileLockfile === undefined ? {} : { profileLockfile }),
          ...(runtimeGraph === undefined ? {} : { runtimeGraph }),
        } }),
    observer: {
      schema: reportString(report.schema, 'report schema', 256),
      version: reportString(tool.version, 'report tool.version', 256),
    },
  }
}

function parseLifecycleBuilds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${label} must be an array of at most 16 package names`)
  const names = value.map((item, index) => reportString(item, `${label}[${index}]`, 214))
  if (names.some(name => !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))) {
    throw new Error(`${label} contains an invalid package name`)
  }
  if (new Set(names).size !== names.length) throw new Error(`${label} contains duplicate package names`)
  return names.sort()
}

function isIncompatible(result: DshInstallObservationResult): boolean {
  return result !== 'compatible'
}

function sameResolution(
  previous: DshCompatibilityLedgerEntry['resolution'],
  current: DshCompatibilityLedgerEntry['resolution'],
): boolean {
  const beforeLockfile = previous?.profileLockfile
  const afterLockfile = current?.profileLockfile
  const sameLockfile = beforeLockfile === undefined || afterLockfile === undefined
    ? beforeLockfile === afterLockfile
    // pnpm can rewrite non-semantic metadata. Prefer the canonical graph when
    // both runs established one; only fall back to raw lockfile bytes when it
    // could not be parsed.
    : beforeLockfile.graphDigest !== undefined && afterLockfile.graphDigest !== undefined
      ? beforeLockfile.graphDigest === afterLockfile.graphDigest
      : beforeLockfile.sha256 === afterLockfile.sha256
  const beforeRuntime = previous?.runtimeGraph
  const afterRuntime = current?.runtimeGraph
  const sameRuntime = beforeRuntime === undefined || afterRuntime === undefined
    ? beforeRuntime === afterRuntime
    : beforeRuntime.digest === afterRuntime.digest
  return sameLockfile && sameRuntime
}

function transition(previous: DshCompatibilityLedgerEntry | undefined, current: DshCompatibilityLedgerEntry): DshCompatibilityTransition {
  const previousIncompatible = previous !== undefined && isIncompatible(previous.result)
  const currentIncompatible = isIncompatible(current.result)
  let status: DshCompatibilityTransitionStatus
  if (previous === undefined) status = currentIncompatible ? 'new-incompatibility' : 'compatible'
  else if (previous.artifact.sha256 !== undefined && current.artifact.sha256 !== undefined && previous.artifact.sha256 !== current.artifact.sha256) status = 'artifact-drift'
  else if (previousIncompatible && !currentIncompatible) status = 'resolved-incompatibility'
  else if (!previousIncompatible && currentIncompatible) status = 'new-incompatibility'
  else if (previousIncompatible && currentIncompatible && (previous.result !== current.result || previous.reason !== current.reason)) status = 'changed-incompatibility'
  else if (currentIncompatible) status = 'persisting-incompatibility'
  else if (!sameResolution(previous.resolution, current.resolution)) status = 'resolution-drift'
  else status = 'compatible'
  return {
    caseId: current.caseId,
    status,
    result: current.result,
    reason: current.reason,
    ...(previous === undefined ? {} : { previousResult: previous.result }),
  }
}

/**
 * Merge only reports that prove they belong to a scheduled exact cell. Bad or
 * absent reports never become a green result; absent cells stay missing and
 * therefore are planned again on the next reconciliation.
 */
export function mergeDshCompatibilityLedger(input: {
  ledger: DshCompatibilityLedger
  expected: readonly DshCompatibilityExpectedCase[]
  reports: readonly unknown[]
}): DshCompatibilityLedgerMerge {
  if (input.reports.length > MAX_REPORTS) throw new Error(`compatibility reconciliation accepts at most ${MAX_REPORTS} reports`)
  const expected = parseExpectedCases(input.expected)
  const previousByCase = new Map(input.ledger.entries.map(entry => [entry.caseId, entry]))
  const nextByCase = new Map(previousByCase)
  const transitions: DshCompatibilityTransition[] = []
  const accepted = new Set<string>()
  const rejectedReports: string[] = []

  for (const [index, rawReport] of input.reports.entries()) {
    try {
      const raw = reportRecord(rawReport, `reports[${index}]`)
      const rawCaseId = caseId(raw.caseId, `reports[${index}].caseId`)
      const scheduled = expected.get(rawCaseId)
      if (scheduled === undefined) throw new Error(`report case ${rawCaseId} was not scheduled in this reconciliation`)
      if (accepted.has(rawCaseId)) throw new Error(`more than one report was supplied for scheduled case ${rawCaseId}`)
      const entry = parseObservationReport(rawReport, scheduled)
      nextByCase.set(entry.caseId, entry)
      accepted.add(entry.caseId)
      transitions.push(transition(previousByCase.get(entry.caseId), entry))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      rejectedReports.push(`report ${index + 1}: ${message.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 512)}`)
    }
  }

  const missingCaseIds = [...expected.keys()].filter(id => !accepted.has(id)).sort()
  const entries = [...nextByCase.values()].sort((left, right) => left.caseId.localeCompare(right.caseId))
  return {
    ledger: { schema: DSH_COMPATIBILITY_LEDGER_SCHEMA, entries },
    transitions: transitions.sort((left, right) => left.caseId.localeCompare(right.caseId)),
    acceptedCaseIds: [...accepted].sort(),
    missingCaseIds,
    rejectedReports: rejectedReports.sort(),
  }
}

function inline(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f`|]/g, ' ').slice(0, 512)
}

export function renderDshCompatibilityLedgerMerge(merge: DshCompatibilityLedgerMerge): string {
  const lines = [
    '## Upstream Radar — DSH compatibility ledger',
    '',
    `- Accepted isolated reports: **${merge.acceptedCaseIds.length}**`,
    `- Missing scheduled reports: **${merge.missingCaseIds.length}**`,
    `- Rejected reports: **${merge.rejectedReports.length}**`,
    `- Current active cells: **${merge.ledger.entries.length}**`,
  ]
  const actionable = merge.transitions.filter(item => item.status !== 'compatible' && item.status !== 'persisting-incompatibility')
  if (actionable.length > 0) {
    lines.push('', '### New or changed evidence', '')
    for (const item of actionable) {
      lines.push(`- \`${inline(item.caseId)}\`: **${inline(item.status)}** → \`${inline(item.result)}\` — ${inline(item.reason)}`)
    }
  }
  if (merge.missingCaseIds.length > 0) {
    lines.push('', '### Evidence still missing', '')
    for (const id of merge.missingCaseIds) lines.push(`- \`${inline(id)}\` did not return a usable report; it remains unsatisfied and will be planned again.`)
  }
  if (merge.rejectedReports.length > 0) {
    lines.push('', '### Rejected report evidence', '')
    for (const reason of merge.rejectedReports) lines.push(`- ${inline(reason)}`)
  }
  lines.push('', 'The ledger records behavior evidence for an exact plugin × DSH × runtime contract. It does not claim that third-party code is safe.', '')
  return lines.join('\n')
}
