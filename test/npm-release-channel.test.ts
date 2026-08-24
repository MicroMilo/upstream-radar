import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveNpmReleaseTag } from '../src/npm-release-channel.js'

describe('npm release channel selection', () => {
  it('prefers an explicit observer tag over package metadata', () => {
    assert.equal(resolveNpmReleaseTag({ publishConfig: { tag: 'alpha' } }, 'next'), 'next')
  })

  it('uses the source manifest publish tag when no explicit tag is configured', () => {
    assert.equal(resolveNpmReleaseTag({ publishConfig: { tag: 'alpha' } }), 'alpha')
  })

  it('defaults to latest only when the source declares no release channel', () => {
    assert.equal(resolveNpmReleaseTag({ name: 'demo-plugin', version: '1.0.0' }), 'latest')
  })

  it('rejects malformed declared tags instead of silently observing latest', () => {
    assert.throws(
      () => resolveNpmReleaseTag({ publishConfig: { tag: 'Alpha Channel' } }),
      /lowercase npm dist-tag/,
    )
    assert.throws(
      () => resolveNpmReleaseTag({ publishConfig: { tag: 42 } }),
      /non-empty lowercase npm dist-tag/,
    )
  })
})
