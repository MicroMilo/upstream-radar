import { createHash } from 'node:crypto'
import { createAnalysisTask } from './dsh-analysis.js'
import { assessCompatibilityChanges } from './compatibility.js'
import { findDependencyPaths } from './graph.js'
import type { ReleaseNotes, ReleaseNotesSource } from './github-release.js'
import { MAX_CANDIDATE_GRAPHS } from './npm-candidate.js'
import type { NpmReleaseObservation } from './npm-release.js'
import { compareSemverValues } from './semver.js'
import { packageKey } from './osv.js'
import {
  RADAR_EVENT_SCHEMA,
  MAX_RADAR_HISTORY_EVENTS,
  RADAR_STATE_SCHEMA,
  type AdvisoryConflict,
  type AdvisoryConflictClaim,
  type AdvisoryConflictField,
  type AdvisoryMatch,
  type AdvisoryRiskSignals,
  type AdvisorySourceName,
  type AnalysisTask,
  type CandidateDependencyGraphObservation,
  type CompatibilityDependencyCheck,
  type CompatibilityDependencyFinding,
  type CompatibilityDependencyStatus,
  type DependencySource,
  type DependencyGraph,
  type EventRoute,
  type PackageCoordinate,
  type ProjectInventory,
  type RadarEvent,
  type RadarSeverity,
  type RadarSource,
  type RadarState,
  type ThreatIntelSourceName,
  type SourceHealthEvent,
  type SourceHealthStatus,
  type StoredCompatibilityMatch,
  type StoredSourceHealthMatch,
  type StoredVulnerabilityMatch,
  type VulnerabilityAdvisory,
  type VulnerabilityEvent,
} from './radar-types.js'
import type { ThreatIntelSourceBinding } from './threat-intel.js'

export interface AdvisorySource {
  query(packages: readonly PackageCoordinate[]): Promise<Map<string, AdvisoryMatch[]>>
}

export interface AdvisorySourceBinding {
  /** The source name is persisted in source-health state and source errors. */
  name: Extract<RadarSource, 'osv' | 'github-advisories'>
  source: AdvisorySource
}

export interface ReleaseSource {
  query(packages: readonly PackageCoordinate[]): Promise<Map<string, NpmReleaseObservation>>
}

export interface CandidateDependencySource {
  query(packages: readonly PackageCoordinate[]): Promise<Map<string, CandidateDependencyGraphObservation>>
}

export interface RadarPollResult {
  checkedAt: string
  packagesQueried: number
  releasePackagesQueried: number
  events: RadarEvent[]
  analysisTasks: AnalysisTask[]
  sourceErrors: Array<{ source: RadarSource; message: string }>
  state: RadarState
}

const SOURCE_FAILURE_ALERT_THRESHOLD = 3
const MAX_CANDIDATE_VULNERABILITY_QUERY = 50_000
const MAX_DEEP_CANDIDATES_PER_STREAM = 4
const MAX_CANDIDATE_DEPENDENCY_QUERY = 50_000
const MAX_CANDIDATE_DEPENDENCY_FINDINGS = 32
const MAX_CANDIDATE_DEPENDENCY_PATHS = 4
const MAX_VULNERABILITY_PATHS = 64

type CandidateVulnerabilityStatus = 'checked' | 'unavailable' | 'not-requested'

