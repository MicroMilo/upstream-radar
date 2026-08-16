import type {
  CompatibilityEvent,
  RadarConfig,
  RadarEvent,
  RadarSeverity,
  RadarSource,
  RadarState,
  DependencyHostRuntimeSource,
  SourceHealthEvent,
  SourceHealthStatus,
  VulnerabilityEvent,
} from './radar-types.js'
import { countPolicyHeldAnalysisTasks, createNotificationPolicyMap } from './notification-policy.js'

export const RADAR_STATUS_SCHEMA = 'upstream-radar.radar-status/v1alpha1' as const

const RADAR_SOURCES: readonly RadarSource[] = ['osv', 'npm-releases', 'npm-candidate-graphs', 'github-releases']

export type RadarMonitoringStatus = 'not-started' | 'healthy' | 'degraded'
export type RadarSourceStatus = 'not-run' | 'healthy' | 'degraded'
export type RadarCoverageStatus = 'complete' | 'incomplete'

export interface RadarStatusIncident {
  incidentId: string
  kind: RadarEvent['kind']
  priority: RadarSeverity | 'attention'
  project: string
  summary: string
  nextStep: string
}

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
  coverage: RadarCoverageStatus
  projects: number
  pluginBundles: number
  unresolvedDependencies: number
  requiredUnresolvedDependencies: number
  optionalDependenciesNotInstalled: number
  /** Required DSH/Cordis peers that were not visible in the captured host plane. */
  dshHostDependenciesNotObserved: number
  /** Number of plugin graphs that included a DSH host dependency plane. */
  dshHostRuntimePlanes: number
  dshHostRuntimePackages: number
  /** Distinct evidence sources used for the captured DSH host planes. */
  dshHostRuntimeSources: DependencyHostRuntimeSource[]
  lastCheckedAt?: string
  sources: RadarStatusSource[]
  activeVulnerabilities: number
  activeCompatibility: number
  activeSourceHealth: number
  pendingAnalysisTasks: number
  /** Tasks still retained in the outbox but currently held by project policy. */
  notificationPolicyHeldTasks: number
  analysisDeliveries: number
  analysisResults: number
  activeIncidents: RadarStatusIncident[]
  activeIncidentOverflow: number
}

