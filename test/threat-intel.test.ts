import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CisaKevClient, EpssClient } from '../src/threat-intel.js'
import type { VulnerabilityAdvisory } from '../src/radar-types.js'

const cveAdvisory: VulnerabilityAdvisory = {
  id: 'GHSA-demo',
  aliases: ['CVE-2026-1234'],
  summary: 'Demo advisory',
  details: 'Demo details',
  severity: 'high',
  modified: '2026-08-16T00:00:00.000Z',
  fixedVersions: ['2.0.0'],
  references: [],
}

describe('threat intelligence sources', () => {
  it('maps a CISA KEV entry to an advisory CVE without changing the advisory match', async () => {
    const requests: string[] = []
    const client = new CisaKevClient({
      url: 'https://cisa.example.test/kev.json',
      fetch: async input => {
        requests.push(String(input))
        return new Response(JSON.stringify({
          catalogVersion: '2026.08.16',
          dateReleased: '2026-08-16',
          count: 1,
          vulnerabilities: [{
            cveID: 'CVE-2026-1234',
            dateAdded: '2026-08-15',
            dueDate: '2026-08-22',
            knownRansomwareCampaignUse: 'Unknown',
            requiredAction: 'Apply the vendor fix.',
            notes: 'Demo only.',
          }],
        }), { status: 200 })
      },
    })

    const result = await client.query([cveAdvisory, { ...cveAdvisory, id: 'GHSA-no-cve', aliases: [] }])
    assert.equal(requests.length, 1)
    assert.deepEqual(result.get('GHSA-demo'), {
      cisaKev: {
        knownExploited: true,
        dateAdded: '2026-08-15',
        dueDate: '2026-08-22',
        knownRansomwareCampaignUse: 'Unknown',
        requiredAction: 'Apply the vendor fix.',
        notes: 'Demo only.',
      },
    })
    assert.deepEqual(result.get('GHSA-no-cve'), {})
  })

  it('maps FIRST EPSS scores and keeps advisories without a CVE covered', async () => {
    const requests: string[] = []
    const client = new EpssClient({
      url: 'https://epss.example.test/data/v1/epss',
      fetch: async input => {
        const url = new URL(String(input))
        requests.push(url.toString())
        assert.equal(url.searchParams.get('cve'), 'CVE-2026-1234')
        return new Response(JSON.stringify({
          status: 'OK',
          data: [{
            cve: 'CVE-2026-1234',
            epss: '0.972240000',
            percentile: '0.999990000',
            date: '2026-08-16',
          }],
        }), { status: 200 })
      },
    })

    const result = await client.query([cveAdvisory, { ...cveAdvisory, id: 'GHSA-no-cve', aliases: [] }])
    assert.equal(requests.length, 1)
    assert.deepEqual(result.get('GHSA-demo'), {
      epss: {
        score: 0.97224,
        percentile: 0.99999,
        date: '2026-08-16',
      },
    })
    assert.deepEqual(result.get('GHSA-no-cve'), {})
  })

  it('rejects malformed or insecure threat-intelligence responses', async () => {
    assert.throws(() => new CisaKevClient({ url: 'http://cisa.example.test/kev.json' }), /must use HTTPS/)
    const client = new EpssClient({
      url: 'https://epss.example.test/data/v1/epss',
      fetch: async () => new Response(JSON.stringify({ status: 'OK', data: [{ cve: 'CVE-2026-1234', epss: '1.2', percentile: '0.5' }] }), { status: 200 }),
    })
    await assert.rejects(client.query([cveAdvisory]), /between 0 and 1/)
  })

  it('does not contact either source when no advisory has a CVE identity', async () => {
    let calls = 0
    const advisory = { ...cveAdvisory, id: 'GHSA-only', aliases: [] }
    const fetch = async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }
    await new CisaKevClient({ url: 'https://cisa.example.test/kev.json', fetch }).query([advisory])
    await new EpssClient({ url: 'https://epss.example.test/data/v1/epss', fetch }).query([advisory])
    assert.equal(calls, 0)
  })
})
