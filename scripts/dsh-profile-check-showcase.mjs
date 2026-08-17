import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CASE_ROOT = join(ROOT, 'examples/cases/dsh-web-ui-issue-71')
const REPORT_PATH = join(ROOT, 'examples/dsh/reports/dsh-web-ui-issue-71-profile-check.json')
const writeReport = process.argv.includes('--write-report')

const { checkDshProfile } = await import('../dist/src/dsh-profile-check.js')

const cases = [
  {
    id: 'issue-71-before',
    directory: join(CASE_ROOT, 'before'),
    checkedAt: '2026-08-17T08:00:00.000Z',
    expectedStatus: 'blocked',
    expectedFindings: ['minimum-release-age-unexcluded', 'missing-loader-package'],
  },
  {
    id: 'issue-35-manual-add',
    directory: join(CASE_ROOT, 'manual-add'),
    checkedAt: '2026-08-17T08:01:00.000Z',
    expectedStatus: 'blocked',
    expectedFindings: ['duplicate-loader-id', 'minimum-release-age-unexcluded'],
  },
  {
    id: 'issue-71-fixed',
    directory: join(CASE_ROOT, 'fixed'),
    checkedAt: '2026-08-17T08:02:00.000Z',
    expectedStatus: 'pass',
    expectedFindings: [],
  },
]

const results = []
for (const item of cases) {
  const report = await checkDshProfile({ profileDirectory: item.directory, checkedAt: item.checkedAt })
  assert.equal(report.status, item.expectedStatus, `${item.id} status`)
  assert.deepEqual(report.findings.map(finding => finding.code).sort(), [...item.expectedFindings].sort(), `${item.id} findings`)
  assert.equal(report.execution.llm, false, `${item.id} must not call an LLM`)
  assert.equal(report.execution.dshAgent, false, `${item.id} must not call DSH Agent`)
  results.push({
    id: item.id,
    status: report.status,
    packageManager: report.packageManager,
    lockfile: report.lockfile,
    graph: report.dependencyGraph === undefined
      ? undefined
      : {
          nodes: report.dependencyGraph.nodes.map(node => `${node.name}@${node.version}`),
          edges: report.dependencyGraph.edges.length,
          digest: report.dependencyGraph.digest,
        },
    loaderEntries: report.loaderEntries,
    findings: report.findings.map(finding => ({
      code: finding.code,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      remediation: finding.remediation,
    })),
    execution: report.execution,
  })
}

const output = {
  schema: 'upstream-radar.dsh-profile-case-showcase/v1alpha1',
  case: {
    name: 'dsh-web-ui release-age / skin loader mismatch',
    source: [
      'https://github.com/zhu1090093659/dsh-web-ui/issues/71',
      'https://github.com/zhu1090093659/dsh-web-ui/issues/35',
    ],
    claim: 'Replay only: the checked-in profile facts mirror the versions and patch rows described by the public issues; no plugin or DSH process is started.',
  },
  results,
  conclusion: {
    detectedBeforeStart: true,
    correctFixReachesPass: true,
    dshAgentCalls: 0,
    llmCalls: 0,
  },
}

if (writeReport) await writeFile(REPORT_PATH, `${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
