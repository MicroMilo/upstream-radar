import type { CompatibilityEvent, RadarSeverity, RadarState, VulnerabilityEvent } from './radar-types.js'

export type RadarFailThreshold = RadarSeverity | 'never'
export type RadarCompatibilityFailThreshold = 'never' | 'breaking' | 'any'

export interface RadarPolicyMatch {
  incidentId: string
  kind: VulnerabilityEvent['kind']
  project: string
  severity: RadarSeverity
  package: string
  advisory: string
}

export interface RadarCompatibilityPolicyMatch {
  incidentId: string
  project: string
  plugin: string
  installed: string
  candidate: string
  signals: string[]
}

export interface RadarPolicyResult {
  threshold: RadarFailThreshold
  status: 'pass' | 'fail'
  matches: RadarPolicyMatch[]
  compatibilityThreshold?: Exclude<RadarCompatibilityFailThreshold, 'never'>
  compatibilityMatches?: RadarCompatibilityPolicyMatch[]
}

const SEVERITY_RANK: Record<RadarSeverity, number> = {
  unknown: 0,
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
}

export const RADAR_FAIL_THRESHOLDS: readonly RadarFailThreshold[] = [
  'unknown',
  'info',
  'low',
  'medium',
  'high',
  'critical',
  'never',
]

export const RADAR_COMPATIBILITY_FAIL_THRESHOLDS: readonly RadarCompatibilityFailThreshold[] = [
  'never',
  'breaking',
  'any',
]

function display(value: string, maxLength = 512): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= maxLength ? escaped : `${escaped.slice(0, maxLength)}…`
}

function effectiveSeverity(event: VulnerabilityEvent): RadarSeverity {
  return event.kind === 'malware' ? 'critical' : event.advisory.severity
}

function policyMatch(event: VulnerabilityEvent): RadarPolicyMatch {
  return {
    incidentId: display(event.incidentId),
    kind: event.kind,
    project: display(event.project.name),
    severity: effectiveSeverity(event),
    package: display(`${event.affected.name}@${event.affected.version}`),
    advisory: display(event.advisory.id),
  }
}

function compatibilityPolicyMatch(event: CompatibilityEvent): RadarCompatibilityPolicyMatch {
  return {
    incidentId: display(event.incidentId),
    project: display(event.project.name),
    plugin: display(`${event.plugin.name}@${event.plugin.version}`),
    installed: display(`${event.installed.name}@${event.installed.version}`),
    candidate: display(`${event.candidate.name}@${event.candidate.version}`),
    signals: event.signals.map(signal => display(signal.code, 128)).slice(0, 32),
  }
}

function hasBreakingCompatibilitySignal(event: CompatibilityEvent): boolean {
  return event.signals.some(signal => signal.confidence === 'confirmed' || signal.confidence === 'strong')
}

export function evaluateRadarPolicy(
  state: RadarState,
  threshold: RadarFailThreshold,
  compatibilityThreshold: RadarCompatibilityFailThreshold = 'never',
): RadarPolicyResult {
  const matches = threshold === 'never'
    ? []
    : Object.values(state.activeVulnerabilities)
      .map(item => policyMatch(item.event))
      .filter(item => SEVERITY_RANK[item.severity] >= SEVERITY_RANK[threshold])
      .sort((left, right) => (
        SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
          || left.project.localeCompare(right.project)
          || left.incidentId.localeCompare(right.incidentId)
      ))
  const compatibilityMatches = compatibilityThreshold === 'never'
    ? []
    : Object.values(state.activeCompatibility)
      .map(item => item.event)
      .filter(event => compatibilityThreshold === 'any' || hasBreakingCompatibilitySignal(event))
      .map(compatibilityPolicyMatch)
      .sort((left, right) => (
        left.project.localeCompare(right.project)
          || left.plugin.localeCompare(right.plugin)
          || left.incidentId.localeCompare(right.incidentId)
      ))
  const result: RadarPolicyResult = {
    threshold,
    status: matches.length === 0 && compatibilityMatches.length === 0 ? 'pass' : 'fail',
    matches,
  }
  if (compatibilityThreshold === 'never') return result
  return {
    ...result,
    compatibilityThreshold,
    compatibilityMatches,
  }
}

export function renderRadarPolicy(policy: RadarPolicyResult): string {
  const compatibilityEnabled = policy.compatibilityThreshold !== undefined
  if (policy.threshold === 'never' && !compatibilityEnabled) return 'Policy: not enforced\n'
  const lines: string[] = []
  if (policy.threshold !== 'never') {
    if (policy.matches.length === 0) {
      lines.push(`Policy: PASS (no active vulnerability at or above ${policy.threshold})`)
    } else {
      lines.push(`Policy: FAIL (active vulnerability at or above ${policy.threshold})`)
      for (const match of policy.matches) {
        lines.push(`  [${match.severity.toUpperCase()}] ${match.project}: ${match.package} (${match.advisory})`)
      }
    }
  }
  if (compatibilityEnabled) {
    const threshold = policy.compatibilityThreshold
    const matches = policy.compatibilityMatches ?? []
    if (matches.length === 0) {
      lines.push(`Compatibility policy: PASS (no active ${threshold === 'breaking' ? 'breaking ' : ''}compatibility change)`)
    } else {
      lines.push(`Compatibility policy: FAIL (active ${threshold === 'breaking' ? 'breaking ' : ''}compatibility change)`)
      for (const match of matches) {
        lines.push(`  [${threshold === 'breaking' ? 'BREAKING' : 'CHANGE'}] ${match.project}: ${match.plugin} ${match.installed} -> ${match.candidate} (${match.signals.join(', ')})`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}
