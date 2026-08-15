import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NpmReleaseClient } from '../src/npm-release.js'

describe('npm release source', () => {
  it('returns the current and latest manifests without installing either release', async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      'dist-tags': { latest: '2.0.0' },
      versions: {
        '1.0.0': { name: 'plugin', version: '1.0.0', main: './old.js', engines: { node: '>=22' } },
        '2.0.0': {
          name: 'plugin',
          version: '2.0.0',
          main: './new.js',
          engines: { node: '>=24' },
          repository: { type: 'git', url: 'git+https://github.com/acme/plugin.git' },
        },
      },
      time: { '2.0.0': '2026-08-14T02:00:00.000Z' },
    })
    const client = new NpmReleaseClient({ fetch: fetcher })
    const result = await client.query([{ ecosystem: 'npm', name: 'plugin', version: '1.0.0' }])
    const change = result.get('npm:plugin@1.0.0')
    assert.equal(change?.previous.main, './old.js')
    assert.equal(change?.candidate.version, '2.0.0')
    assert.equal(change?.publishedAt, '2026-08-14T02:00:00.000Z')
    assert.equal(change?.repository, 'git+https://github.com/acme/plugin.git')
    assert.equal(change?.candidateStatus, 'newer')
    assert.deepEqual(change?.upgradeCandidates?.map(item => item.version), ['2.0.0'])
  })

  it('returns newer exact manifests in ascending order without installing them', async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      'dist-tags': { latest: '2.0.0' },
      versions: {
        '1.0.0': { name: 'plugin', version: '1.0.0' },
        '1.2.0': { name: 'plugin', version: '1.2.0' },
        '1.1.0': { name: 'plugin', version: '1.1.0' },
        '2.0.0': { name: 'plugin', version: '2.0.0' },
      },
    })
    const client = new NpmReleaseClient({ fetch: fetcher })
    const result = await client.query([{ ecosystem: 'npm', name: 'plugin', version: '1.0.0' }])
    assert.deepEqual(result.get('npm:plugin@1.0.0')?.upgradeCandidates?.map(item => item.version), [
      '1.1.0',
      '1.2.0',
      '2.0.0',
    ])
  })

  it('marks a regressed npm latest tag as older instead of an upgrade', async () => {
    const fetcher = async (): Promise<Response> => Response.json({
      'dist-tags': { latest: '0.0.1-rc.1' },
      versions: {
        '0.0.1-rc.1': { name: '@deepseek-ai/dsh-agent', version: '0.0.1-rc.1' },
        '0.1.0-rc.6': { name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' },
      },
    })
    const client = new NpmReleaseClient({ fetch: fetcher })
    const result = await client.query([{ ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' }])
    assert.equal(result.get('npm:@deepseek-ai/dsh-agent@0.1.0-rc.6')?.candidateStatus, 'older')
  })
})
