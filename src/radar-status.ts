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
  StoredAnalysisResult,
  VulnerabilityEvent,
} from './radar-types.js'
import { countPolicyHeldAnalysisTasks, createNotificationPolicyMap, isRadarIncidentMuted } from './notification-policy.js'
import { renderVulnerabilityPriority, vulnerabilityPriority, type VulnerabilityPriorityEvidence } from './vulnerability-priority.js'

export const RADAR_STATUS_SCHEMA = 'upstream-radar.radar-status/v1alpha1' as const
export const RADAR_NEXT_SCHEMA = 'upstream-radar.radar-next/v1alpha1' as const

const RADAR_SOURCES: readonly RadarSource[] = ['osv', 'github-advisories', 'cisa-kev', 'epss', 'npm-releases', 'npm-candidate-graphs', 'github-releases']

export type RadarMonitoringStatus = 'not-started' | 'healthy' | 'degraded'
export type RadarSourceStatus = 'not-run' | 'healthy' | 'degraded'
export type RadarCoverageStatus = 'complete' | 'incomplete'

/**
 * Evidence used to order active vulnerability incidents for human triage.
 * Missing fields mean that Radar did not retain that signal; they are not a
 * claim that the incident is safe.
 */
export interface RadarStatusTriage extends VulnerabilityPriorityEvidence {}

