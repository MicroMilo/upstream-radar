import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { emptyRadarState } from './radar.js'
import {
  ANALYSIS_TASK_SCHEMA,
  RADAR_EVENT_SCHEMA,
  RADAR_STATE_SCHEMA,
  type RadarState,
} from './radar-types.js'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function validAffectedSources(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return false
  const allowed = new Set(['profile', 'dsh-host'])
  return new Set(value).size === value.length && value.every(item => typeof item === 'string' && allowed.has(item))
}

function validPackageCoordinate(value: unknown): boolean {
  const coordinate = asRecord(value)
  return coordinate?.ecosystem === 'npm'
    && typeof coordinate.name === 'string' && coordinate.name.length > 0 && coordinate.name.length <= 512
    && typeof coordinate.version === 'string' && coordinate.version.length > 0 && coordinate.version.length <= 512
}

function validCompatibilityDependencyCheck(value: unknown): boolean {
  const check = asRecord(value)
  const findings = check?.findings
  if ((check?.status !== 'checked' && check?.status !== 'incomplete' && check?.status !== 'unavailable')
    || typeof check.nodeCount !== 'number' || !Number.isSafeInteger(check.nodeCount) || check.nodeCount < 0 || check.nodeCount > 1_000_000
    || typeof check.unresolvedCount !== 'number' || !Number.isSafeInteger(check.unresolvedCount) || check.unresolvedCount < 0 || check.unresolvedCount > 1_000_000
    || !Array.isArray(findings) || findings.length > 32
    || (check.error !== undefined && (typeof check.error !== 'string' || check.error.length > 2_048))) return false
  return findings.every(rawFinding => {
    const finding = asRecord(rawFinding)
    const advisory = asRecord(finding?.advisory)
    const paths = finding?.paths
    return validPackageCoordinate(finding?.package)
      && typeof advisory?.id === 'string' && advisory.id.length > 0 && advisory.id.length <= 256
      && typeof advisory.summary === 'string' && advisory.summary.length <= 8_192
      && typeof advisory.details === 'string' && advisory.details.length <= 64 * 1_024
      && (advisory.severity === 'unknown' || advisory.severity === 'info' || advisory.severity === 'low'
        || advisory.severity === 'medium' || advisory.severity === 'high' || advisory.severity === 'critical')
      && typeof advisory.modified === 'string' && advisory.modified.length <= 256
      && (advisory.published === undefined || (typeof advisory.published === 'string' && advisory.published.length <= 256))
      && (advisory.withdrawn === undefined || (typeof advisory.withdrawn === 'string' && advisory.withdrawn.length <= 256))
      && Array.isArray(advisory.aliases) && advisory.aliases.length <= 100
      && advisory.aliases.every(item => typeof item === 'string' && item.length <= 256)
      && Array.isArray(advisory.fixedVersions) && advisory.fixedVersions.length <= 128
      && advisory.fixedVersions.every(item => typeof item === 'string' && item.length <= 256)
      && Array.isArray(advisory.references) && advisory.references.length <= 100
      && advisory.references.every(item => typeof item === 'string' && item.length <= 4_096)
      && Array.isArray(paths) && paths.length <= 4
      && paths.every(path => Array.isArray(path) && path.length > 0 && path.length <= 64 && path.every(validPackageCoordinate))
  })
}

function validCompatibilityUpgradeCandidate(value: unknown): boolean {
  const candidate = asRecord(value)
  const coordinate = asRecord(candidate?.candidate)
  const signals = candidate?.signals
  const dependencyCheck = candidate?.dependencyCheck
  if (coordinate?.ecosystem !== 'npm'
    || typeof coordinate.name !== 'string' || coordinate.name.length === 0 || coordinate.name.length > 512
    || typeof coordinate.version !== 'string' || coordinate.version.length === 0 || coordinate.version.length > 512
    || !Array.isArray(signals) || signals.length > 64) return false
  if (dependencyCheck !== undefined && !validCompatibilityDependencyCheck(dependencyCheck)) return false
  return signals.every(rawSignal => {
    const signal = asRecord(rawSignal)
    return typeof signal?.code === 'string' && signal.code.length > 0 && signal.code.length <= 256
      && (signal.confidence === 'confirmed' || signal.confidence === 'strong' || signal.confidence === 'needs-analysis')
      && typeof signal.summary === 'string' && signal.summary.length <= 2_048
      && (signal.before === undefined || (typeof signal.before === 'string' && signal.before.length <= 2_048))
      && (signal.after === undefined || (typeof signal.after === 'string' && signal.after.length <= 2_048))
  })
}

function validCompatibilityUpgradePath(value: unknown): boolean {
  if (value === undefined) return true
  const path = asRecord(value)
  const evaluated = path?.evaluated
  const blockedCount = path?.blockedCount
  const blocked = path?.blocked
  const vulnerabilityStatus = path?.vulnerabilityStatus
  const dependencyStatus = path?.dependencyStatus
  const uncheckedCount = path?.uncheckedCount
  if (typeof evaluated !== 'number' || !Number.isSafeInteger(evaluated) || evaluated < 0 || evaluated > 1_000_000
    || typeof blockedCount !== 'number' || !Number.isSafeInteger(blockedCount) || blockedCount < 0 || blockedCount > evaluated
    // 0.17.0 upgrade paths did not have this field; treat those persisted paths as legacy.
    || (vulnerabilityStatus !== undefined
      && vulnerabilityStatus !== 'checked' && vulnerabilityStatus !== 'unavailable' && vulnerabilityStatus !== 'not-requested')
    || (dependencyStatus !== undefined
      && dependencyStatus !== 'checked' && dependencyStatus !== 'partial' && dependencyStatus !== 'unavailable' && dependencyStatus !== 'not-requested')
    || (uncheckedCount !== undefined
      && (typeof uncheckedCount !== 'number' || !Number.isSafeInteger(uncheckedCount) || uncheckedCount < 0 || uncheckedCount > evaluated))
    || !Array.isArray(blocked) || blocked.length > 8
    || (path?.firstCandidate !== undefined && !validCompatibilityUpgradeCandidate(path.firstCandidate))) return false
  return blocked.every(validCompatibilityUpgradeCandidate)
}

