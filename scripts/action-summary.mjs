import { readFile } from 'node:fs/promises'

const reportPath = process.argv[2]
if (reportPath === undefined) throw new Error('an Action JSON report path is required')

const report = JSON.parse(await readFile(reportPath, 'utf8'))

function text(value, maxLength = 1_024) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
      `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
    ))
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('<', '\\<')
    .replaceAll('>', '\\>')
    .slice(0, maxLength)
}

function code(value, maxLength = 512) {
  return `\`${text(value, maxLength)}\``
}

function packageLabel(value) {
  if (typeof value !== 'object' || value === null) return 'unknown package'
  return `${value.name ?? 'unknown'}@${value.version ?? 'unknown'}`
}

function pathLabel(path) {
  return Array.isArray(path) && path.length > 0
    ? path.map(packageLabel).join(' → ')
    : 'dependency path unavailable'
}

function vulnerabilityGuidance(event) {
  if (event?.change === 'resolved') {
    return {
      fix: 'incident resolved',
      next: 'Confirm the installed graph no longer matches this incident.',
    }
  }
  if (event?.kind === 'malware') {
    return {
      fix: 'remove or isolate the plugin',
      next: `Remove or isolate ${packageLabel(event.plugin)} and investigate project exposure.`,
    }
  }
  const fixedVersions = Array.isArray(event?.advisory?.fixedVersions)
    ? event.advisory.fixedVersions.slice(0, 8).map(String).join(', ')
    : ''
  return fixedVersions.length === 0
    ? {
        fix: 'none published',
        next: `Assess containment or replacement for ${packageLabel(event?.plugin)}.`,
      }
    : {
        fix: fixedVersions,
        next: `Review ${packageLabel(event?.affected)} fixed version(s) ${fixedVersions} before changing the plugin.`,
      }
}

function eventLine(event) {
  if (event?.kind === 'compatibility') {
    const signal = Array.isArray(event.signals) ? event.signals[0]?.summary : undefined
    const nextStep = event.change === 'resolved'
      ? 'no action; confirm the current graph and source are up to date'
      : 'inspect project impact before applying the candidate'
    return `${text(event.change?.toUpperCase())} · compatibility · ${code(packageLabel(event.installed))} → ${code(packageLabel(event.candidate))}${signal === undefined ? '' : ` — ${text(signal, 1_024)}`} · next: ${nextStep}`
  }
  if (event?.kind === 'source-health') {
    const nextStep = event.change === 'resolved'
      ? 'no action; continue monitoring'
      : 'restore the source before treating no alerts as clean'
    return `${text(event.change?.toUpperCase())} · source health · ${code(event.source)} is ${text(event.status)} after ${text(event.failureCount)} consecutive check(s) · next: ${nextStep}`
  }
  const severity = event?.kind === 'malware' ? 'CRITICAL' : String(event?.advisory?.severity ?? 'unknown').toUpperCase()
  const path = pathLabel(event?.paths?.[0])
  const guidance = vulnerabilityGuidance(event)
  return `${text(event?.change?.toUpperCase())} · ${severity} · ${text(event?.kind ?? 'vulnerability')} · ${code(packageLabel(event?.affected))} (${code(event?.advisory?.id ?? 'advisory')}) via ${code(path, 2_048)} · fix: ${text(guidance.fix, 512)} · next: ${text(guidance.next, 1_024)}`
}

const events = Array.isArray(report.events) ? report.events : []
const sourceErrors = Array.isArray(report.sourceErrors) ? report.sourceErrors : []
const policy = typeof report.policy === 'object' && report.policy !== null ? report.policy : undefined
const status = sourceErrors.length > 0
  ? '⚠️ source check incomplete'
  : policy?.status === 'fail' ? '❌ policy threshold matched' : '✅ check completed'
const lines = [
  '## Upstream Radar',
  '',
  `**${status}** · ${text(report.packagesQueried ?? 0)} exact package version(s) checked · ${text(report.releasePackagesQueried ?? 0)} release stream(s) checked`,
]

if (events.length === 0) {
  lines.push('', 'No changed events were emitted.')
} else {
  lines.push('', `### Changes (${events.length})`, '')
  for (const event of events.slice(0, 64)) {
    lines.push(`- ${eventLine(event)}`)
  }
  if (events.length > 64) lines.push(`- … ${events.length - 64} more event(s) are in the raw JSON log.`)
}

if (sourceErrors.length > 0) {
  lines.push('', '### Source warnings', '')
  for (const error of sourceErrors.slice(0, 16)) {
    lines.push(`- ${code(error?.source ?? 'unknown source')}: ${text(error?.message ?? 'unknown error', 2_048)}`)
  }
}

lines.push('', '_The raw JSON emitted by the Action remains the authoritative machine-readable result._', '')
process.stdout.write(lines.join('\n'))