export interface RadarStatusIncident {
  incidentId: string
  kind: RadarEvent['kind']
  priority: RadarSeverity | 'attention'
  project: string
  summary: string
  nextStep: string
  triage?: RadarStatusTriage
  mutedUntil?: string
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

export interface RadarNextReport {
  schema: typeof RADAR_NEXT_SCHEMA
  configFile: string
  stateFile: string
  stateExists: boolean
  monitoring: RadarMonitoringStatus
  coverage: RadarCoverageStatus
  activeIncident?: RadarStatusIncident
  pendingAnalysisTaskId?: string
  verifiedAnalysis?: StoredAnalysisResult
  nextCommand: string
  acknowledgeCommand?: string
  unmuteCommand?: string
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
  if (source === 'github-advisories') return 'GitHub Advisory Database'
  if (source === 'cisa-kev') return 'CISA KEV'
  if (source === 'epss') return 'FIRST EPSS'
  if (source === 'npm-releases') return 'npm releases'
  if (source === 'npm-candidate-graphs') return 'npm candidate dependency graphs'
  return 'GitHub releases'
}

function vulnerabilityEvidenceSuffix(event: VulnerabilityEvent): string {
  const sources = event.advisory.sources?.map(sourceLabel).join(' + ')
  const conflicts = event.advisory.conflicts?.map(conflict => (
    conflict.field === 'severity' ? 'severity' : 'fixed versions'
  )).join(', ')
  const details = [
    ...(sources === undefined ? [] : [`sources: ${sources}`]),
    ...(conflicts === undefined ? [] : [`source conflict: ${conflicts}`]),
    ...(event.advisory.riskSignals?.cisaKev === undefined ? [] : ['CISA KEV: known exploited']),
    ...(event.advisory.riskSignals?.epss === undefined ? [] : [
      `EPSS: ${(event.advisory.riskSignals.epss.score * 100).toFixed(1)}% estimated exploitation probability`,
    ]),
  ]
  return details.length === 0 ? '' : ` (${details.join('; ')})`
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
  const summary = `${packageLabel(event.affected)} is affected by ${display(event.advisory.id)}${scope} via ${path}${vulnerabilityEvidenceSuffix(event)}`
  if (event.kind === 'malware') {
    return {
      incidentId: event.incidentId,
      kind: event.kind,
      priority: 'critical',
      project: display(event.project.name),
      summary,
      nextStep: analysisNextStep(state, event.incidentId, `Remove or isolate ${vulnerabilityPluginScope(event)}, then ask the DSH Agent to assess project exposure.`),
      triage: vulnerabilityPriority(event),
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
    triage: vulnerabilityPriority(event),
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

function priorityRank(priority: RadarSeverity | 'attention'): number {
  if (priority === 'critical') return 6
  if (priority === 'high') return 5
  if (priority === 'medium') return 4
  if (priority === 'low') return 3
  if (priority === 'unknown') return 2
  if (priority === 'info') return 1
  return 0
}

function triageSortKey(incident: RadarStatusIncident): [number, number, number, number] {
  return [
    incident.triage?.knownExploited === true ? 1 : 0,
    incident.triage?.epssScore ?? -1,
    incident.triage === undefined ? 0 : priorityRank(incident.triage.severity),
    priorityRank(incident.priority),
  ]
}

function compareActiveIncidents(left: RadarStatusIncident, right: RadarStatusIncident): number {
  const leftKey = triageSortKey(left)
  const rightKey = triageSortKey(right)
  return rightKey[0] - leftKey[0]
    || rightKey[1] - leftKey[1]
    || rightKey[2] - leftKey[2]
    || rightKey[3] - leftKey[3]
    || left.project.localeCompare(right.project)
    || left.incidentId.localeCompare(right.incidentId)
}

function statusIncidentWithMute(event: RadarEvent, state: RadarState, now: Date): RadarStatusIncident {
  const incident = statusIncident(event, state)
  const mute = state.incidentMutes?.[event.incidentId]
  if (mute === undefined || !isRadarIncidentMuted(state, event, now)) return incident
  return { ...incident, mutedUntil: mute.mutedUntil }
}

function activeIncidentSummary(state: RadarState, now: Date): { incidents: RadarStatusIncident[]; overflow: number } {
  const all = [
    ...Object.values(state.activeVulnerabilities).map(item => statusIncidentWithMute(item.event, state, now)),
    ...Object.values(state.activeCompatibility).map(item => statusIncidentWithMute(item.event, state, now)),
    ...Object.values(state.activeSourceHealth ?? {}).map(item => statusIncidentWithMute(item.event, state, now)),
  ].sort(compareActiveIncidents)
  const incidents = all.slice(0, 32)
  return { incidents, overflow: all.length - incidents.length }
}

/** Build a network-free snapshot from the reviewed config and durable Radar state. */
export function createRadarStatus(
  config: RadarConfig,
  state: RadarState,
  options: CreateRadarStatusOptions,
): RadarStatusReport {
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('radar status time is invalid')
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
  const activeSummary = activeIncidentSummary(state, now)
  const notificationPolicies = createNotificationPolicyMap(config.projects)
  const notificationPolicyHeldTasks = countPolicyHeldAnalysisTasks(
    state.pendingAnalysisTasks,
    notificationPolicies,
    now,
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

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Build the one-action handoff shown after a user sees the first alert. */
export function createRadarNext(report: RadarStatusReport, state: RadarState): RadarNextReport {
  const activeIncident = report.activeIncidents[0]
  const pendingTask = activeIncident === undefined
    ? undefined
    : state.pendingAnalysisTasks.find(task => task.event.incidentId === activeIncident.incidentId)
  const verifiedAnalysis = activeIncident === undefined
    ? undefined
    : state.analysisResults?.[activeIncident.incidentId]
  const nextCommand = activeIncident === undefined
    ? `upstream-radar radar check ${shellArgument(report.configFile)}`
    : verifiedAnalysis !== undefined
      ? `upstream-radar analysis show ${shellArgument(report.stateFile)} ${shellArgument(activeIncident.incidentId)}`
      : pendingTask !== undefined
        ? `upstream-radar task show ${shellArgument(report.stateFile)} ${shellArgument(pendingTask.id)}`
        : report.analysisDeliveries > 0
          ? `upstream-radar radar status ${shellArgument(report.configFile)} --state ${shellArgument(report.stateFile)}`
          : `upstream-radar radar check ${shellArgument(report.configFile)} --state ${shellArgument(report.stateFile)}`
  return {
    schema: RADAR_NEXT_SCHEMA,
    configFile: report.configFile,
    stateFile: report.stateFile,
    stateExists: report.stateExists,
    monitoring: report.monitoring,
    coverage: report.coverage,
    ...(activeIncident === undefined ? {} : { activeIncident }),
    ...(pendingTask === undefined ? {} : { pendingAnalysisTaskId: pendingTask.id }),
    ...(verifiedAnalysis === undefined ? {} : { verifiedAnalysis }),
    nextCommand,
    ...(pendingTask === undefined ? {} : {
      acknowledgeCommand: `upstream-radar task ack ${shellArgument(report.stateFile)} ${shellArgument(pendingTask.id)}`,
    }),
    ...(activeIncident?.mutedUntil === undefined ? {} : {
      unmuteCommand: `upstream-radar unmute ${shellArgument(report.stateFile)} ${shellArgument(activeIncident.incidentId)}`,
    }),
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

function renderTriage(triage: RadarStatusTriage | undefined): string | undefined {
  if (triage === undefined) return undefined
  return renderVulnerabilityPriority(triage)
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
    report.activeIncidents.length === 0
      ? 'Attention: none'
      : 'Attention (ordered by CISA KEV, EPSS, then severity):',
  )
  for (const incident of report.activeIncidents) {
    const triage = renderTriage(incident.triage)
    lines.push(
      `  [${incident.priority.toUpperCase()}] ${display(incident.project)}: ${display(incident.summary)}`,
      ...(triage === undefined ? [] : [`    Triage: ${triage}`]),
      ...(incident.mutedUntil === undefined ? [] : [
        `    Delivery: muted until ${display(incident.mutedUntil)}; active evidence remains visible`,
      ]),
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

/** Render one short, read-only action handoff for a person who just saw an alert. */
export function renderRadarNext(report: RadarNextReport): string {
  const lines = [
    'Upstream Radar next action',
    `Monitoring: ${report.monitoring.replace('-', ' ')}`,
    `Coverage: ${report.coverage}`,
  ]
  const incident = report.activeIncident
  if (incident === undefined) {
    lines.push('', 'No active incident is currently recorded.', `Next command: ${report.nextCommand}`)
    return `${lines.join('\n')}\n`
  }
  lines.push(
    '',
    `[${incident.priority.toUpperCase()}] ${display(incident.project)}: ${display(incident.summary)}`,
    ...(incident.triage === undefined ? [] : [`Triage: ${renderVulnerabilityPriority(incident.triage)}`]),
    ...(incident.mutedUntil === undefined ? [] : [
      `Delivery: muted until ${display(incident.mutedUntil)}; active evidence remains visible`,
    ]),
    `Deterministic next step: ${display(incident.nextStep)}`,
  )
  if (report.pendingAnalysisTaskId !== undefined) {
    lines.push(`DSH follow-up: queued (${display(report.pendingAnalysisTaskId)})`)
  } else if (report.verifiedAnalysis !== undefined) {
    lines.push(`DSH analysis: verified (${report.verifiedAnalysis.project_exposure}; ${report.verifiedAnalysis.confidence} confidence)`)
  } else if (report.monitoring === 'degraded') {
    lines.push('DSH follow-up: not currently recorded; restore the degraded monitoring path before relying on a clean result.')
  } else {
    lines.push('DSH follow-up: not currently queued in this state.')
  }
  lines.push(`Next command: ${report.nextCommand}`)
  if (report.acknowledgeCommand !== undefined) {
    lines.push(`After reviewing the task, acknowledge it with: ${report.acknowledgeCommand}`)
  }
  if (report.unmuteCommand !== undefined) lines.push(`To resume delivery: ${report.unmuteCommand}`)
  return `${lines.join('\n')}\n`
}
