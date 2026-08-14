import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NpmReleaseClient } from '../src/npm-release.js'

describe('npm release source', () => {
  it('returns the current and latest manifests without installing either release', async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      'dist-tags': { latest: '2.0.0' },
      versions: {
        '1.0.0': { name: 'plugin', version: '1.0.0', main: './old.js', engines: { node: '>=22' } },
        '2.0.0': { name: 'plugin', version: '2.0.0', main: './new.js', engines: { node: '>=24' } },
      },
      time: { '2.0.0': '2026-08-14T02:00:00.000Z' },
    })
    const client = new NpmReleaseClient({ fetch: fetcher })
    const result = await client.query([{ ecosystem: 'npm', name: 'plugin', version: '1.0.0' }])
    const change = result.get('npm:plugin@1.0.0')
    assert.equal(change?.previous.main, './old.js')
    assert.equal(change?.candidate.version, '2.0.0')
    assert.equal(change?.publishedAt, '2026-08-14T02:00:00.000Z')
  })
})
