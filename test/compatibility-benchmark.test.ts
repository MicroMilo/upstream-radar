import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderCompatibilityBenchmark, runCompatibilityBenchmark } from '../src/compatibility-benchmark.js'

describe('compatibility benchmark', () => {
  it('keeps the rule and CI-gate contracts explicit and passing', () => {
    const report = runCompatibilityBenchmark()
    assert.equal(report.mode, 'offline-rules')
    assert.deepEqual(report.summary, { total: 6, passed: 6, failed: 0 })
    assert.deepEqual(report.cases.map(item => item.id), [
      'safe-patch',
      'analysis-only-entrypoint-change',
      'dsh-peer-incompatible',
      'publisher-breaking',
      'candidate-transitive-vulnerability',
      'incomplete-candidate-graph',
    ])
    assert.equal(report.cases.every(item => item.passed), true)
    assert.equal(report.cases.find(item => item.id === 'analysis-only-entrypoint-change')?.actual.breaking, 'pass')
    assert.equal(report.cases.find(item => item.id === 'analysis-only-entrypoint-change')?.actual.any, 'fail')
    assert.equal(report.cases.find(item => item.id === 'dsh-peer-incompatible')?.actual.breaking, 'fail')
    assert.match(renderCompatibilityBenchmark(report), /6\/6 benchmark contracts passed/)
  })
})