export function parseRadarState(value: unknown): RadarState {
  const root = asRecord(value)
  if (root?.schema !== RADAR_STATE_SCHEMA) throw new Error('radar state has an unsupported schema')
  const active = asRecord(root.activeVulnerabilities)
  if (active === undefined) throw new Error('radar state has no active vulnerability map')
  const activeCompatibility = asRecord(root.activeCompatibility)
  if (activeCompatibility === undefined) throw new Error('radar state has no active compatibility map')
  const sourceHealth = root.sourceHealth === undefined ? {} : asRecord(root.sourceHealth)
  if (sourceHealth === undefined) throw new Error('radar state has an invalid source health map')
  const activeSourceHealth = root.activeSourceHealth === undefined ? {} : asRecord(root.activeSourceHealth)
  if (activeSourceHealth === undefined) throw new Error('radar state has an invalid active source health map')
  if (Object.keys(sourceHealth).length > 10 || Object.keys(activeSourceHealth).length > 1_000_000) {
    throw new Error('radar state exceeds the source health limit')
  }
  const sourceNames = new Set(['osv', 'npm-releases', 'npm-candidate-graphs', 'github-releases'])
  for (const [source, rawStatus] of Object.entries(sourceHealth)) {
    const status = asRecord(rawStatus)
    const failures = status?.consecutiveFailures
    if (!sourceNames.has(source)
      || typeof status?.lastAttemptedAt !== 'string'
      || typeof failures !== 'number' || !Number.isSafeInteger(failures)
      || failures < 0 || failures > 1_000_000
      || (status.lastSucceededAt !== undefined && typeof status.lastSucceededAt !== 'string')
      || (status.lastError !== undefined
        && (typeof status.lastError !== 'string' || status.lastError.length > 2_048))) {
      throw new Error(`radar state contains an invalid source health status: ${source}`)
    }
  }
  if (!Array.isArray(root.pendingAnalysisTasks) || root.pendingAnalysisTasks.length > 100_000) {
    throw new Error('radar state has an invalid pending analysis queue')
  }
  for (const rawTask of root.pendingAnalysisTasks) {
    const task = asRecord(rawTask)
    const event = asRecord(task?.event)
    if (task?.schema !== ANALYSIS_TASK_SCHEMA || typeof task.id !== 'string'
      || typeof task.createdAt !== 'string' || event?.schema !== RADAR_EVENT_SCHEMA
      || typeof event.id !== 'string' || typeof event.incidentId !== 'string'
      || (event.kind !== 'vulnerability' && event.kind !== 'malware' && event.kind !== 'compatibility' && event.kind !== 'source-health')) {
      throw new Error('radar state contains an invalid pending analysis task')
    }
    if (!validAffectedSources(event.affectedSources)) throw new Error('radar state contains invalid affected package origins')
    if (!validCompatibilityUpgradePath(event.upgradePath)) throw new Error('radar state contains an invalid compatibility upgrade path')
  }
  if (Object.keys(active).length > 1_000_000) throw new Error('radar state exceeds the active match limit')
  if (Object.keys(activeCompatibility).length > 1_000_000) {
    throw new Error('radar state exceeds the active compatibility limit')
  }
  for (const [key, rawStored] of Object.entries(active)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    const advisory = asRecord(event?.advisory)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA || typeof event.incidentId !== 'string'
      || (event.kind !== 'vulnerability' && event.kind !== 'malware')
      || typeof advisory?.id !== 'string' || typeof advisory.modified !== 'string'
      || !validAffectedSources(event.affectedSources)) {
      throw new Error(`radar state contains an invalid active match: ${key.slice(0, 256)}`)
    }
  }
  for (const [key, rawStored] of Object.entries(activeCompatibility)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA
      || event.kind !== 'compatibility' || event.incidentId !== key
      || !validCompatibilityUpgradePath(event.upgradePath)) {
      throw new Error(`radar state contains an invalid compatibility match: ${key.slice(0, 256)}`)
    }
  }
  for (const [key, rawStored] of Object.entries(activeSourceHealth)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA
      || event.kind !== 'source-health' || event.incidentId !== key
      || !sourceNames.has(typeof event.source === 'string' ? event.source : '')) {
      throw new Error(`radar state contains an invalid source health match: ${key.slice(0, 256)}`)
    }
  }
  return structuredClone(value) as RadarState
}

export async function loadRadarState(path: string): Promise<RadarState> {
  try {
    const contents = await readFile(resolve(path), 'utf8')
    if (Buffer.byteLength(contents) > 256 * 1024 * 1024) throw new Error('radar state exceeds the file size limit')
    return parseRadarState(JSON.parse(contents) as unknown)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRadarState()
    if (error instanceof SyntaxError) throw new Error('radar state is not valid JSON')
    throw error
  }
}

export async function saveRadarState(path: string, state: RadarState): Promise<void> {
  const destination = resolve(path)
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
