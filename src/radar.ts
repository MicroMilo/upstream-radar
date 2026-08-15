import { createHash } from 'node:crypto'
import { createAnalysisTask } from './dsh-analysis.js'
import { assessCompatibilityChanges } from './compatibility.js'
import { findDependencyPaths } from './graph.js'
import type { ReleaseNotes, ReleaseNotesSource } from './github-release.js'
import type { NpmReleaseObservation } from './npm-release.js'
import { compareSemverValues } from './semver.js'
import { packageKey } from './osv.js'
import {
  RADAR_EVENT_SCHEMA,
  RADAR_STATE_SCHEMA,
  type AdvisoryMatch,
  type AnalysisTask,
  type DependencySource,
  type EventRoute,
  type PackageCoordinate,
  type ProjectInventory,
  type RadarEvent,
  type RadarSource,
  type RadarState,
  type SourceHealthEvent,
  type SourceHealthStatus,
  type StoredCompatibilityMatch,
  type StoredSourceHealthMatch,
  type StoredVulnerabilityMatch,
  type VulnerabilityAdvisory,
  type VulnerabilityEvent,
} from './radar-types.js'

export interface AdvisorySource {
  query(packages: readonly PackageCoordinate[]): Promise<Map<string, AdvisoryMatch[]>>
}

export interface ReleaseSource {
  query(packages: readonly PackageCoordinate[]): Promise<Map<string, NpmReleaseObservation>>
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

type CandidateVulnerabilityStatus = 'checked' | 'unavailable' | 'not-requested'

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
): string {
  return [inventory.project.id, packageKey(plugin), packageKey(affected), advisoryId].join('\0')
}

function eventId(key: string, change: VulnerabilityEvent['change'], detectedAt: string, modified: string): string {
  return `event-${hash(`${key}\0${change}\0${detectedAt}\0${modified}`)}`
}

function eventChanged(previous: VulnerabilityEvent, current: VulnerabilityEvent): boolean {
  return JSON.stringify(previous.advisory) !== JSON.stringify(current.advisory)
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
    sourceHealth: {},
    activeSourceHealth: {},
  }
}

/** Query exact installed versions, calculate affected paths, and emit state transitions only. */
export async function pollRadar(
  inventories: readonly ProjectInventory[],
  previousState: RadarState,
  source: AdvisorySource,
  now = new Date(),
  releaseSource?: ReleaseSource,
  releaseNotesSource?: ReleaseNotesSource,
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
    }
  }
  let matches = new Map<string, AdvisoryMatch[]>()
  let vulnerabilityCheckSucceeded = true
  let osvSourceSucceeded = true
  let osvFailureMessage: string | undefined
  attemptedSources.add('osv')
  try {
    matches = await source.query([...uniquePackages.values()])
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error)
    const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
    sourceErrors.push({
      source: 'osv',
      message,
    })
    osvSourceSucceeded = false
    osvFailureMessage = message
    vulnerabilityCheckSucceeded = false
  }

  const current = vulnerabilityCheckSucceeded
    ? new Map<string, StoredVulnerabilityMatch>()
    : new Map(Object.entries(previousState.activeVulnerabilities))
  if (vulnerabilityCheckSucceeded) {
    for (const inventory of inventories) {
      for (const plugin of inventory.plugins) {
        const groupedPaths = new Map<string, PackageCoordinate[][]>()
        const groupedMatch = new Map<string, AdvisoryMatch>()
        const groupedSources = new Map<string, Set<DependencySource>>()
        for (const node of plugin.graph.nodes) {
          const affected = coordinate(node.name, node.version)
          for (const match of matches.get(packageKey(affected)) ?? []) {
            const key = matchKey(inventory, plugin.package, affected, match.advisory.id)
            const paths = findDependencyPaths(plugin.graph, node.id).map(path => (
              path.map(item => coordinate(item.name, item.version))
            ))
            if (paths.length === 0) continue
            const existing = groupedPaths.get(key) ?? []
            const known = new Set(existing.map(path => JSON.stringify(path)))
            for (const path of paths) {
              const serialized = JSON.stringify(path)
              if (!known.has(serialized)) {
                existing.push(path)
                known.add(serialized)
              }
            }
            groupedPaths.set(key, existing)
            groupedMatch.set(key, match)
            if (node.source !== undefined) {
              const sources = groupedSources.get(key) ?? new Set<DependencySource>()
              sources.add(node.source)
              groupedSources.set(key, sources)
            }
          }
        }

        for (const [key, paths] of groupedPaths) {
          const match = groupedMatch.get(key)
          if (match === undefined) continue
          paths.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
          const sourceSet = groupedSources.get(key)
          const orderedSources: readonly DependencySource[] = ['profile', 'dsh-host']
          const affectedSources = orderedSources.filter(source => sourceSet?.has(source) ?? false)
          const event: VulnerabilityEvent = {
            schema: RADAR_EVENT_SCHEMA,
            id: eventId(key, 'new', checkedAt, match.advisory.modified),
            incidentId: `incident-${hash(key)}`,
            kind: match.advisory.id.startsWith('MAL-') ? 'malware' : 'vulnerability',
            change: 'new',
            detectedAt: checkedAt,
            project: { ...inventory.project },
            route: route(inventory),
            plugin: { ...plugin.package },
            affected: { ...match.package },
            ...(affectedSources.length === 0 ? {} : { affectedSources }),
            paths,
            advisory: { ...match.advisory },
          }
          current.set(key, { key, event })
        }
      }
    }
  }

  const events: RadarEvent[] = []
  for (const [key, item] of current) {
    const previous = previousState.activeVulnerabilities[key]
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
    if (current.has(key)) continue
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
        for (const node of plugin.graph.nodes) {
          if (!(node.name.startsWith('@deepseek-ai/dsh-') || node.name === '@deepseek-ai/cordis')) continue
          const item = coordinate(node.name, node.version)
          releasePackages.set(packageKey(item), item)
        }
      }
    }
  }
  let activeCompatibility = previousState.activeCompatibility
  let candidateVulnerabilityMatches = new Map<string, AdvisoryMatch[]>()
  let candidateVulnerabilityStatus: CandidateVulnerabilityStatus = 'not-requested'
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
          osvSourceSucceeded = false
          osvFailureMessage = message
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
            osvSourceSucceeded = false
            osvFailureMessage = message
            candidateVulnerabilityStatus = 'unavailable'
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
            }),
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
  sourceHealth = recordSourceHealth(sourceHealth, 'osv', checkedAt, osvSourceSucceeded, osvFailureMessage)
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

  const analysisTasks = events
    .filter(event => event.change !== 'resolved')
    .map(createAnalysisTask)
  const pending = new Map(previousState.pendingAnalysisTasks.map(task => [task.event.incidentId, task]))
  for (const event of events) {
    if (event.change === 'resolved') pending.delete(event.incidentId)
  }
  for (const task of analysisTasks) pending.set(task.event.incidentId, task)

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
      sourceHealth,
      activeSourceHealth,
    },
  }
}
