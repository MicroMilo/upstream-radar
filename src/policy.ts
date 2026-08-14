import type { Finding, Severity, Verdict } from './types.js'

const severityRank: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

const verdictRank: Record<Verdict, number> = {
  allow: 0,
  warn: 1,
  review: 2,
  block: 3,
}

export function decideVerdict(findings: readonly Finding[]): Verdict {
  const highest = findings.reduce<Severity>(
    (current, finding) => severityRank[finding.severity] > severityRank[current]
      ? finding.severity
      : current,
    'info',
  )

  if (highest === 'critical') return 'block'
  if (highest === 'high') return 'review'
  if (highest === 'medium' || highest === 'low') return 'warn'
  return 'allow'
}

export function verdictAtLeast(actual: Verdict, threshold: Verdict): boolean {
  return verdictRank[actual] >= verdictRank[threshold]
}

export function stricterVerdict(left: Verdict, right: Verdict): Verdict {
  return verdictRank[left] >= verdictRank[right] ? left : right
}
