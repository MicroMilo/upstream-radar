import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideVerdict, stricterVerdict } from '../src/policy.js'
import type { Finding, Severity } from '../src/types.js'

function finding(severity: Severity): Finding {
  return { code: severity, severity, summary: severity, detail: severity }
}

describe('default policy', () => {
  it('allows a report with no findings', () => {
    assert.equal(decideVerdict([]), 'allow')
  })

  it('maps medium findings to warn', () => {
    assert.equal(decideVerdict([finding('medium')]), 'warn')
  })

  it('maps high findings to review', () => {
    assert.equal(decideVerdict([finding('medium'), finding('high')]), 'review')
  })

  it('maps critical findings to block', () => {
    assert.equal(decideVerdict([finding('critical')]), 'block')
  })

  it('keeps the stricter of risk and coverage decisions', () => {
    assert.equal(stricterVerdict('allow', 'review'), 'review')
    assert.equal(stricterVerdict('block', 'review'), 'block')
  })
})
