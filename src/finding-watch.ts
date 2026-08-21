import { createHash } from 'node:crypto'

export const FINDING_WATCH_SCHEMA = 'upstream-radar.finding-watch/v1alpha1' as const

export type FindingWatchTransitionStatus = 'added' | 'resolved' | 'changed' | 'persisting'

export interface FindingWatchRecord {
  code: string
  severity: string
  summary: string
  detail?: string
  evidence?: unknown
  fingerprint: string
}

export interface FindingWatchTransition {
  code: string
  status: FindingWatchTransitionStatus
  previousCount: number
  currentCount: number
}

export interface FindingWatchDelta {
  changed: boolean
  transitions: FindingWatchTransition[]
}

export interface FindingWatchInput {
  code?: unknown
  severity?: unknown
  summary?: unknown
  detail?: unknown
  evidence?: unknown
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`
}

export function normalizeFinding(input: FindingWatchInput): FindingWatchRecord | undefined {
  if (typeof input.code !== 'string' || input.code === '') return undefined
  const severity = typeof input.severity === 'string' && input.severity !== '' ? input.severity : 'unknown'
  const summary = typeof input.summary === 'string' && input.summary !== '' ? input.summary : input.code
  const detail = typeof input.detail === 'string' && input.detail !== '' ? input.detail : undefined
  const evidence = input.evidence
  const identity = { code: input.code, severity, summary, ...(detail === undefined ? {} : { detail }), ...(evidence === undefined ? {} : { evidence }) }
  return {
    ...identity,
    fingerprint: fingerprint(identity),
  }
}

export function normalizeFindings(inputs: readonly FindingWatchInput[], watchedCodes: readonly string[]): FindingWatchRecord[] {
  const watched = new Set(watchedCodes)
  return inputs
    .map(normalizeFinding)
    .filter((finding): finding is FindingWatchRecord => finding !== undefined && watched.has(finding.code))
    .sort((left, right) => left.code.localeCompare(right.code) || left.fingerprint.localeCompare(right.fingerprint))
}

function groupedFingerprints(findings: readonly FindingWatchRecord[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const finding of findings) {
    const current = groups.get(finding.code) ?? []
    current.push(finding.fingerprint)
    groups.set(finding.code, current)
  }
  for (const values of groups.values()) values.sort()
  return groups
}

export function compareFindings(
  previous: readonly FindingWatchRecord[] | undefined,
  current: readonly FindingWatchRecord[],
  watchedCodes: readonly string[],
): FindingWatchDelta {
  const oldGroups = groupedFingerprints(previous ?? [])
  const currentGroups = groupedFingerprints(current)
  const codes = [...new Set([...watchedCodes, ...oldGroups.keys(), ...currentGroups.keys()])].sort()
  const transitions: FindingWatchTransition[] = []
  for (const code of codes) {
    const oldValues = oldGroups.get(code) ?? []
    const currentValues = currentGroups.get(code) ?? []
    let status: FindingWatchTransitionStatus
    if (oldValues.length === 0 && currentValues.length > 0) status = 'added'
    else if (oldValues.length > 0 && currentValues.length === 0) status = 'resolved'
    else if (JSON.stringify(oldValues) !== JSON.stringify(currentValues)) status = 'changed'
    else status = 'persisting'
    transitions.push({ code, status, previousCount: oldValues.length, currentCount: currentValues.length })
  }
  return {
    changed: transitions.some(item => item.status !== 'persisting'),
    transitions,
  }
}
