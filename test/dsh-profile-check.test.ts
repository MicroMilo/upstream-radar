import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { checkDshProfile, renderDshProfileCheck, renderDshProfileCheckSummary } from '../src/dsh-profile-check.js'

const repository = resolve(import.meta.dirname, '..', '..')
const caseRoot = resolve(repository, 'examples/cases/dsh-web-ui-issue-71')

describe('DSH profile check', () => {
  it('finds the missing loader package and release-age risk before DSH starts', async () => {
    const report = await checkDshProfile({
      profileDirectory: resolve(caseRoot, 'before'),
      checkedAt: '2026-08-17T08:00:00.000Z',
    })
    assert.equal(report.status, 'blocked')
    assert.equal(report.packageManager, 'pnpm')
    assert.deepEqual(report.dependencyGraph?.nodes.map(node => `${node.name}@${node.version}`), [
      'dsh-profile-web@0.1.0',
      '@linxin666/dsh-client-ui-skin-center@0.1.4',
      '@linxin666/dsh-skins@0.1.5',
      '@linxin666/dsh-web-ui-all@0.1.5',
    ])
    assert.deepEqual(report.findings.map(finding => finding.code), [
      'minimum-release-age-unexcluded',
      'missing-loader-package',
    ])
    assert.equal(report.findings[1]?.evidence.packageNames?.[0], '@linxin666/dsh-client-ui-skin-qq98')
    assert.equal(report.execution.network, false)
    assert.equal(report.execution.pluginCode, false)
    assert.equal(report.execution.dshAgent, false)
    assert.equal(report.execution.llm, false)
    assert.match(renderDshProfileCheck(report), /do not start this profile/)
    const summary = renderDshProfileCheckSummary(report)
    assert.match(summary, /DSH profile dsh-profile-web@0\.1\.0: BLOCKED/)
    assert.match(summary, /missing-loader-package/)
    assert.match(summary, /do not start this profile until the findings are fixed/)
  })

  it('turns the manual package workaround into a duplicate-loader finding', async () => {
    const report = await checkDshProfile({ profileDirectory: resolve(caseRoot, 'manual-add') })
    assert.equal(report.status, 'blocked')
    assert.ok(report.findings.some(finding => finding.code === 'duplicate-loader-id'))
    assert.equal(report.findings.find(finding => finding.code === 'missing-loader-package'), undefined)
    assert.match(report.findings.find(finding => finding.code === 'duplicate-loader-id')?.detail ?? '', /ui-skin-qq98/)
  })

  it('passes after the bundled-carrier fix and release-age exclusions', async () => {
    const report = await checkDshProfile({
      profileDirectory: resolve(caseRoot, 'fixed'),
      checkedAt: '2026-08-17T08:02:00.000Z',
    })
    assert.equal(report.status, 'pass')
    assert.deepEqual(report.findings, [])
    assert.equal(report.dependencyGraph?.nodes.find(node => node.name === '@linxin666/dsh-web-ui-all')?.version, '0.1.7')
  })
})
