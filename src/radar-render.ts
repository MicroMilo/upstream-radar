import type { CompatibilityEvent, RadarEvent, VulnerabilityEvent } from './radar-types.js'

function display(value: string, max = 2_048): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 1)}…`
}

function packageLabel(value: { name: string; version: string }): string {
  return `${display(value.name)}@${display(value.version)}`
}

function renderVulnerability(event: VulnerabilityEvent): string[] {
  const severity = event.kind === 'malware' ? 'CRITICAL' : event.advisory.severity.toUpperCase()
  const lines = [
    `[${severity}][${event.change.toUpperCase()}] ${event.kind === 'malware' ? 'Malicious package' : 'Dependency vulnerability'}`,
    `Project: ${display(event.project.name)} (${display(event.project.id)})`,
    `Plugin: ${packageLabel(event.plugin)}`,
    `Affected: ${packageLabel(event.affected)}`,
    `Advisory: ${display(event.advisory.id)}${event.advisory.aliases.length === 0 ? '' : ` / ${event.advisory.aliases.map(item => display(item)).join(', ')}`}`,
    `Summary: ${display(event.advisory.summary)}`,
  ]
  if (event.paths.length > 0) {
    lines.push('Paths:')
    for (const path of event.paths) lines.push(`  ${path.map(packageLabel).join(' -> ')}`)
  }
  lines.push(`Fixed versions: ${event.advisory.fixedVersions.length === 0 ? 'none published' : event.advisory.fixedVersions.map(item => display(item)).join(', ')}`)
  lines.push(`Route: ${event.route.owner === undefined ? '(no owner)' : display(event.route.owner)} via ${event.route.channels.map(item => display(item)).join(', ')}`)
  return lines
}

function renderCompatibility(event: CompatibilityEvent): string[] {
  const lines = [
    `[COMPATIBILITY][${event.change.toUpperCase()}] ${event.change === 'resolved' ? 'Candidate risk no longer applies' : 'Candidate update needs project analysis'}`,
    `Project: ${display(event.project.name)} (${display(event.project.id)})`,
    `Installed plugin: ${packageLabel(event.plugin)}`,
    `Changed package: ${packageLabel(event.installed)}`,
    `Candidate: ${packageLabel(event.candidate)}`,
    'Signals:',
  ]
  for (const signal of event.signals) {
    lines.push(`  [${signal.confidence.toUpperCase()}] ${display(signal.code)}: ${display(signal.summary)}`)
  }
  lines.push(`Route: ${event.route.owner === undefined ? '(no owner)' : display(event.route.owner)} via ${event.route.channels.map(item => display(item)).join(', ')}`)
  return lines
}

export function renderRadarEvent(event: RadarEvent): string {
  return `${(event.kind === 'compatibility' ? renderCompatibility(event) : renderVulnerability(event)).join('\n')}\n`
}

export function renderRadarEvents(events: readonly RadarEvent[]): string {
  if (events.length === 0) return 'No vulnerability or compatibility changes require attention.\n'
  return events.map(renderRadarEvent).join('\n')
}
