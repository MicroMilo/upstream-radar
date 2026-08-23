import {
  parseDshCompatibilityLedger,
  type DshCompatibilityLedgerEntry,
} from './dsh-compatibility-ledger.js'

const CASE_MARKER = /<!-- upstream-radar:dsh-compatibility-case=([a-z0-9][a-z0-9._-]{0,63}) -->/
const ACTIONABLE_RESULTS = new Set<DshCompatibilityLedgerEntry['result']>([
  'runtime-incompatible',
  'peer-contract-incompatible',
  'install-failed',
  'load-failed',
])

export const DSH_COMPATIBILITY_ISSUE_LABELS = ['upstream-radar', 'dsh-compatibility'] as const

export interface DshCompatibilityExistingIssue {
  number: number
  state: 'open' | 'closed'
  title: string
  body: string
}

export type DshCompatibilityIssueAction =
  | {
      kind: 'create'
      caseId: string
      title: string
      body: string
    }
  | {
      kind: 'update' | 'reopen'
      caseId: string
      issueNumber: number
      title: string
      body: string
    }
  | {
      kind: 'close'
      caseId: string
      issueNumber: number
      comment: string
    }

export interface DshCompatibilityIssuePlan {
  actions: DshCompatibilityIssueAction[]
  openCaseIds: string[]
  ignoredUnknownCaseIds: string[]
}

function inline(value: string, maximum = 1_024): string {
  return value
    .replace(/[\u0000-\u001f\u007f`|<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function runLink(runUrl: string | undefined): string {
  if (runUrl === undefined) return 'not recorded'
  try {
    const parsed = new URL(runUrl)
    if (parsed.protocol !== 'https:') return 'not recorded'
    return `[GitHub Actions evidence](${parsed.toString()})`
  } catch {
    return 'not recorded'
  }
}

export function dshCompatibilityIssueMarker(caseId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(caseId)) throw new Error(`invalid DSH compatibility case id: ${caseId}`)
  return `<!-- upstream-radar:dsh-compatibility-case=${caseId} -->`
}

export function dshCompatibilityIssueCaseId(body: string): string | undefined {
  return CASE_MARKER.exec(body)?.[1]
}

function repairPath(entry: DshCompatibilityLedgerEntry): string[] {
  if (entry.result === 'runtime-incompatible') {
    return [
      'Confirm which Node.js majors the plugin and DSH release are intended to support.',
      'Align the published `engines.node` contract or add a tested runtime cell that satisfies it.',
    ]
  }
  if (entry.result === 'peer-contract-incompatible') {
    return [
      'Align required DSH/React peer ranges with the versions the final DSH profile actually provides.',
      'Re-run the same plugin, DSH and Node cell; a successful headless boot alone is not enough when a required peer remains missing or mismatched.',
    ]
  }
  if (entry.result === 'install-failed') {
    return [
      'Reproduce the package-manager failure with the exact artifact and approved dependency-build policy below.',
      'Publish a corrected artifact or narrow the supported DSH/runtime contract, then let Radar perform the next clean install.',
    ]
  }
  return [
    'Reproduce the DSH registration/import/boot failure with the exact coordinates below.',
    'Fix the runtime integration or declare the unsupported DSH boundary, then let Radar perform the next clean load.',
  ]
}

function peerEvidence(entry: DshCompatibilityLedgerEntry): string[] {
  const contracts = entry.resolution?.runtimeGraph?.pluginPeerContracts
  if (contracts === undefined) return []
  const lines = [
    '',
    '### Direct host contracts',
    '',
    `- Declared: **${contracts.declared}**; satisfied: **${contracts.satisfied}**; mismatched: **${contracts.mismatched}**; missing: **${contracts.missing}**; indeterminate: **${contracts.indeterminate}**.`,
  ]
  for (const issue of contracts.issues ?? []) {
    lines.push(`- \`${inline(issue.name, 214)}\`: ${inline(issue.status, 32)}; requires \`${inline(issue.required, 512)}\`${issue.resolvedVersion === undefined ? '' : `, resolved \`${inline(issue.resolvedVersion, 256)}\``}; static use: \`${inline(issue.staticUsage, 64)}\`.`)
  }
  return lines
}

