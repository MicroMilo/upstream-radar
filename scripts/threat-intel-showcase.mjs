import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const {
  CisaKevClient,
  EpssClient,
  emptyRadarState,
  packageKey,
  parseRadarConfig,
  pollRadar,
  renderRadarEvent,
} = await import('../dist/src/index.js')

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = join(repository, 'examples/radar')
const config = parseRadarConfig(JSON.parse(await readFile(join(fixtureDirectory, 'config.json'), 'utf8')))
const advisory = JSON.parse(await readFile(join(fixtureDirectory, 'advisory-added.json'), 'utf8'))

function mappedSource(matches) {
  return {
    async query(packages) {
      const result = new Map(packages.map(item => [packageKey(item), []]))
      for (const match of matches) result.set(packageKey(match.package), [match])
      return result
    },
  }
}

const cisa = new CisaKevClient({
  url: 'https://cisa.example.test/kev.json',
  fetch: async () => Response.json({
    vulnerabilities: [{
      cveID: 'CVE-2026-1234',
      dateAdded: '2026-08-15',
      dueDate: '2026-08-22',
      knownRansomwareCampaignUse: 'Unknown',
      requiredAction: 'Apply the vendor fix.',
    }],
  }),
})

const epss = new EpssClient({
  url: 'https://epss.example.test/data/v1/epss',
  fetch: async input => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('cve'), 'CVE-2026-1234')
    return Response.json({
      status: 'OK',
      data: [{
        cve: 'CVE-2026-1234',
        epss: '0.972240000',
        percentile: '0.999990000',
        date: '2026-08-16',
      }],
    })
  },
})

const first = await pollRadar(
  config.projects,
  emptyRadarState(),
  mappedSource([advisory]),
  new Date('2026-08-16T02:00:00.000Z'),
  undefined,
  undefined,
  undefined,
  [],
  [
    { name: 'cisa-kev', source: cisa },
    { name: 'epss', source: epss },
  ],
)
const firstEvent = first.events.find(event => event.kind === 'vulnerability')
assert.ok(firstEvent?.kind === 'vulnerability')
assert.deepEqual(firstEvent.advisory.riskSignals, {
  cisaKev: {
    knownExploited: true,
    dateAdded: '2026-08-15',
    dueDate: '2026-08-22',
    knownRansomwareCampaignUse: 'Unknown',
    requiredAction: 'Apply the vendor fix.',
  },
  epss: {
    score: 0.97224,
    percentile: 0.99999,
    date: '2026-08-16',
  },
})

const degraded = await pollRadar(
  config.projects,
  first.state,
  mappedSource([advisory]),
  new Date('2026-08-16T03:00:00.000Z'),
  undefined,
  undefined,
  undefined,
  [],
  [
    { name: 'cisa-kev', source: cisa },
    { name: 'epss', source: { async query() { throw new Error('FIRST EPSS unavailable') } } },
  ],
)
const retained = Object.values(degraded.state.activeVulnerabilities)[0]?.event
assert.ok(retained?.kind === 'vulnerability')
assert.deepEqual(retained.advisory.riskSignals, firstEvent.advisory.riskSignals)
assert.equal(degraded.events.some(event => event.kind === 'vulnerability'), false)
assert.deepEqual(degraded.sourceErrors, [{ source: 'epss', message: 'FIRST EPSS unavailable' }])

console.log('Threat-intelligence prioritization showcase')
console.log('  advisory match: 1 exact parser path -> 1 Radar incident')
console.log('  CISA KEV: known exploited in the wild')
console.log('  FIRST EPSS: 97.2% estimated exploitation probability (100.0% percentile)')
console.log('  source outage: EPSS failure is visible; the confirmed incident and last signal are retained')
console.log('  network: none; CISA and EPSS responses are deterministic local stubs')
console.log('')
console.log(renderRadarEvent(firstEvent))
