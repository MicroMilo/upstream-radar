import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GitHubAdvisoryClient } from '../src/github-advisory.js'

const coordinate = { ecosystem: 'npm' as const, name: 'parser', version: '2.9.0' }

describe('GitHub Advisory Database source', () => {
  it('queries exact npm versions and maps ranges, aliases and first patched versions', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const client = new GitHubAdvisoryClient({
      token: 'test-token',
      fetch: async (input, init) => {
        const url = String(input)
        calls.push({ url, headers: new Headers(init?.headers) })
        const type = new URL(url).searchParams.get('type')
        if (type === 'reviewed') {
          return Response.json([
            {
              ghsa_id: 'GHSA-parser-demo',
              cve_id: 'CVE-2026-1234',
              summary: 'Unsafe parser input handling',
              description: 'A parser path can be reached with an unsafe archive.',
              severity: 'high',
              published_at: '2026-08-14T00:00:00Z',
              updated_at: '2026-08-14T01:00:00Z',
              withdrawn_at: null,
              html_url: 'https://github.com/advisories/GHSA-parser-demo',
              references: ['https://example.test/advisory'],
              vulnerabilities: [{
                package: { ecosystem: 'npm', name: 'parser' },
                vulnerable_version_range: '>=2.0.0 <3.0.0',
                first_patched_version: { identifier: '3.0.0' },
              }],
            },
            {
              ghsa_id: 'GHSA-parser-not-hit',
              summary: 'A different version range',
              description: '',
              severity: 'medium',
              updated_at: '2026-08-14T01:00:00Z',
              vulnerabilities: [{
                package: { ecosystem: 'npm', name: 'parser' },
                vulnerable_version_range: '>=3.0.0 <4.0.0',
              }],
            },
          ])
        }
        return Response.json([])
      },
    })
    const result = await client.query([coordinate])
    const matches = result.get('npm:parser@2.9.0')
    assert.equal(matches?.length, 1)
    assert.equal(matches?.[0]?.advisory.id, 'GHSA-parser-demo')
    assert.deepEqual(matches?.[0]?.advisory.aliases, ['CVE-2026-1234'])
    assert.deepEqual(matches?.[0]?.advisory.fixedVersions, ['3.0.0'])
    assert.equal(matches?.[0]?.advisory.severity, 'high')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.headers.get('accept'), 'application/vnd.github+json')
    assert.equal(calls[0]?.headers.get('x-github-api-version'), '2022-11-28')
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer test-token')
    assert.equal(new URL(calls[0]?.url ?? '').searchParams.get('affects'), 'parser@2.9.0')
  })

  it('keeps empty exact-package results and ignores withdrawn advisories', async () => {
    const client = new GitHubAdvisoryClient({
      includeUnreviewed: false,
      fetch: async () => Response.json([{
        ghsa_id: 'GHSA-withdrawn',
        summary: 'Withdrawn',
        description: 'No longer active.',
        severity: 'high',
        updated_at: '2026-08-14T01:00:00Z',
        withdrawn_at: '2026-08-15T01:00:00Z',
        vulnerabilities: [{
          package: { ecosystem: 'npm', name: 'parser' },
          vulnerable_version_range: '<3.0.0',
        }],
      }]),
    })
    const result = await client.query([coordinate, { ...coordinate, name: 'clean' }])
    assert.deepEqual(result.get('npm:parser@2.9.0'), [])
    assert.deepEqual(result.get('npm:clean@2.9.0'), [])
  })

  it('surfaces API failures and rejects insecure base URLs', async () => {
    await assert.rejects(
      new GitHubAdvisoryClient({ fetch: async () => new Response(null, { status: 429 }) }).query([coordinate]),
      /HTTP 429/,
    )
    assert.throws(() => new GitHubAdvisoryClient({ baseUrl: 'http://api.github.test/' }), /must use HTTPS/)
  })
})