export function renderDshCompatibilityIssue(
  entry: DshCompatibilityLedgerEntry,
  runUrl?: string,
): { title: string, body: string } {
  const title = `[DSH compatibility] ${inline(entry.plugin, 160)} on DSH ${inline(entry.dshVersion, 64)} / Node ${entry.runtime.nodeMajor}: ${entry.result}`.slice(0, 256)
  const graph = entry.resolution?.runtimeGraph
  const lockfile = entry.resolution?.profileLockfile
  const lines = [
    dshCompatibilityIssueMarker(entry.caseId),
    '',
    'Upstream Radar reproduced an incompatibility in a disposable GitHub-hosted environment. This is an internal compatibility incident; forward it to an upstream author only after reviewing the attached evidence.',
    '',
    '### Exact cell',
    '',
    `- Plugin: \`${inline(entry.plugin, 512)}\``,
    `- DSH: \`@deepseek-ai/dsh@${inline(entry.dshVersion, 128)}\``,
    `- Runtime: Node \`${inline(entry.runtime.nodeVersion, 64)}\` on \`${inline(`${entry.runtime.platform}/${entry.runtime.architecture}`, 128)}\``,
    `- Result: \`${entry.result}\``,
    `- Observed: \`${inline(entry.observedAt, 64)}\``,
    `- Artifact: ${entry.artifact.sha256 === undefined ? 'digest unavailable' : `\`sha256:${inline(entry.artifact.sha256, 64)}\``}`,
    `- Evidence run: ${runLink(runUrl)}`,
    '',
    '### Reproduced failure',
    '',
    inline(entry.reason, 4_096),
  ]
  if (graph !== undefined || lockfile !== undefined) {
    lines.push(
      '',
      '### Dependency evidence',
      '',
      `- Final profile graph: ${lockfile === undefined ? 'not established' : `${lockfile.nodes} node(s), ${lockfile.edges} edge(s), ${lockfile.unresolved} unresolved edge(s)`}.`,
      `- Effective runtime graph: ${graph === undefined ? 'not established' : `${graph.nodes} node(s), ${graph.edges} edge(s), ${graph.unresolved} required unresolved edge(s)`}.`,
    )
  }
  lines.push(...peerEvidence(entry), '', '### Repair path', '')
  for (const item of repairPath(entry)) lines.push(`- ${item}`)
  lines.push(
    '',
    'This issue is managed by Upstream Radar. A later compatible observation for the same maintained cell will add a resolution note and close it automatically.',
    '',
    '_Bounded compatibility evidence is not a claim that third-party code is safe or malicious._',
    '',
  )
  return { title, body: lines.join('\n').slice(0, 60_000) }
}

export function renderDshCompatibilityResolution(entry: DshCompatibilityLedgerEntry, runUrl?: string): string {
  return [
    `<!-- upstream-radar:dsh-compatibility-resolution=${entry.caseId}:${entry.contractFingerprint} -->`,
    '',
    'Upstream Radar re-ran this maintained cell in a fresh isolated environment and the exact package now installs, registers and loads with a complete required host contract.',
    '',
    `- Plugin: \`${inline(entry.plugin, 512)}\``,
    `- DSH: \`@deepseek-ai/dsh@${inline(entry.dshVersion, 128)}\``,
    `- Runtime: Node \`${inline(entry.runtime.nodeVersion, 64)}\``,
    `- Observed: \`${inline(entry.observedAt, 64)}\``,
    `- Evidence run: ${runLink(runUrl)}`,
    '',
    'Closing this compatibility incident as verified resolved.',
  ].join('\n')
}

function existingByCase(issues: readonly DshCompatibilityExistingIssue[]): Map<string, DshCompatibilityExistingIssue> {
  const result = new Map<string, DshCompatibilityExistingIssue>()
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error('existing compatibility issue has an invalid number')
    if (issue.state !== 'open' && issue.state !== 'closed') throw new Error(`issue #${issue.number} has an invalid state`)
    const caseId = dshCompatibilityIssueCaseId(issue.body)
    if (caseId === undefined) continue
    const duplicate = result.get(caseId)
    if (duplicate !== undefined) throw new Error(`duplicate managed compatibility issues for ${caseId}: #${duplicate.number} and #${issue.number}`)
    result.set(caseId, issue)
  }
  return result
}

/** Build an idempotent desired-state plan for issues in Radar's own repository. */
export function buildDshCompatibilityIssuePlan(input: {
  ledger: unknown
  existingIssues: readonly DshCompatibilityExistingIssue[]
  runUrl?: string
}): DshCompatibilityIssuePlan {
  const ledger = parseDshCompatibilityLedger(input.ledger)
  const existing = existingByCase(input.existingIssues)
  const actions: DshCompatibilityIssueAction[] = []
  const openCaseIds: string[] = []
  const ignoredUnknownCaseIds: string[] = []

  for (const entry of ledger.entries) {
    const issue = existing.get(entry.caseId)
    if (entry.result === 'unknown') {
      ignoredUnknownCaseIds.push(entry.caseId)
      continue
    }
    if (entry.result === 'compatible') {
      if (issue?.state === 'open') {
        actions.push({
          kind: 'close',
          caseId: entry.caseId,
          issueNumber: issue.number,
          comment: renderDshCompatibilityResolution(entry, input.runUrl),
        })
      }
      continue
    }
    if (!ACTIONABLE_RESULTS.has(entry.result)) continue
    openCaseIds.push(entry.caseId)
    const rendered = renderDshCompatibilityIssue(entry, input.runUrl)
    if (issue === undefined) {
      actions.push({ kind: 'create', caseId: entry.caseId, ...rendered })
    } else if (issue.state === 'closed') {
      actions.push({ kind: 'reopen', caseId: entry.caseId, issueNumber: issue.number, ...rendered })
    } else if (issue.title !== rendered.title || issue.body !== rendered.body) {
      actions.push({ kind: 'update', caseId: entry.caseId, issueNumber: issue.number, ...rendered })
    }
  }

  return {
    actions,
    openCaseIds: openCaseIds.sort(),
    ignoredUnknownCaseIds: ignoredUnknownCaseIds.sort(),
  }
}
