import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OsvClient } from '../src/osv.js'

describe('OSV client', () => {
  it('queries exact npm versions in a batch and fetches changed advisory details', async () => {
    const requests: string[] = []
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/v1/querybatch')) {
        assert.equal(init?.method, 'POST')
        assert.deepEqual(JSON.parse(String(init?.body)), {
          queries: [{ package: { ecosystem: 'npm', name: 'parser' }, version: '2.9.0' }],
        })
        return Response.json({ results: [{ vulns: [{ id: 'GHSA-demo', modified: '2026-08-14T01:00:00Z' }] }] })
      }
      if (url.endsWith('/v1/vulns/GHSA-demo')) {
        return Response.json({
          id: 'GHSA-demo',
          modified: '2026-08-14T01:00:00Z',
          published: '2026-08-14T00:00:00Z',
          summary: 'Parser accepts an unsafe archive header',
          aliases: ['CVE-2026-1234'],
          affected: [{
            package: { ecosystem: 'npm', name: 'parser' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.0.0' }] }],
          }],
          database_specific: { severity: 'HIGH' },
          references: [{ type: 'ADVISORY', url: 'https://example.test/advisory' }],
        })
      }
      return new Response('not found', { status: 404 })
    }

    const client = new OsvClient({ fetch: fetcher })
    const result = await client.query([{ ecosystem: 'npm', name: 'parser', version: '2.9.0' }])
    const hit = result.get('npm:parser@2.9.0')
    assert.equal(hit?.length, 1)
    assert.equal(hit?.[0]?.advisory.id, 'GHSA-demo')
    assert.deepEqual(hit?.[0]?.advisory.fixedVersions, ['3.0.0'])
    assert.equal(hit?.[0]?.advisory.severity, 'high')
    assert.equal(requests.length, 2)
  })
})
