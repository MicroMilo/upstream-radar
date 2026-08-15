import type { RadarConfig, RadarSource, RadarState, SourceHealthStatus } from './radar-types.js'

export const RADAR_STATUS_SCHEMA = 'upstream-radar.radar-status/v1alpha1' as const

const RADAR_SOURCES: readonly RadarSource[] = ['osv', 'npm-releases', 'github-releases']

export type RadarMonitoringStatus = 'not-started' | 'healthy' | 'degraded'
export type RadarSourceStatus = 'not-run' | 'healthy' | 'degraded'

export interface RadarStatusSource {
  source: RadarSource
  status: RadarSourceStatus
  consecutiveFailures: number
  lastAttemptedAt?: string
  lastSucceededAt?: string
  lastError?: string
}

export interface RadarStatusReport {
  schema: typeof RADAR_STATUS_SCHEMA
  configFile: string
  stateFile: string
  stateExists: boolean
  monitoring: RadarMonitoringStatus
  projects: number
  pluginBundles: number
  lastCheckedAt?: string
  sources: RadarStatusSource[]
  activeVulnerabilities: number
  activeCompatibility: number
  activeSourceHealth: number
  pendingAnalysisTasks: number
}

export interface CreateRadarStatusOptions {
  configFile: string
  stateFile: string
  stateExists: boolean
}

function sourceStatus(source: RadarSource, status: SourceHealthStatus | undefined): RadarStatusSource {
  if (status === undefined) {
    return { source, status: 'not-run', consecutiveFailures: 0 }
  }
  return {
    source,
    status: status.consecutiveFailures === 0 ? 'healthy' : 'degraded',
    consecutiveFailures: status.consecutiveFailures,
    lastAttemptedAt: status.lastAttemptedAt,
    ...(status.lastSucceededAt === undefined ? {} : { lastSucceededAt: status.lastSucceededAt }),
    ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
  }
}

function latestTimestamp(sources: readonly RadarStatusSource[]): string | undefined {
  return sources
    .flatMap(source => source.lastAttemptedAt === undefined ? [] : [source.lastAttemptedAt])
    .sort()
    .at(-1)
}

/** Build a network-free snapshot from the reviewed config and durable Radar state. */
export function createRadarStatus(
  config: RadarConfig,
  state: RadarState,
  options: CreateRadarStatusOptions,
): RadarStatusReport {
  const sources = RADAR_SOURCES.map(source => sourceStatus(source, state.sourceHealth?.[source]))
  const observedSources = sources.filter(source => source.status !== 'not-run')
  const monitoring: RadarMonitoringStatus = observedSources.length === 0
    ? 'not-started'
    : observedSources.some(source => source.status === 'degraded') ? 'degraded' : 'healthy'
  const lastCheckedAt = latestTimestamp(sources)
  return {
    schema: RADAR_STATUS_SCHEMA,
    configFile: options.configFile,
    stateFile: options.stateFile,
    stateExists: options.stateExists,
    monitoring,
    projects: config.projects.length,
    pluginBundles: config.projects.reduce((total, project) => total + project.plugins.length, 0),
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
    sources,
    activeVulnerabilities: Object.keys(state.activeVulnerabilities).length,
    activeCompatibility: Object.keys(state.activeCompatibility).length,
    activeSourceHealth: Object.keys(state.activeSourceHealth ?? {}).length,
    pendingAnalysisTasks: state.pendingAnalysisTasks.length,
  }
}

function display(value: string, maxLength = 512): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= maxLength ? escaped : `${escaped.slice(0, maxLength)}…`
}

function sourceLabel(source: RadarSource): string {
  if (source === 'osv') return 'OSV'
  if (source === 'npm-releases') return 'npm releases'
  return 'GitHub releases'
}

function plural(value: number, singular: string, multiple = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : multiple}`
}

/** Render the status snapshot for a human checking the first run. */
export function renderRadarStatus(report: RadarStatusReport): string {
  const lines = [
    'Upstream Radar status',
    `Monitoring: ${report.monitoring.replace('-', ' ')}`,
    `Config: ${display(report.configFile)} (${plural(report.projects, 'project')}, ${plural(report.pluginBundles, 'DSH plugin bundle')})`,
    `State: ${display(report.stateFile)}${report.stateExists ? '' : ' (not created yet)'}`,
    `Last check: ${report.lastCheckedAt === undefined ? 'never' : display(report.lastCheckedAt)}`,
    '',
    'Sources:',
  ]
  for (const source of report.sources) {
    const detail = source.status === 'not-run'
      ? 'not run'
      : `${source.status}${source.lastSucceededAt === undefined ? '' : `, last success ${display(source.lastSucceededAt)}`}`
    lines.push(`  ${sourceLabel(source.source)}: ${detail}`)
    if (source.lastError !== undefined) lines.push(`    error: ${display(source.lastError, 2_048)}`)
  }
  lines.push(
    '',
    `Active vulnerabilities: ${report.activeVulnerabilities}`,
    `Active compatibility incidents: ${report.activeCompatibility}`,
    `Source-health incidents: ${report.activeSourceHealth}`,
    `Pending DSH analysis tasks: ${report.pendingAnalysisTasks}`,
  )
  if (report.monitoring === 'not-started') {
    lines.push('', 'No completed check is recorded yet. Start DSH or run `radar check` once.')
  }
  return `${lines.join('\n')}\n`
}