type AdvisorySourceOutcome = {
  succeeded: boolean
  message?: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function route(inventory: ProjectInventory): EventRoute {
  return {
    ...(inventory.project.owner === undefined ? {} : { owner: inventory.project.owner }),
    channels: inventory.project.channels === undefined || inventory.project.channels.length === 0
      ? ['stdout']
      : [...inventory.project.channels],
  }
}

function coordinate(name: string, version: string): PackageCoordinate {
  return { ecosystem: 'npm', name, version }
}

function matchKey(
  inventory: ProjectInventory,
  plugin: PackageCoordinate,
  affected: PackageCoordinate,
  advisoryId: string,
  scope: 'plugin' | 'dsh-host' = 'plugin',
): string {
  return [inventory.project.id, scope === 'dsh-host' ? 'dsh-host' : packageKey(plugin), packageKey(affected), advisoryId].join('\0')
}

function hostMatchKey(projectId: string, affected: PackageCoordinate, advisoryId: string): string {
  return [projectId, 'dsh-host', packageKey(affected), advisoryId].join('\0')
}

function eventId(key: string, change: VulnerabilityEvent['change'], detectedAt: string, modified: string): string {
  return `event-${hash(`${key}\0${change}\0${detectedAt}\0${modified}`)}`
}

function eventChanged(previous: VulnerabilityEvent, current: VulnerabilityEvent): boolean {
  return JSON.stringify(previous.plugin) !== JSON.stringify(current.plugin)
    || JSON.stringify(previous.affectedPlugins) !== JSON.stringify(current.affectedPlugins)
    || JSON.stringify(previous.advisory) !== JSON.stringify(current.advisory)
    || JSON.stringify(previous.paths) !== JSON.stringify(current.paths)
    || JSON.stringify(previous.affectedSources) !== JSON.stringify(current.affectedSources)
    || JSON.stringify(previous.route) !== JSON.stringify(current.route)
}

function compatibilityEventChanged(previous: RadarEvent, current: RadarEvent): boolean {
  if (previous.kind !== 'compatibility' || current.kind !== 'compatibility') return true
  return JSON.stringify(previous.project) !== JSON.stringify(current.project)
    || JSON.stringify(previous.route) !== JSON.stringify(current.route)
    || JSON.stringify(previous.plugin) !== JSON.stringify(current.plugin)
    || JSON.stringify(previous.installed) !== JSON.stringify(current.installed)
    || JSON.stringify(previous.candidate) !== JSON.stringify(current.candidate)
    || JSON.stringify(previous.signals) !== JSON.stringify(current.signals)
    || JSON.stringify(previous.upgradePath) !== JSON.stringify(current.upgradePath)
    || previous.releaseNotes !== current.releaseNotes
    || previous.releaseNotesUrl !== current.releaseNotesUrl
}

type ReleaseCandidateStatus = 'newer' | 'same' | 'older' | 'uncomparable'

function releaseCandidateStatus(observation: NpmReleaseObservation): ReleaseCandidateStatus {
  if (observation.candidateStatus !== undefined) return observation.candidateStatus
  const comparison = compareSemverValues(observation.candidate.version, observation.installed.version)
  if (comparison === undefined) return 'uncomparable'
  if (comparison > 0) return 'newer'
  if (comparison < 0) return 'older'
  return 'same'
}

function candidateAdvisories(
  observation: NpmReleaseObservation,
  matches: ReadonlyMap<string, AdvisoryMatch[]>,
): ReadonlyMap<string, readonly VulnerabilityAdvisory[]> {
  const result = new Map<string, readonly VulnerabilityAdvisory[]>()
  for (const candidate of observation.upgradeCandidates ?? []) {
    const item = coordinate(candidate.name, candidate.version)
    result.set(packageKey(item), (matches.get(packageKey(item)) ?? []).map(match => match.advisory))
  }
  return result
}

function candidatePackages(releases: ReadonlyMap<string, NpmReleaseObservation>): PackageCoordinate[] {
  const result = new Map<string, PackageCoordinate>()
  for (const observation of releases.values()) {
    if (releaseCandidateStatus(observation) !== 'newer') continue
    for (const candidate of observation.upgradeCandidates ?? []) {
      const item = coordinate(candidate.name, candidate.version)
      result.set(packageKey(item), item)
    }
  }
  return [...result.values()]
}

function candidateGraphPackages(releases: ReadonlyMap<string, NpmReleaseObservation>): PackageCoordinate[] {
  const result = new Map<string, PackageCoordinate>()
  for (const observation of releases.values()) {
    if (releaseCandidateStatus(observation) !== 'newer') continue
    for (const candidate of (observation.upgradeCandidates ?? []).slice(0, MAX_DEEP_CANDIDATES_PER_STREAM)) {
      const item = coordinate(candidate.name, candidate.version)
      result.set(packageKey(item), item)
    }
  }
  return [...result.values()]
}

function candidateDependencyStatus(
  observation: NpmReleaseObservation,
  checks: ReadonlyMap<string, CompatibilityDependencyCheck>,
  requested: boolean,
): CompatibilityDependencyStatus {
  if (!requested || observation.upgradeCandidates === undefined || observation.upgradeCandidates.length === 0) {
    return 'not-requested'
  }
  const selected = observation.upgradeCandidates.slice(0, MAX_DEEP_CANDIDATES_PER_STREAM)
  const selectedChecks = selected.map(candidate => checks.get(packageKey(coordinate(candidate.name, candidate.version))))
  if (selectedChecks.some(check => check === undefined || check.status === 'unavailable')) {
    return 'unavailable'
  }
  return observation.upgradeCandidates.length > selected.length || selectedChecks.some(check => check?.status === 'incomplete')
    ? 'partial'
    : 'checked'
}

function findingKey(item: CompatibilityDependencyFinding): string {
  return `${packageKey(item.package)}\0${item.advisory.id}`
}

function collectCandidateDependencyFindings(
  graph: DependencyGraph,
  matches: ReadonlyMap<string, AdvisoryMatch[]>,
): { findings: CompatibilityDependencyFinding[]; findingsTruncated: boolean } {
  const grouped = new Map<string, CompatibilityDependencyFinding>()
  for (const node of graph.nodes) {
    const affected = coordinate(node.name, node.version)
    const paths = findDependencyPaths(graph, node.id, {
      maxPaths: MAX_CANDIDATE_DEPENDENCY_PATHS,
      maxDepth: 64,
    }).map(path => path.map(item => coordinate(item.name, item.version)))
    if (paths.length === 0) continue
    for (const match of matches.get(packageKey(affected)) ?? []) {
      const finding: CompatibilityDependencyFinding = {
        package: { ...match.package },
        advisory: { ...match.advisory },
        paths: paths.map(path => [...path]),
      }
      const key = findingKey(finding)
      const existing = grouped.get(key)
      if (existing === undefined) {
        grouped.set(key, finding)
        continue
      }
      const known = new Set(existing.paths.map(path => JSON.stringify(path)))
      for (const path of finding.paths) {
        const serialized = JSON.stringify(path)
        if (known.has(serialized) || existing.paths.length >= MAX_CANDIDATE_DEPENDENCY_PATHS) continue
        existing.paths.push(path)
        known.add(serialized)
      }
    }
  }
  const ordered = [...grouped.values()]
    .sort((left, right) => findingKey(left).localeCompare(findingKey(right)))
  return {
    findings: ordered.slice(0, MAX_CANDIDATE_DEPENDENCY_FINDINGS),
    findingsTruncated: ordered.length > MAX_CANDIDATE_DEPENDENCY_FINDINGS,
  }
}

function candidateDependencyCheck(
  observation: CandidateDependencyGraphObservation | undefined,
): CompatibilityDependencyCheck {
  const status = observation === undefined || observation.graph === undefined
    ? 'unavailable' as const
    : observation.status
  return {
    status,
    nodeCount: observation?.graph?.nodes.length ?? 0,
    unresolvedCount: observation?.graph?.unresolved?.length ?? 0,
    findings: [],
    ...(observation?.error === undefined ? {} : { error: observation.error }),
  }
}

function sourceHealthKey(projectId: string, source: RadarSource): string {
  return `${projectId}\0${source}`
}

function sourceHealthEventId(
  key: string,
  change: SourceHealthEvent['change'],
  detectedAt: string,
  status: SourceHealthStatus,
): string {
  return `event-${hash(`${key}\0${change}\0${detectedAt}\0${status.consecutiveFailures}\0${status.lastError ?? ''}`)}`
}

function recordSourceHealth(
  previous: Record<string, SourceHealthStatus>,
  source: RadarSource,
  attemptedAt: string,
  succeeded: boolean,
  error?: string,
): Record<string, SourceHealthStatus> {
  const current = previous[source]
  const next: SourceHealthStatus = succeeded
    ? {
        lastAttemptedAt: attemptedAt,
        lastSucceededAt: attemptedAt,
        consecutiveFailures: 0,
      }
    : {
        lastAttemptedAt: attemptedAt,
        consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
        ...(current?.lastSucceededAt === undefined ? {} : { lastSucceededAt: current.lastSucceededAt }),
        ...(error === undefined ? {} : { lastError: error }),
      }
  return { ...previous, [source]: next }
}

function sourceHealthEventChanged(previous: SourceHealthEvent, current: SourceHealthEvent): boolean {
  return JSON.stringify(previous.project) !== JSON.stringify(current.project)
    || JSON.stringify(previous.route) !== JSON.stringify(current.route)
    || previous.source !== current.source
    || previous.status !== current.status
    || previous.error !== current.error
}

function createSourceHealthEvent(
  inventory: ProjectInventory,
  source: RadarSource,
  status: 'degraded' | 'healthy',
  change: SourceHealthEvent['change'],
  detectedAt: string,
  health: SourceHealthStatus,
): SourceHealthEvent {
  const key = sourceHealthKey(inventory.project.id, source)
  return {
    schema: RADAR_EVENT_SCHEMA,
    id: sourceHealthEventId(key, change, detectedAt, health),
    incidentId: key,
    kind: 'source-health',
    change,
    detectedAt,
    project: { ...inventory.project },
    route: route(inventory),
    source,
    status,
    failureCount: health.consecutiveFailures,
    lastAttemptedAt: health.lastAttemptedAt,
    ...(health.lastSucceededAt === undefined ? {} : { lastSucceededAt: health.lastSucceededAt }),
    ...(health.lastError === undefined ? {} : { error: health.lastError }),
  }
}

export function emptyRadarState(): RadarState {
  return {
    schema: RADAR_STATE_SCHEMA,
    activeVulnerabilities: {},
    activeCompatibility: {},
    pendingAnalysisTasks: [],
    analysisDeliveries: {},
    analysisResults: {},
    sourceHealth: {},
    activeSourceHealth: {},
    history: [],
  }
}

function severityRank(value: RadarSeverity): number {
  switch (value) {
    case 'critical': return 6
    case 'high': return 5
    case 'medium': return 4
    case 'low': return 3
    case 'info': return 2
    case 'unknown': return 1
  }
}

function advisoryIdentities(advisory: VulnerabilityAdvisory): Set<string> {
  return new Set([advisory.id, ...advisory.aliases].map(value => value.trim().toUpperCase()).filter(Boolean))
}

function advisoriesOverlap(left: VulnerabilityAdvisory, right: VulnerabilityAdvisory): boolean {
  const rightIdentities = advisoryIdentities(right)
  return [...advisoryIdentities(left)].some(identity => rightIdentities.has(identity))
}

function vulnerabilityScope(event: VulnerabilityEvent): string {
  return event.affectedSources?.includes('dsh-host') === true
    ? 'dsh-host'
    : packageKey(event.plugin)
}

/**
 * When only some advisory sources answered, keep the old incident identity for
 * an overlapping finding. This prevents a transient outage from creating a
 * duplicate event or temporarily dropping metadata supplied by the failed
 * source. A fully successful poll is still allowed to remove that source's
 * evidence when it explicitly returns no matching advisory.
 */
function previousPartialVulnerability(
  event: VulnerabilityEvent,
  previous: Readonly<Record<string, StoredVulnerabilityMatch>>,
): [key: string, match: StoredVulnerabilityMatch] | undefined {
  return Object.entries(previous)
    .filter(([, item]) => item.event.kind === event.kind
      && item.event.project.id === event.project.id
      && packageKey(item.event.affected) === packageKey(event.affected)
      && vulnerabilityScope(item.event) === vulnerabilityScope(event)
      && advisoriesOverlap(item.event.advisory, event.advisory))
    .sort(([left], [right]) => left.localeCompare(right))[0]
}

const ADVISORY_SOURCE_ORDER: readonly AdvisorySourceName[] = ['osv', 'github-advisories']

function advisorySources(advisory: VulnerabilityAdvisory): AdvisorySourceName[] {
  return ADVISORY_SOURCE_ORDER.filter(source => advisory.sources?.includes(source) === true)
}

function addAdvisorySource(advisory: VulnerabilityAdvisory, source: AdvisorySourceName): VulnerabilityAdvisory {
  const sources = new Set([...advisorySources(advisory), source])
  return {
    ...advisory,
    sources: ADVISORY_SOURCE_ORDER.filter(item => sources.has(item)),
  }
}

function mergeRiskSignals(
  left: AdvisoryRiskSignals | undefined,
  right: AdvisoryRiskSignals | undefined,
): AdvisoryRiskSignals | undefined {
  const cisaKev = right?.cisaKev ?? left?.cisaKev
  const epss = right?.epss ?? left?.epss
  if (cisaKev === undefined && epss === undefined) return undefined
  return {
    ...(cisaKev === undefined ? {} : { cisaKev: { ...cisaKev } }),
    ...(epss === undefined ? {} : { epss: { ...epss } }),
  }
}

function preserveRiskSignals(
  previous: VulnerabilityAdvisory,
  current: VulnerabilityAdvisory,
): VulnerabilityAdvisory {
  const riskSignals = mergeRiskSignals(previous.riskSignals, current.riskSignals)
  return riskSignals === undefined ? current : { ...current, riskSignals }
}

function advisoryClaimValue(advisory: VulnerabilityAdvisory, field: AdvisoryConflictField): string {
  if (field === 'severity') return advisory.severity
  const fixedVersions = [...new Set(advisory.fixedVersions)].sort()
  return fixedVersions.length === 0 ? '(none published)' : fixedVersions.join(', ')
}

function sourceClaims(advisory: VulnerabilityAdvisory, field: AdvisoryConflictField): AdvisoryConflictClaim[] {
  return advisorySources(advisory).map(source => ({
    source,
    value: advisoryClaimValue(advisory, field),
  }))
}

function mergeAdvisoryConflicts(
  left: VulnerabilityAdvisory,
  right: VulnerabilityAdvisory,
): AdvisoryConflict[] {
  const byField = new Map<AdvisoryConflictField, Map<AdvisorySourceName, string>>()
  const addClaims = (field: AdvisoryConflictField, claims: readonly AdvisoryConflictClaim[]) => {
    const bySource = byField.get(field) ?? new Map<AdvisorySourceName, string>()
    for (const claim of claims) bySource.set(claim.source, claim.value)
    byField.set(field, bySource)
  }
  for (const field of ['severity', 'fixed-versions'] as const) {
    const existingClaims = [
      ...(left.conflicts?.find(item => item.field === field)?.claims ?? []),
      ...(right.conflicts?.find(item => item.field === field)?.claims ?? []),
    ]
    addClaims(field, existingClaims)
    const knownSources = new Set(existingClaims.map(claim => claim.source))
    addClaims(field, sourceClaims(left, field).filter(claim => !knownSources.has(claim.source)))
    addClaims(field, sourceClaims(right, field).filter(claim => !knownSources.has(claim.source)))
  }
  return (['severity', 'fixed-versions'] as const).flatMap(field => {
    const claims = [...(byField.get(field)?.entries() ?? [])]
      .map(([source, value]) => ({ source, value }))
      .sort((leftClaim, rightClaim) => (
        ADVISORY_SOURCE_ORDER.indexOf(leftClaim.source) - ADVISORY_SOURCE_ORDER.indexOf(rightClaim.source)
      ))
    const comparable = field === 'severity'
      ? claims.filter(claim => claim.value !== 'unknown')
      : claims
    const values = new Set(comparable.map(claim => claim.value))
    return values.size <= 1 ? [] : [{ field, claims }]
  })
}

/** Merge one source's richer metadata without allowing a lower severity to hide a higher one. */
function mergeAdvisory(left: VulnerabilityAdvisory, right: VulnerabilityAdvisory): VulnerabilityAdvisory {
  const aliases = new Set([...left.aliases, ...right.aliases, right.id])
  aliases.delete(left.id)
  const fixedVersions = new Set([...left.fixedVersions, ...right.fixedVersions])
  const references = new Set([...left.references, ...right.references])
  const sources = new Set([...advisorySources(left), ...advisorySources(right)])
  const conflicts = mergeAdvisoryConflicts(left, right)
  return {
    id: left.id,
    aliases: [...aliases].sort(),
    summary: left.summary === '(no summary supplied)' ? right.summary : left.summary,
    details: left.details.length === 0 ? right.details : left.details,
    severity: severityRank(left.severity) >= severityRank(right.severity) ? left.severity : right.severity,
    ...(left.published === undefined ? right.published === undefined ? {} : { published: right.published } : { published: left.published }),
    modified: left.modified >= right.modified ? left.modified : right.modified,
    ...(left.withdrawn === undefined ? right.withdrawn === undefined ? {} : { withdrawn: right.withdrawn } : { withdrawn: left.withdrawn }),
    fixedVersions: [...fixedVersions].sort(),
    references: [...references].slice(0, 100),
    ...(sources.size === 0 ? {} : { sources: ADVISORY_SOURCE_ORDER.filter(source => sources.has(source)) }),
    ...(conflicts.length === 0 ? {} : { conflicts }),
  }
}

function mergeAdvisoryMatches(
  sources: readonly { name: AdvisorySourceName; matches: Map<string, AdvisoryMatch[]> }[],
): Map<string, AdvisoryMatch[]> {
  const grouped = new Map<string, AdvisoryMatch[][]>()
  for (const source of sources) {
    for (const [key, matches] of source.matches) {
      const groups = grouped.get(key) ?? []
      for (const match of matches) {
        const sourcedMatch: AdvisoryMatch = {
          package: { ...match.package },
          advisory: addAdvisorySource(match.advisory, source.name),
        }
        const overlapping = groups.filter(group => group.some(existing => advisoriesOverlap(existing.advisory, sourcedMatch.advisory)))
        if (overlapping.length === 0) {
          groups.push([sourcedMatch])
          continue
        }
        // Keep the first source's identifier as the durable primary key. The
        // later source contributes aliases and metadata instead of renaming an
        // already-known incident on every poll.
        const combined = [...overlapping.flat(), sourcedMatch]
        const first = combined[0]
        if (first === undefined) continue
        const mergedAdvisory = combined.slice(1).reduce(
          (current, item) => mergeAdvisory(current, item.advisory),
          first.advisory,
        )
        const merged: AdvisoryMatch = {
          package: { ...first.package },
          advisory: mergedAdvisory,
        }
        for (const group of overlapping) {
          const index = groups.indexOf(group)
          if (index >= 0) groups.splice(index, 1)
        }
        groups.push([merged])
      }
      grouped.set(key, groups)
    }
  }
  return new Map([...grouped.entries()].map(([key, groups]) => [
    key,
    groups.map(group => group[0]).filter((match): match is AdvisoryMatch => match !== undefined)
      .sort((left, right) => left.advisory.id.localeCompare(right.advisory.id)),
  ]))
}

/** Query exact installed versions, calculate affected paths, and emit state transitions only. */
export async function pollRadar(
  inventories: readonly ProjectInventory[],
  previousState: RadarState,
  source: AdvisorySource,
  now = new Date(),
  releaseSource?: ReleaseSource,
  releaseNotesSource?: ReleaseNotesSource,
  candidateDependencySource?: CandidateDependencySource,
  additionalAdvisorySources: readonly AdvisorySourceBinding[] = [],
  additionalThreatIntelSources: readonly ThreatIntelSourceBinding[] = [],
): Promise<RadarPollResult> {
  if (previousState.schema !== RADAR_STATE_SCHEMA) throw new Error('unsupported radar state schema')
  if (!Number.isFinite(now.getTime())) throw new Error('radar check time is invalid')
  const checkedAt = now.toISOString()
  const sourceErrors: RadarPollResult['sourceErrors'] = []
  const attemptedSources = new Set<RadarSource>()
  let sourceHealth = { ...(previousState.sourceHealth ?? {}) }

  const uniquePackages = new Map<string, PackageCoordinate>()
  for (const inventory of inventories) {
    for (const plugin of inventory.plugins) {
      for (const node of plugin.graph.nodes) {
        const item = coordinate(node.name, node.version)
        uniquePackages.set(packageKey(item), item)
      }
      const hostRuntimePackage = plugin.graph.hostRuntime?.package
      if (hostRuntimePackage !== undefined) {
        uniquePackages.set(packageKey(hostRuntimePackage), hostRuntimePackage)
      }
    }
  }
  const advisoryBindings: AdvisorySourceBinding[] = [
    { name: 'osv', source },
    ...additionalAdvisorySources,
  ]
  const bindingNames = new Set<string>()
  for (const binding of advisoryBindings) {
    if (bindingNames.has(binding.name)) throw new Error(`duplicate advisory source binding: ${binding.name}`)
    bindingNames.add(binding.name)
  }
  const advisoryResults: Array<{ binding: AdvisorySourceBinding; matches: Map<string, AdvisoryMatch[]> }> = []
  const advisoryOutcomes = new Map<AdvisorySourceBinding['name'], AdvisorySourceOutcome>()
  for (const binding of advisoryBindings) {
    attemptedSources.add(binding.name)
    try {
      const queried = await binding.source.query([...uniquePackages.values()])
      if ([...uniquePackages.keys()].some(key => !queried.has(key))) {
        throw new Error(`${binding.name} response does not cover every submitted package version`)
      }
      advisoryResults.push({ binding, matches: queried })
      advisoryOutcomes.set(binding.name, { succeeded: true })
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error)
      const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
      sourceErrors.push({ source: binding.name, message })
      advisoryOutcomes.set(binding.name, { succeeded: false, message })
    }
  }
  const mergedMatches = mergeAdvisoryMatches(advisoryResults.map(item => ({
    name: item.binding.name,
    matches: item.matches,
  })))
  const threatIntelAdvisories = [...new Map(
    [...mergedMatches.values()].flatMap(items => items.map(item => [item.advisory.id, item.advisory] as const)),
  ).values()]
  const threatIntelBindings = [...additionalThreatIntelSources]
  const threatIntelBindingNames = new Set<ThreatIntelSourceName>()
  const threatIntelResults = new Map<string, AdvisoryRiskSignals>()
  const threatIntelOutcomes = new Map<ThreatIntelSourceName, AdvisorySourceOutcome>()
  for (const binding of threatIntelBindings) {
    if (threatIntelBindingNames.has(binding.name)) throw new Error(`duplicate threat-intel source binding: ${binding.name}`)
    threatIntelBindingNames.add(binding.name)
    attemptedSources.add(binding.name)
    try {
      const queried = await binding.source.query(threatIntelAdvisories)
      if (threatIntelAdvisories.some(advisory => !queried.has(advisory.id))) {
        throw new Error(`${binding.name} response does not cover every submitted advisory`)
      }
      for (const advisory of threatIntelAdvisories) {
        const signals = queried.get(advisory.id)
        if (signals === undefined) continue
        const merged = mergeRiskSignals(threatIntelResults.get(advisory.id), signals)
        if (merged !== undefined) threatIntelResults.set(advisory.id, merged)
      }
      threatIntelOutcomes.set(binding.name, { succeeded: true })
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error)
      const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
      sourceErrors.push({ source: binding.name, message })
      threatIntelOutcomes.set(binding.name, { succeeded: false, message })
    }
  }
  const matches = new Map([...mergedMatches.entries()].map(([key, items]) => [
    key,
    items.map(item => {
      const riskSignals = threatIntelResults.get(item.advisory.id)
      return {
        package: { ...item.package },
        advisory: riskSignals === undefined
          ? { ...item.advisory }
          : { ...item.advisory, riskSignals },
      }
    }),
  ]))
  const vulnerabilityQuerySucceeded = advisoryResults.length > 0
  const vulnerabilityCheckSucceeded = advisoryBindings.every(binding => advisoryOutcomes.get(binding.name)?.succeeded === true)
  const threatIntelCheckSucceeded = threatIntelBindings.every(binding => threatIntelOutcomes.get(binding.name)?.succeeded === true)
  const current = vulnerabilityCheckSucceeded
    ? new Map<string, StoredVulnerabilityMatch>()
    : new Map(Object.entries(previousState.activeVulnerabilities))
  if (vulnerabilityQuerySucceeded) {
    for (const inventory of inventories) {
      // A DSH profile can load several plugins into one shared host-runtime
      // plane. Group those observations at the project level so one vulnerable
      // Cordis/DSH package does not become one alert per plugin.
      const groupedPaths = new Map<string, PackageCoordinate[][]>()
      const groupedMatch = new Map<string, AdvisoryMatch>()
      const groupedSources = new Map<string, Set<DependencySource>>()
      const groupedPlugins = new Map<string, Map<string, PackageCoordinate>>()
      const primaryPlugins = new Map<string, PackageCoordinate>()
      for (const plugin of inventory.plugins) {
        const hostRuntimePackage = plugin.graph.hostRuntime?.package
        const hasHostRuntimeNode = hostRuntimePackage !== undefined
          && plugin.graph.nodes.some(node => (
            node.name === hostRuntimePackage.name
            && node.version === hostRuntimePackage.version
            && node.source === 'dsh-host'
          ))
        const monitoredNodes = hostRuntimePackage === undefined || hasHostRuntimeNode
          ? plugin.graph.nodes.map(node => ({ node, hostRuntimeBoundary: false }))
          : [
              ...plugin.graph.nodes.map(node => ({ node, hostRuntimeBoundary: false })),
              // The DSH executable is a runtime boundary, not a dependency edge
              // in the plugin graph. Keep it as a synthetic observation so its
              // direct advisory can still be routed without inventing topology.
              {
                node: {
                  id: `dsh-host/runtime/${hostRuntimePackage.name}@${hostRuntimePackage.version}`,
                  name: hostRuntimePackage.name,
                  version: hostRuntimePackage.version,
                  source: 'dsh-host' as const,
                },
                hostRuntimeBoundary: true,
              },
            ]
        for (const { node, hostRuntimeBoundary } of monitoredNodes) {
          const affected = coordinate(node.name, node.version)
          for (const match of matches.get(packageKey(affected)) ?? []) {
            const hostRuntimeScoped = hostRuntimeBoundary || node.source === 'dsh-host'
            const key = matchKey(
              inventory,
              plugin.package,
              affected,
              match.advisory.id,
              hostRuntimeScoped ? 'dsh-host' : 'plugin',
            )
            const paths = hostRuntimeBoundary
              ? [[affected]]
              : findDependencyPaths(plugin.graph, node.id).map(path => (
                  path.map(item => coordinate(item.name, item.version))
                ))
            if (paths.length === 0) continue
            const existing = groupedPaths.get(key) ?? []
            const known = new Set(existing.map(path => JSON.stringify(path)))
            for (const path of paths) {
              if (existing.length >= MAX_VULNERABILITY_PATHS) break
              const serialized = JSON.stringify(path)
              if (!known.has(serialized)) {
                existing.push(path)
                known.add(serialized)
              }
            }
            groupedPaths.set(key, existing)
            groupedMatch.set(key, match)
            primaryPlugins.set(key, primaryPlugins.get(key) ?? plugin.package)
            if (hostRuntimeScoped) {
              const affectedPlugins = groupedPlugins.get(key) ?? new Map<string, PackageCoordinate>()
              affectedPlugins.set(packageKey(plugin.package), plugin.package)
              groupedPlugins.set(key, affectedPlugins)
            }
            if (node.source !== undefined) {
              const sources = groupedSources.get(key) ?? new Set<DependencySource>()
              sources.add(node.source)
              groupedSources.set(key, sources)
            }
          }
        }
      }
      for (const [key, paths] of groupedPaths) {
        const match = groupedMatch.get(key)
        paths.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        const sourceSet = groupedSources.get(key)
        const orderedSources: readonly DependencySource[] = ['profile', 'dsh-host']
        const affectedSources = orderedSources.filter(source => sourceSet?.has(source) ?? false)
        const affectedPlugins = [...(groupedPlugins.get(key)?.values() ?? [])]
          .sort((left, right) => packageKey(left).localeCompare(packageKey(right)))
        const primaryPlugin = affectedPlugins[0] ?? primaryPlugins.get(key)
        if (match === undefined || primaryPlugin === undefined) continue
        const event: VulnerabilityEvent = {
          schema: RADAR_EVENT_SCHEMA,
          id: eventId(key, 'new', checkedAt, match.advisory.modified),
          incidentId: `incident-${hash(key)}`,
          kind: match.advisory.id.startsWith('MAL-') ? 'malware' : 'vulnerability',
          change: 'new',
          detectedAt: checkedAt,
          project: { ...inventory.project },
          route: route(inventory),
          plugin: { ...primaryPlugin },
          ...(affectedPlugins.length > 1
            ? { affectedPlugins: affectedPlugins.map(item => ({ ...item })) }
            : {}),
          affected: { ...match.package },
          ...(affectedSources.length === 0 ? {} : { affectedSources }),
          paths,
          advisory: { ...match.advisory },
        }
        if (!vulnerabilityCheckSucceeded || !threatIntelCheckSucceeded) {
          const previous = previousPartialVulnerability(event, previousState.activeVulnerabilities)
          if (previous !== undefined) {
            const mergedAdvisory = mergeAdvisory(previous[1].event.advisory, event.advisory)
            const stableEvent: VulnerabilityEvent = {
              ...event,
              incidentId: previous[1].event.incidentId,
              advisory: threatIntelCheckSucceeded
                ? mergedAdvisory
                : preserveRiskSignals(previous[1].event.advisory, mergedAdvisory),
            }
            current.set(previous[0], { key: previous[0], event: stableEvent })
            continue
          }
        }
        current.set(key, { key, event })
      }
    }
  }

  // Versions before project-level DSH host grouping used the plugin package in
  // the match key. Reuse one of those events for the new aggregate key when
  // the finding is still active, so an upgrade does not produce a fake
  // resolved + new pair of notifications.
  const previousVulnerabilities = new Map(Object.entries(previousState.activeVulnerabilities))
  const migratedLegacyKeys = new Set<string>()
  const migratedLegacyIncidentIds = new Set<string>()
  if (vulnerabilityQuerySucceeded) {
    for (const [legacyKey, previous] of Object.entries(previousState.activeVulnerabilities)) {
      if (previous.event.affectedSources?.includes('dsh-host') !== true) continue
      const aggregateKey = hostMatchKey(
        previous.event.project.id,
        previous.event.affected,
        previous.event.advisory.id,
      )
      if (aggregateKey === legacyKey || !current.has(aggregateKey)) continue
      if (!previousVulnerabilities.has(aggregateKey)) previousVulnerabilities.set(aggregateKey, previous)
      migratedLegacyKeys.add(legacyKey)
      migratedLegacyIncidentIds.add(previous.event.incidentId)
    }
  }

  const events: RadarEvent[] = []
  for (const [key, item] of current) {
    const previous = previousVulnerabilities.get(key)
    if (previous === undefined) {
      events.push(item.event)
      continue
    }
    if (eventChanged(previous.event, item.event)) {
      events.push({
        ...item.event,
        id: eventId(key, 'updated', checkedAt, item.event.advisory.modified),
        change: 'updated',
      })
    }
  }
  for (const [key, previous] of Object.entries(previousState.activeVulnerabilities)) {
    if (current.has(key) || migratedLegacyKeys.has(key)) continue
    events.push({
      ...previous.event,
      id: eventId(key, 'resolved', checkedAt, previous.event.advisory.modified),
      change: 'resolved',
      detectedAt: checkedAt,
    })
  }

  const releasePackages = new Map<string, PackageCoordinate>()
  if (releaseSource !== undefined) {
    for (const inventory of inventories) {
      for (const plugin of inventory.plugins) {
        releasePackages.set(packageKey(plugin.package), plugin.package)
        const hostRuntimePackage = plugin.graph.hostRuntime?.package
        if (hostRuntimePackage !== undefined) {
          releasePackages.set(packageKey(hostRuntimePackage), hostRuntimePackage)
        }
        for (const node of plugin.graph.nodes) {
          if (!(node.name === '@deepseek-ai/dsh'
            || node.name.startsWith('@deepseek-ai/dsh-')
            || node.name === '@deepseek-ai/cordis')) continue
          const item = coordinate(node.name, node.version)
          releasePackages.set(packageKey(item), item)
        }
      }
    }
  }
  let activeCompatibility = previousState.activeCompatibility
  let candidateVulnerabilityMatches = new Map<string, AdvisoryMatch[]>()
  let candidateVulnerabilityStatus: CandidateVulnerabilityStatus = 'not-requested'
  let candidateDependencyChecks = new Map<string, CompatibilityDependencyCheck>()
  let candidateDependencySourceRequested = false
  if (releaseSource !== undefined) {
    attemptedSources.add('npm-releases')
    let releases: Map<string, NpmReleaseObservation>
    let releaseCheckSucceeded = false
    try {
      releases = await releaseSource.query([...releasePackages.values()])
      releaseCheckSucceeded = true
      sourceHealth = recordSourceHealth(sourceHealth, 'npm-releases', checkedAt, true)
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error)
      const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
      sourceErrors.push({
        source: 'npm-releases',
        message,
      })
      sourceHealth = recordSourceHealth(sourceHealth, 'npm-releases', checkedAt, false, message)
      releases = new Map()
    }
    if (releaseCheckSucceeded) {
      const candidateQueryPackages = candidatePackages(releases)
      if (candidateQueryPackages.length > 0) {
        if (candidateQueryPackages.length > MAX_CANDIDATE_VULNERABILITY_QUERY) {
          const message = `OSV candidate query exceeds the ${MAX_CANDIDATE_VULNERABILITY_QUERY} package limit`
          sourceErrors.push({ source: 'osv', message })
          advisoryOutcomes.set('osv', { succeeded: false, message })
          candidateVulnerabilityStatus = 'unavailable'
        } else {
          try {
            const queried = await source.query(candidateQueryPackages)
            if (candidateQueryPackages.some(item => !queried.has(packageKey(item)))) {
              throw new Error('OSV candidate response does not cover every submitted package version')
            }
            candidateVulnerabilityMatches = queried
            candidateVulnerabilityStatus = 'checked'
          } catch (error: unknown) {
            const raw = error instanceof Error ? error.message : String(error)
            const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
            sourceErrors.push({ source: 'osv', message })
            advisoryOutcomes.set('osv', { succeeded: false, message })
            candidateVulnerabilityStatus = 'unavailable'
          }
        }
      }
      if (candidateDependencySource !== undefined) {
        const graphCandidates = candidateGraphPackages(releases).slice(0, MAX_CANDIDATE_GRAPHS)
        if (graphCandidates.length > 0) {
          candidateDependencySourceRequested = true
          attemptedSources.add('npm-candidate-graphs')
          let graphObservations = new Map<string, CandidateDependencyGraphObservation>()
          let graphSourceSucceeded = false
          try {
            graphObservations = await candidateDependencySource.query(graphCandidates)
            if (graphCandidates.some(item => !graphObservations.has(packageKey(item)))) {
              throw new Error('candidate dependency graph response does not cover every submitted package version')
            }
            graphSourceSucceeded = true
            sourceHealth = recordSourceHealth(sourceHealth, 'npm-candidate-graphs', checkedAt, true)
          } catch (error: unknown) {
            const raw = error instanceof Error ? error.message : String(error)
            const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
            sourceErrors.push({
              source: 'npm-candidate-graphs',
              message,
            })
            sourceHealth = recordSourceHealth(sourceHealth, 'npm-candidate-graphs', checkedAt, false, message)
          }

          for (const candidate of graphCandidates) {
            const key = packageKey(candidate)
            candidateDependencyChecks.set(key, candidateDependencyCheck(
              graphSourceSucceeded ? graphObservations.get(key) : undefined,
            ))
          }

          if (graphSourceSucceeded) {
            const dependencyQueryPackages = [...new Map(
              [...graphObservations.values()]
                .flatMap(observation => observation.graph === undefined || observation.status === 'unavailable'
                  ? []
                  : observation.graph.nodes.map(node => {
                    const item = coordinate(node.name, node.version)
                    return [packageKey(item), item] as const
                  })),
            ).values()]
            if (dependencyQueryPackages.length > MAX_CANDIDATE_DEPENDENCY_QUERY) {
              const message = `OSV candidate dependency query exceeds the ${MAX_CANDIDATE_DEPENDENCY_QUERY} package limit`
              sourceErrors.push({ source: 'osv', message })
              advisoryOutcomes.set('osv', { succeeded: false, message })
              for (const [key, check] of candidateDependencyChecks) {
                candidateDependencyChecks.set(key, {
                  ...check,
                  status: 'unavailable',
                  error: message,
                })
              }
            } else if (dependencyQueryPackages.length > 0) {
              try {
                const queried = await source.query(dependencyQueryPackages)
                if (dependencyQueryPackages.some(item => !queried.has(packageKey(item)))) {
                  throw new Error('OSV candidate dependency response does not cover every submitted package version')
                }
                for (const candidate of graphCandidates) {
                  const key = packageKey(candidate)
                  const check = candidateDependencyChecks.get(key)
                  const observation = graphObservations.get(key)
                  if (check === undefined || observation?.graph === undefined || check.status === 'unavailable') continue
                  const collected = collectCandidateDependencyFindings(observation.graph, queried)
                  candidateDependencyChecks.set(key, {
                    ...check,
                    findings: collected.findings,
                    ...(collected.findingsTruncated ? { findingsTruncated: true } : {}),
                  })
                }
              } catch (error: unknown) {
                const raw = error instanceof Error ? error.message : String(error)
                const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
                sourceErrors.push({ source: 'osv', message })
                advisoryOutcomes.set('osv', { succeeded: false, message })
                for (const [key, check] of candidateDependencyChecks) {
                  if (check.status === 'unavailable') continue
                  candidateDependencyChecks.set(key, {
                    ...check,
                    status: 'unavailable',
                    error: message,
                  })
                }
              }
            }
          }
        }
      }
      let releaseNotes = new Map<string, ReleaseNotes>()
      let releaseNotesCheckSucceeded = releaseNotesSource === undefined
      if (releaseNotesSource !== undefined) {
        attemptedSources.add('github-releases')
        try {
          releaseNotes = await releaseNotesSource.query([...releases.values()])
          releaseNotesCheckSucceeded = true
          sourceHealth = recordSourceHealth(sourceHealth, 'github-releases', checkedAt, true)
        } catch (error: unknown) {
          const raw = error instanceof Error ? error.message : String(error)
          const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
          sourceErrors.push({
            source: 'github-releases',
            message,
          })
          sourceHealth = recordSourceHealth(sourceHealth, 'github-releases', checkedAt, false, message)
        }
      }
      const currentCompatibility = new Map<string, StoredCompatibilityMatch>()
      const releaseStatuses = new Map<string, ReleaseCandidateStatus>()
      for (const observation of releases.values()) {
        releaseStatuses.set(packageKey(observation.installed), releaseCandidateStatus(observation))
      }
      for (const inventory of inventories) {
        const previousCompatibility = Object.values(previousState.activeCompatibility)
          .map(item => item.event)
          .filter((event): event is Extract<RadarEvent, { kind: 'compatibility' }> => event.kind === 'compatibility')
        for (const observation of releases.values()) {
          if (releaseCandidateStatus(observation) !== 'newer') continue
          const notes = releaseNotes.get(packageKey(observation.installed))
          const fallback = !releaseNotesCheckSucceeded
            ? previousCompatibility.find(event => (
              event.project.id === inventory.project.id
              && event.plugin.name === observation.installed.name
              && event.plugin.version === observation.installed.version
              && event.installed.name === observation.previous.name
              && event.installed.version === observation.previous.version
              && event.candidate.name === observation.candidate.name
              && event.candidate.version === observation.candidate.version
            ))
            : undefined
          const releaseNotesInput = notes?.text === undefined
            ? fallback?.releaseNotes === undefined ? {} : { releaseNotes: fallback.releaseNotes }
            : { releaseNotes: notes.text }
          const releaseNotesUrlInput = notes?.url === undefined
            ? fallback?.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: fallback.releaseNotesUrl }
            : { releaseNotesUrl: notes.url }
          const compatibilityEvents = assessCompatibilityChanges(inventory, {
            previous: observation.previous,
            candidate: observation.candidate,
            detectedAt: checkedAt,
            ...(observation.upgradeCandidates === undefined ? {} : { upgradeCandidates: observation.upgradeCandidates }),
            ...(observation.upgradeCandidates === undefined ? {} : {
              candidateVulnerabilities: candidateAdvisories(observation, candidateVulnerabilityMatches),
              candidateVulnerabilityStatus,
              ...(candidateDependencySourceRequested ? {
                candidateDependencyChecks,
                candidateDependencyStatus: candidateDependencyStatus(observation, candidateDependencyChecks, true),
              } : {}),
            }),
            activeVulnerabilities: [...current.values()]
              .map(item => item.event)
              .filter(event => (
                event.project.id === inventory.project.id
                && (event.affectedPlugins ?? [event.plugin]).some(plugin => (
                  plugin.name === observation.installed.name
                  && plugin.version === observation.installed.version
                ))
              )),
            ...releaseNotesInput,
            ...releaseNotesUrlInput,
          })
          for (const candidateEvent of compatibilityEvents) {
            currentCompatibility.set(candidateEvent.incidentId, { key: candidateEvent.incidentId, event: candidateEvent })
          }
        }
      }
      for (const [key, item] of currentCompatibility) {
        const previous = previousState.activeCompatibility[key]
        if (previous === undefined) {
          events.push(item.event)
          continue
        }
        if (compatibilityEventChanged(previous.event, item.event)) {
          events.push({
            ...item.event,
            id: `event-${hash(`${key}\0updated\0${checkedAt}\0${item.event.candidate.version}`)}`,
            change: 'updated',
          })
        }
      }
      for (const [key, previous] of Object.entries(previousState.activeCompatibility)) {
        if (currentCompatibility.has(key)) continue
        const status = releaseStatuses.get(packageKey(previous.event.installed))
        if (status === 'older' || status === 'uncomparable') {
          currentCompatibility.set(key, previous)
          continue
        }
        events.push({
          ...previous.event,
          id: `event-${hash(`${key}\0resolved\0${checkedAt}`)}`,
          change: 'resolved',
          detectedAt: checkedAt,
        })
      }
      activeCompatibility = Object.fromEntries(currentCompatibility)
    }
  }
  for (const binding of advisoryBindings) {
    const outcome = advisoryOutcomes.get(binding.name)
    sourceHealth = recordSourceHealth(
      sourceHealth,
      binding.name,
      checkedAt,
      outcome?.succeeded === true,
      outcome?.message,
    )
  }
  for (const binding of threatIntelBindings) {
    const outcome = threatIntelOutcomes.get(binding.name)
    sourceHealth = recordSourceHealth(
      sourceHealth,
      binding.name,
      checkedAt,
      outcome?.succeeded === true,
      outcome?.message,
    )
  }
  let activeSourceHealth: Record<string, StoredSourceHealthMatch> = previousState.activeSourceHealth ?? {}
  const currentSourceHealth = new Map<string, StoredSourceHealthMatch>(Object.entries(activeSourceHealth))
  for (const inventory of inventories) {
    for (const sourceName of attemptedSources) {
      const health = sourceHealth[sourceName]
      if (health === undefined) continue
      const key = sourceHealthKey(inventory.project.id, sourceName)
      const previous = activeSourceHealth[key]
      if (health.consecutiveFailures >= SOURCE_FAILURE_ALERT_THRESHOLD) {
        const candidate = createSourceHealthEvent(
          inventory,
          sourceName,
          'degraded',
          previous === undefined ? 'new' : 'updated',
          checkedAt,
          health,
        )
        currentSourceHealth.set(key, { key, event: candidate })
        if (previous === undefined) events.push(candidate)
        else if (sourceHealthEventChanged(previous.event, candidate)) events.push(candidate)
      } else if (previous !== undefined) {
        const recovered = createSourceHealthEvent(inventory, sourceName, 'healthy', 'resolved', checkedAt, health)
        currentSourceHealth.delete(key)
        events.push(recovered)
      }
    }
  }
  activeSourceHealth = Object.fromEntries(currentSourceHealth)
  events.sort((left, right) => left.id.localeCompare(right.id))

  // Keep the transition ledger in the same durable state as the active
  // matches. A repeated check can be safely retried because event ids are
  // stable, and the bounded tail prevents a long-running monitor from
  // turning its state file into an unbounded log.
  const historyById = new Map((previousState.history ?? []).map(event => [event.id, event]))
  for (const event of events) {
    if (!historyById.has(event.id)) historyById.set(event.id, event)
  }
  const history = [...historyById.values()]
    .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.id.localeCompare(right.id))
    .slice(-MAX_RADAR_HISTORY_EVENTS)

  const analysisTasks = events
    .filter(event => event.change !== 'resolved')
    .map(createAnalysisTask)
  const pending = new Map(previousState.pendingAnalysisTasks
    .filter(task => !migratedLegacyIncidentIds.has(task.event.incidentId))
    .map(task => [task.event.incidentId, task]))
  for (const event of events) {
    if (event.change === 'resolved') pending.delete(event.incidentId)
  }
  for (const task of analysisTasks) pending.set(task.event.incidentId, task)

  // A new or changed event invalidates the previous model conclusion. A
  // conclusion is never carried across an upstream update, and an in-flight
  // delivery for that old event must not be allowed to write back later.
  const changedIncidentIds = new Set([
    ...events.map(event => event.incidentId),
    ...migratedLegacyIncidentIds,
  ])
  const analysisResults = { ...(previousState.analysisResults ?? {}) }
  for (const incidentId of changedIncidentIds) delete analysisResults[incidentId]
  const analysisDeliveries = Object.fromEntries(
    Object.entries(previousState.analysisDeliveries ?? {}).filter(([, delivery]) => (
      delivery.taskRefs.every(reference => !changedIncidentIds.has(reference.incidentId))
    )),
  )

  return {
    checkedAt,
    packagesQueried: uniquePackages.size,
    releasePackagesQueried: releasePackages.size,
    events,
    analysisTasks,
    sourceErrors,
    state: {
      schema: RADAR_STATE_SCHEMA,
      activeVulnerabilities: Object.fromEntries([...current.entries()]),
      activeCompatibility,
      pendingAnalysisTasks: [...pending.values()],
      analysisDeliveries,
      analysisResults,
      sourceHealth,
      activeSourceHealth,
      history,
      ...(previousState.webhook === undefined ? {} : { webhook: previousState.webhook }),
      ...(previousState.webhookRoutes === undefined ? {} : { webhookRoutes: previousState.webhookRoutes }),
      ...(previousState.incidentMutes === undefined ? {} : { incidentMutes: previousState.incidentMutes }),
      ...(previousState.incidentTriage === undefined ? {} : { incidentTriage: previousState.incidentTriage }),
    },
  }
}
