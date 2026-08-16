import type {
  CompatibilityEvent,
  RadarEvent,
  RadarState,
  SourceHealthEvent,
  VulnerabilityEvent,
} from './radar-types.js'
import { RADAR_HISTORY_SCHEMA } from './radar-types.js'

export const RADAR_HISTORY_REPORT_SCHEMA = RADAR_HISTORY_SCHEMA

export interface RadarHistoryReport {
  schema: typeof RADAR_HISTORY_REPORT_SCHEMA
  configFile: string
  stateFile: string
  stateExists: boolean
  limit: number
  totalRecorded: number
  events: RadarEvent[]
}

export interface CreateRadarHistoryOptions {
  configFile: string
  stateFile: string
  stateExists: boolean
  limit: number
}

function display(value: string, maxLength = 512): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= maxLength ? escaped : `${escaped.slice(0, maxLength)}…`
}

function packageLabel(value: { name: string; version: string }): string {
  return `${display(value.name)}@${display(value.version)}`
}

function vulnerabilitySummary(event: VulnerabilityEvent): string {
  const path = event.paths[0]?.map(packageLabel).join(' -> ') ?? 'dependency path unavailable'
  const kind = event.kind === 'malware' ? 'malicious package' : 'vulnerability'
  return `${kind}: ${packageLabel(event.affected)} (${display(event.advisory.id)}) via ${path}`
}

function compatibilitySummary(event: CompatibilityEvent): string {
  const signal = event.signals[0]?.summary
  return `compatibility: ${packageLabel(event.installed)} -> ${packageLabel(event.candidate)}${signal === undefined ? '' : ` — ${display(signal, 1_024)}`}`
}

function sourceHealthSummary(event: SourceHealthEvent): string {
  return `source health: ${display(event.source)} ${display(event.status)} after ${event.failureCount} consecutive check(s)`
}

function eventSummary(event: RadarEvent): string {
  if (event.kind === 'compatibility') return compatibilitySummary(event)
  if (event.kind === 'source-health') return sourceHealthSummary(event)
  return vulnerabilitySummary(event)
}

function newestFirst(left: RadarEvent, right: RadarEvent): number {
  return right.detectedAt.localeCompare(left.detectedAt) || right.id.localeCompare(left.id)
}

/** Build a bounded, network-free view of the durable transition ledger. */
export function createRadarHistory(
  state: RadarState,
  options: CreateRadarHistoryOptions,
): RadarHistoryReport {
  const all = [...(state.history ?? [])].sort(newestFirst)
  return {
    schema: RADAR_HISTORY_REPORT_SCHEMA,
    configFile: options.configFile,
    stateFile: options.stateFile,
    stateExists: options.stateExists,
    limit: options.limit,
    totalRecorded: all.length,
    events: all.slice(0, options.limit),
  }
}

/** Render a short audit trail for a person investigating repeated alerts. */
export function renderRadarHistory(report: RadarHistoryReport): string {
  const lines = [
    'Upstream Radar history',
    `State: ${display(report.stateFile)}${report.stateExists ? '' : ' (not created yet)'}`,
    `Showing ${report.events.length} of ${report.totalRecorded} recorded transition(s)`,
  ]
  if (report.events.length === 0) {
    lines.push('', 'No recorded Radar events.')
    return `${lines.join('\n')}\n`
  }
  lines.push('', 'TIME\tCHANGE\tKIND\tPROJECT\tDETAILS')
  for (const event of report.events) {
    lines.push([
      display(event.detectedAt),
      event.change.toUpperCase(),
      event.kind,
      display(event.project.name),
      display(eventSummary(event), 4_096),
    ].join('\t'))
  }
  return `${lines.join('\n')}\n`
}
