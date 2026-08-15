import type { RadarSeverity, RadarState, VulnerabilityEvent } from './radar-types.js'

export type RadarFailThreshold = RadarSeverity | 'never'

export interface RadarPolicyMatch {
  incidentId: string
  kind: VulnerabilityEvent['kind']
  project: string
  severity: RadarSeverity
  package: string
  advisory: string
}

export interface RadarPolicyResult {
  threshold: RadarFailThreshold
  status: 'pass' | 'fail'
  matches: RadarPolicyMatch[]
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

export function evaluateRadarPolicy(state: RadarState, threshold: RadarFailThreshold): RadarPolicyResult {
  if (threshold === 'never') return { threshold, status: 'pass', matches: [] }
  const minimum = SEVERITY_RANK[threshold]
  const matches = Object.values(state.activeVulnerabilities)
    .map(item => policyMatch(item.event))
    .filter(item => SEVERITY_RANK[item.severity] >= minimum)
    .sort((left, right) => (
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
        || left.project.localeCompare(right.project)
        || left.incidentId.localeCompare(right.incidentId)
    ))
  return {
    threshold,
    status: matches.length === 0 ? 'pass' : 'fail',
    matches,
  }
}

export function renderRadarPolicy(policy: RadarPolicyResult): string {
  if (policy.threshold === 'never') return 'Policy: not enforced\n'
  if (policy.status === 'pass') {
    return `Policy: PASS (no active vulnerability at or above ${policy.threshold})\n`
  }
  const lines = [`Policy: FAIL (active vulnerability at or above ${policy.threshold})`]
  for (const match of policy.matches) {
    lines.push(`  [${match.severity.toUpperCase()}] ${match.project}: ${match.package} (${match.advisory})`)
  }
  return `${lines.join('\n')}\n`
}
