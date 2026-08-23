import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { satisfiesSemverRange } from '../src/semver.js'

describe('semantic version ranges', () => {
  it('treats the npm bare wildcard as an explicit match', () => {
    assert.equal(satisfiesSemverRange('4.0.1', '*'), true)
    assert.equal(satisfiesSemverRange('0.1.1-rc.2', '*'), true)
    assert.equal(satisfiesSemverRange('not-a-version', '*'), undefined)
  })
})