export interface CreateRadarStatusOptions {
  configFile: string
  stateFile: string
  stateExists: boolean
  now?: Date
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

function packageLabel(value: { name: string; version: string }): string {
  return `${display(value.name)}@${display(value.version)}`
}

function vulnerabilityPluginScope(event: VulnerabilityEvent): string {
  if (event.affectedPlugins === undefined || event.affectedPlugins.length <= 1) return packageLabel(event.plugin)
  return `the shared DSH host runtime used by ${event.affectedPlugins.map(packageLabel).join(', ')}`
}

function sourceLabel(source: RadarSource): string {
  if (source === 'osv') return 'OSV'
  if (source === 'npm-releases') return 'npm releases'
  if (source === 'npm-candidate-graphs') return 'npm candidate dependency graphs'
  return 'GitHub releases'
}

function isDshHostDependency(name: string): boolean {
  return name === '@deepseek-ai/dsh'
    || name === '@deepseek-ai/cordis'
    || name.startsWith('@deepseek-ai/cordis-plugin-')
    || name.startsWith('@deepseek-ai/dsh-')
}

function analysisNextStep(state: RadarState, incidentId: string, fallback: string): string {
  const result = state.analysisResults?.[incidentId]
  if (result === undefined) return fallback
  return `DSH analysis: ${display(result.project_exposure)} (${display(result.confidence)} confidence); ${display(result.recommended_action, 2_048)}`
}

function vulnerabilityStatusIncident(event: VulnerabilityEvent, state: RadarState): RadarStatusIncident {
  const firstPath = event.paths[0]
  const path = firstPath === undefined
    ? 'dependency path unavailable'
    : firstPath.map(packageLabel).join(' -> ')
  const scope = event.affectedPlugins === undefined || event.affectedPlugins.length <= 1
    ? ''
    : ` across ${event.affectedPlugins.length} DSH plugins`
  const summary = `${packageLabel(event.affected)} is affected by ${display(event.advisory.id)}${scope} via ${path}`
  if (event.kind === 'malware') {
    return {
      incidentId: event.incidentId,
      kind: event.kind,
      priority: 'critical',
      project: display(event.project.name),
      summary,
      nextStep: analysisNextStep(state, event.incidentId, `Remove or isolate ${vulnerabilityPluginScope(event)}, then ask the DSH Agent to assess project exposure.`),
    }
  }
  const fixedVersions = event.advisory.fixedVersions.slice(0, 4).map(item => display(item)).join(', ')
  return {
    incidentId: event.incidentId,
    kind: event.kind,
    priority: event.advisory.severity,
    project: display(event.project.name),
    summary,
    nextStep: analysisNextStep(state, event.incidentId, fixedVersions.length === 0
      ? `No published fix is recorded; ask the DSH Agent to assess containment or replacement for ${vulnerabilityPluginScope(event)}.`
      : `Review ${event.affected.name} fixed version(s) ${fixedVersions} with the DSH Agent before changing the plugin.`),
  }
}

function compatibilityStatusIncident(event: CompatibilityEvent, state: RadarState): RadarStatusIncident {
  const firstCandidate = event.upgradePath?.firstCandidate?.candidate
  const candidate = firstCandidate === undefined ? event.candidate : firstCandidate
  const signal = event.signals.find(item => item.confidence === 'confirmed' || item.confidence === 'strong')
    ?? event.signals[0]
  const signalText = signal === undefined ? 'needs project analysis' : display(signal.summary)
  return {
    incidentId: event.incidentId,
    kind: event.kind,
    priority: 'attention',
    project: display(event.project.name),
    summary: `${packageLabel(event.installed)} -> ${packageLabel(candidate)}: ${signalText}`,
    nextStep: analysisNextStep(state, event.incidentId, `Ask the DSH Agent to inspect project impact before applying ${packageLabel(candidate)}.`),
  }
}

function sourceHealthStatusIncident(event: SourceHealthEvent, state: RadarState): RadarStatusIncident {
  const source = sourceLabel(event.source)
  return {
    incidentId: event.incidentId,
    kind: event.kind,
    priority: 'attention',
    project: display(event.project.name),
    summary: `${source} failed ${event.failureCount} consecutive check(s)`,
    nextStep: analysisNextStep(state, event.incidentId, `Restore ${source} before treating the absence of new alerts as a clean result.`),
  }
}

function statusIncident(event: RadarEvent, state: RadarState): RadarStatusIncident {
  if (event.kind === 'compatibility') return compatibilityStatusIncident(event, state)
  if (event.kind === 'source-health') return sourceHealthStatusIncident(event, state)
  return vulnerabilityStatusIncident(event, state)
}

function priorityRank(priority: RadarStatusIncident['priority']): number {
  if (priority === 'critical') return 6
  if (priority === 'high') return 5
  if (priority === 'medium') return 4
  if (priority === 'low') return 3
  if (priority === 'unknown') return 2
  if (priority === 'info') return 1
  return 0
}

function activeIncidentSummary(state: RadarState): { incidents: RadarStatusIncident[]; overflow: number } {
  const all = [
    ...Object.values(state.activeVulnerabilities).map(item => statusIncident(item.event, state)),
    ...Object.values(state.activeCompatibility).map(item => statusIncident(item.event, state)),
    ...Object.values(state.activeSourceHealth ?? {}).map(item => statusIncident(item.event, state)),
  ].sort((left, right) => (
    priorityRank(right.priority) - priorityRank(left.priority)
      || left.project.localeCompare(right.project)
      || left.incidentId.localeCompare(right.incidentId)
  ))
  const incidents = all.slice(0, 32)
  return { incidents, overflow: all.length - incidents.length }
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
  const unresolvedDependencies = config.projects.reduce(
    (total, project) => total + project.plugins.reduce((count, plugin) => count + (plugin.graph.unresolved?.length ?? 0), 0),
    0,
  )
  const requiredUnresolvedDependencies = config.projects.reduce(
    (total, project) => total + project.plugins.reduce((count, plugin) => (
      count + (plugin.graph.unresolved?.filter(item => item.kind !== 'optional').length ?? 0)
    ), 0),
    0,
  )
  const optionalDependenciesNotInstalled = unresolvedDependencies - requiredUnresolvedDependencies
  const dshHostDependenciesNotObserved = config.projects.reduce(
    (total, project) => total + project.plugins.reduce((count, plugin) => (
      count + (plugin.graph.unresolved?.filter(item => item.kind !== 'optional' && isDshHostDependency(item.name)).length ?? 0)
    ), 0),
    0,
  )
  const dshHostRuntimePackages = config.projects.reduce(
    (total, project) => total + project.plugins.reduce((count, plugin) => (
      count + (plugin.graph.hostRuntime?.resolvedNodes ?? 0)
    ), 0),
    0,
  )
  const dshHostRuntimeGraphs = config.projects.flatMap(project => project.plugins.map(plugin => plugin.graph.hostRuntime)).filter(
    (hostRuntime): hostRuntime is NonNullable<typeof hostRuntime> => hostRuntime !== undefined,
  )
  const dshHostRuntimeSources = [...new Set(dshHostRuntimeGraphs.map(hostRuntime => hostRuntime.source))].sort()
  const activeSummary = activeIncidentSummary(state)
  const notificationPolicies = createNotificationPolicyMap(config.projects)
  const notificationPolicyHeldTasks = countPolicyHeldAnalysisTasks(
    state.pendingAnalysisTasks,
    notificationPolicies,
    options.now,
  )
  return {
    schema: RADAR_STATUS_SCHEMA,
    configFile: options.configFile,
    stateFile: options.stateFile,
    stateExists: options.stateExists,
    monitoring,
    coverage: requiredUnresolvedDependencies === 0 ? 'complete' : 'incomplete',
    projects: config.projects.length,
    pluginBundles: config.projects.reduce((total, project) => total + project.plugins.length, 0),
    unresolvedDependencies,
    requiredUnresolvedDependencies,
    optionalDependenciesNotInstalled,
    dshHostDependenciesNotObserved,
    dshHostRuntimePlanes: dshHostRuntimeGraphs.length,
    dshHostRuntimePackages,
    dshHostRuntimeSources,
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
    sources,
    activeVulnerabilities: Object.keys(state.activeVulnerabilities).length,
    activeCompatibility: Object.keys(state.activeCompatibility).length,
    activeSourceHealth: Object.keys(state.activeSourceHealth ?? {}).length,
    pendingAnalysisTasks: state.pendingAnalysisTasks.length,
    notificationPolicyHeldTasks,
    analysisDeliveries: Object.keys(state.analysisDeliveries ?? {}).length,
    analysisResults: Object.keys(state.analysisResults ?? {}).length,
    activeIncidents: activeSummary.incidents,
    activeIncidentOverflow: activeSummary.overflow,
  }
}

function display(value: string, maxLength = 512): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= maxLength ? escaped : `${escaped.slice(0, maxLength)}…`
}

