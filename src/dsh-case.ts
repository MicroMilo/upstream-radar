import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { checkDshProfile, type DshProfileCheckReport } from './dsh-profile-check.js'

export const DSH_CASE_SCHEMA = 'upstream-radar.dsh-case/v1alpha1' as const

const CASE_ID = 'dsh-web-ui'
const CASE_SOURCE = 'dsh-web-ui issues #71 and #35'
const FIXTURE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'examples/cases/dsh-web-ui-issue-71',
)

export interface DshCaseFinding {
  code: string
  severity: string
  summary: string
  detail: string
  remediation: string
}

export interface DshCaseCheck {
  id: 'before' | 'manual-add' | 'fixed'
  status: DshProfileCheckReport['status']
  packageManager: DshProfileCheckReport['packageManager']
  lockfile?: string
  dependencyNodes: number
  loaderEntries: DshProfileCheckReport['loaderEntries']
  findings: DshCaseFinding[]
}

export interface DshCaseReport {
  schema: typeof DSH_CASE_SCHEMA
  case: typeof CASE_ID
  source: string
  networkFree: true
  checks: DshCaseCheck[]
  conclusion: {
    rootCause: string
    userImpact: string
    maintainerFix: string
    whyMonitoringMatters: string
    confidence: 'high'
  }
  execution: {
    network: false
    installs: false
    pluginCode: false
    dshStart: false
    dshAgent: false
    llm: false
  }
}

function compactCheck(id: DshCaseCheck['id'], report: DshProfileCheckReport): DshCaseCheck {
  return {
    id,
    status: report.status,
    packageManager: report.packageManager,
    ...(report.lockfile === undefined ? {} : { lockfile: report.lockfile }),
    dependencyNodes: report.dependencyGraph?.nodes.length ?? 0,
    loaderEntries: report.loaderEntries,
    findings: report.findings.map(finding => ({
      code: finding.code,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      remediation: finding.remediation,
    })),
  }
}

/**
 * Replay one real DSH profile failure and its maintainer fix from packaged
 * static fixtures. This is intentionally independent of DSH and any model so
 * the first-use command always produces a useful result.
 */
export async function createDshCaseReport(): Promise<DshCaseReport> {
  const fixtureDirectory = await realpath(FIXTURE_DIRECTORY)
  const checkedAt = [
    '2026-08-17T08:00:00.000Z',
    '2026-08-17T08:01:00.000Z',
    '2026-08-17T08:02:00.000Z',
  ] as const
  const ids = ['before', 'manual-add', 'fixed'] as const
  const checks: DshCaseCheck[] = []
  for (const [index, id] of ids.entries()) {
    const report = await checkDshProfile({
      profileDirectory: join(fixtureDirectory, id),
      checkedAt: checkedAt[index]!,
    })
    checks.push(compactCheck(id, report))
  }

  return {
    schema: DSH_CASE_SCHEMA,
    case: CASE_ID,
    source: CASE_SOURCE,
    networkFree: true,
    checks,
    conclusion: {
      rootCause: 'minimumReleaseAge kept the profile on an older bundle layout while the generated patch still inserted a standalone skin loader that the bundled carrier already owned.',
      userImpact: 'The profile is blocked before DSH starts; manually adding the missing package creates a duplicate loader id instead of fixing the profile.',
      maintainerFix: 'Upgrade the related @linxin666 packages, activate the bundled loader row, remove the standalone insert, and exempt the intended packages from the release-age cooling window.',
      whyMonitoringMatters: 'The same static check catches the broken profile, the misleading manual workaround, and the repaired configuration before plugin code runs.',
      confidence: 'high',
    },
    execution: {
      network: false,
      installs: false,
      pluginCode: false,
      dshStart: false,
      dshAgent: false,
      llm: false,
    },
  }
}

export function renderDshCase(report: DshCaseReport): string {
  const lines = [
    'Upstream Radar case — DSH web-ui #71',
    'Network-free; no install, plugin execution, DSH start, Agent, or LLM.',
    '',
  ]
  for (const check of report.checks) {
    const findings = check.findings.map(finding => finding.code).join(', ')
    const label = check.id === 'before'
      ? 'Before DSH starts'
      : check.id === 'manual-add'
        ? 'Manual package workaround'
        : 'Maintainer fix replay'
    lines.push(`${label}: ${check.status.toUpperCase()} — ${findings === '' ? 'no findings' : findings}`)
  }
  lines.push(
    '',
    `Root cause: ${report.conclusion.rootCause}`,
    `User impact: ${report.conclusion.userImpact}`,
    `Author fix: ${report.conclusion.maintainerFix}`,
    `Why monitor: ${report.conclusion.whyMonitoringMatters}`,
    '',
    'This is a local evidence replay. It does not claim that the referenced upstream issue is a live vulnerability.',
    '',
  )
  return `${lines.join('\n')}`
}
