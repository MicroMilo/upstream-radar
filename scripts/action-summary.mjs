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

function eventLine(event) {
  if (event?.kind === 'compatibility') {
    const signal = Array.isArray(event.signals) ? event.signals[0]?.summary : undefined
    return `${text(event.change?.toUpperCase())} · compatibility · ${code(packageLabel(event.installed))} → ${code(packageLabel(event.candidate))}${signal === undefined ? '' : ` — ${text(signal, 1_024)}`}`
  }
  if (event?.kind === 'source-health') {
    return `${text(event.change?.toUpperCase())} · source health · ${code(event.source)} is ${text(event.status)} after ${text(event.failureCount)} consecutive check(s)`
  }
  const severity = event?.kind === 'malware' ? 'CRITICAL' : String(event?.advisory?.severity ?? 'unknown').toUpperCase()
  const path = pathLabel(event?.paths?.[0])
  return `${text(event?.change?.toUpperCase())} · ${severity} · ${text(event?.kind ?? 'vulnerability')} · ${code(packageLabel(event?.affected))} (${code(event?.advisory?.id ?? 'advisory')}) via ${code(path, 2_048)}`
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