function plural(value: number, singular: string, multiple = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : multiple}`
}

function hostRuntimeSourceLabel(source: DependencyHostRuntimeSource): string {
  return source === 'dsh-process' ? 'running DSH process' : 'profile fallback'
}

/** Render the status snapshot for a human checking the first run. */
export function renderRadarStatus(report: RadarStatusReport): string {
  const coverageParts: string[] = []
  if (report.coverage === 'incomplete') coverageParts.push(plural(report.requiredUnresolvedDependencies, 'required dependency gap'))
  if (report.optionalDependenciesNotInstalled > 0) {
    coverageParts.push(`${plural(report.optionalDependenciesNotInstalled, 'optional dependency', 'optional dependencies')} not installed`)
  }
  if (report.dshHostDependenciesNotObserved > 0) {
    coverageParts.push(`${plural(report.dshHostDependenciesNotObserved, 'DSH host dependency', 'DSH host dependencies')} not observed`)
  }
  const coverageDetail = coverageParts.length === 0 ? '' : ` (${coverageParts.join('; ')})`
  const lines = [
    'Upstream Radar status',
    `Monitoring: ${report.monitoring.replace('-', ' ')}`,
    `Config: ${display(report.configFile)} (${plural(report.projects, 'project')}, ${plural(report.pluginBundles, 'DSH plugin bundle')})`,
    `State: ${display(report.stateFile)}${report.stateExists ? '' : ' (not created yet)'}`,
    `Coverage: ${report.coverage}${coverageDetail}`,
    `DSH host runtime: ${report.dshHostRuntimePlanes === 0
      ? 'not included'
      : `${plural(report.dshHostRuntimePackages, 'package')} observed (${report.dshHostRuntimeSources.map(hostRuntimeSourceLabel).join(', ')})`}`,
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
    report.activeIncidents.length === 0 ? 'Attention: none' : 'Attention:',
  )
  for (const incident of report.activeIncidents) {
    lines.push(
      `  [${incident.priority.toUpperCase()}] ${display(incident.project)}: ${display(incident.summary)}`,
      `    Next: ${display(incident.nextStep)}`,
    )
  }
  if (report.activeIncidentOverflow > 0) {
    lines.push(`  … ${report.activeIncidentOverflow} more active incident(s) omitted from this summary`)
  }
  lines.push(
    '',
    `Active vulnerabilities: ${report.activeVulnerabilities}`,
    `Active compatibility incidents: ${report.activeCompatibility}`,
    `Source-health incidents: ${report.activeSourceHealth}`,
    `Pending DSH analysis tasks: ${report.pendingAnalysisTasks}`,
    `Held by notification policy: ${report.notificationPolicyHeldTasks}`,
    `Awaiting DSH analysis results: ${report.analysisDeliveries}`,
    `Verified DSH analysis results: ${report.analysisResults}`,
  )
  if (report.monitoring === 'not-started') {
    lines.push('', 'No completed check is recorded yet. Start DSH or run `radar check` once.')
  }
  if (report.pendingAnalysisTasks > 0) {
    lines.push('', `Next: run \`upstream-radar task show ${display(report.stateFile)}\` to inspect the next queued DSH analysis.`)
  } else if (report.analysisDeliveries > 0) {
    lines.push('', 'DSH analysis is in progress; results will appear here only after strict response validation.')
  }
  return `${lines.join('\n')}\n`
}
