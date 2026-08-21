import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareFindings, normalizeFindings } from '../src/finding-watch.js'

describe('known finding watch', () => {
  it('keeps finding identity stable when evidence key order changes', () => {
    const previous = normalizeFindings([{
      code: 'dependency-install-script-present',
      severity: 'high',
      summary: 'Install script',
      detail: 'Review before install',
      evidence: { scripts: ['dep@1.0.0 install: node postinstall'], packages: ['dep@1.0.0'] },
    }], ['dependency-install-script-present'])
    const current = normalizeFindings([{
      code: 'dependency-install-script-present',
      severity: 'high',
      summary: 'Install script',
      detail: 'Review before install',
      evidence: { packages: ['dep@1.0.0'], scripts: ['dep@1.0.0 install: node postinstall'] },
    }], ['dependency-install-script-present'])
    assert.equal(previous[0]?.fingerprint, current[0]?.fingerprint)
    assert.deepEqual(compareFindings(previous, current, ['dependency-install-script-present']).transitions, [{
      code: 'dependency-install-script-present',
      status: 'persisting',
      previousCount: 1,
      currentCount: 1,
    }])
  })

  it('distinguishes an upstream fix, a new finding, and changed evidence', () => {
    const watched = ['dependency-graph-unavailable', 'lifecycle-script-present', 'npm-provenance-missing']
    const previous = normalizeFindings([
      { code: 'dependency-graph-unavailable', severity: 'info', summary: 'Graph unavailable' },
      { code: 'lifecycle-script-present', severity: 'high', summary: 'Lifecycle script', evidence: { scripts: ['prepare: old'] } },
    ], watched)
    const current = normalizeFindings([
      { code: 'lifecycle-script-present', severity: 'high', summary: 'Lifecycle script', evidence: { scripts: ['prepare: new'] } },
      { code: 'npm-provenance-missing', severity: 'medium', summary: 'No provenance' },
    ], watched)
    const delta = compareFindings(previous, current, watched)
    assert.equal(delta.changed, true)
    assert.deepEqual(delta.transitions, [
      { code: 'dependency-graph-unavailable', status: 'resolved', previousCount: 1, currentCount: 0 },
      { code: 'lifecycle-script-present', status: 'changed', previousCount: 1, currentCount: 1 },
      { code: 'npm-provenance-missing', status: 'added', previousCount: 0, currentCount: 1 },
    ])
  })

  it('does not let an unlisted finding enter the watch result', () => {
    const findings = normalizeFindings([
      { code: 'unrelated-signal', severity: 'medium', summary: 'Not in this watch' },
    ], ['npm-provenance-missing'])
    assert.deepEqual(findings, [])
  })
})
