import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { GitHubAdvisoryClient, emptyRadarState, packageKey, parseRadarConfig, pollRadar } = await import('../dist/src/index.js')

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = join(repository, 'examples/radar')
const config = parseRadarConfig(JSON.parse(await readFile(join(fixtureDirectory, 'config.json'), 'utf8')))
const osvAdvisory = JSON.parse(await readFile(join(fixtureDirectory, 'advisory-added.json'), 'utf8'))

function mappedSource(matches) {
  return {
    async query(packages) {
      const result = new Map(packages.map(item => [packageKey(item), []]))
      for (const match of matches) result.set(packageKey(match.package), [match])
      return result
    },
  }
}

function emptyGitHubSource() {
  return {
    async query(packages) {
      return new Map(packages.map(item => [packageKey(item), []]))
    },
  }
}

function githubRecord() {
  return {
    ghsa_id: 'GHSA-github-copy',
    cve_id: 'CVE-2026-1234',
    summary: 'The same parser issue, from GitHub Advisory Database',
    description: 'The second feed reports the same affected parser under a different GHSA identifier.',
    severity: 'medium',
    published_at: '2026-08-14T01:00:00.000Z',
    updated_at: '2026-08-14T03:00:00.000Z',
    withdrawn_at: null,
    html_url: 'https://github.com/advisories/GHSA-github-copy',
    references: ['https://example.test/github-copy'],
    vulnerabilities: [{
      package: { ecosystem: 'npm', name: 'parser' },
      vulnerable_version_range: '>=2.0.0 <3.0.0',
      first_patched_version: { identifier: '3.1.0' },
    }],
  }
}

async function githubSource({ fail = false, empty = false } = {}) {
  let calls = 0
  const source = new GitHubAdvisoryClient({
    baseUrl: 'https://api.github.test/',
    fetch: async () => {
      calls += 1
      if (fail) return new Response(null, { status: 503 })
      return Response.json(empty ? [] : [githubRecord()])
    },
  })
  return { source, calls: () => calls }
}

const healthyGitHub = await githubSource()
const first = await pollRadar(
  config.projects,
  emptyRadarState(),
  mappedSource([osvAdvisory]),
  new Date('2026-08-14T03:01:00.000Z'),
  undefined,
  undefined,
  undefined,
  [{ name: 'github-advisories', source: healthyGitHub.source }],
)
const firstVulnerabilities = first.events.filter(event => event.kind === 'vulnerability')
assert.equal(firstVulnerabilities.length, 1)
assert.equal(firstVulnerabilities[0]?.advisory.id, 'GHSA-demo-2026-parser')
assert.deepEqual(firstVulnerabilities[0]?.advisory.fixedVersions, ['3.0.0', '3.1.0'])
assert.equal(healthyGitHub.calls(), 2)

const unavailable = await githubSource({ fail: true })
const failed = []
let state = first.state
for (const checkedAt of ['2026-08-14T03:30:00.000Z', '2026-08-14T04:00:00.000Z', '2026-08-14T04:30:00.000Z']) {
  const result = await pollRadar(
    config.projects,
    state,
    mappedSource([osvAdvisory]),
    new Date(checkedAt),
    undefined,
    undefined,
    undefined,
    [{ name: 'github-advisories', source: unavailable.source }],
  )
  failed.push(result)
  state = result.state
}
const outage = failed.at(-1)
assert.ok(outage !== undefined)
assert.equal(Object.keys(outage.state.activeVulnerabilities).length, 1)
assert.equal(outage.state.sourceHealth['github-advisories']?.consecutiveFailures, 3)
assert.equal(outage.events.some(event => event.kind === 'source-health' && event.change === 'new'), true)
assert.equal(outage.events.some(event => event.kind === 'vulnerability'), false)

const recoveredSource = await githubSource({ empty: true })
const recovered = await pollRadar(
  config.projects,
  outage.state,
  mappedSource([osvAdvisory]),
  new Date('2026-08-14T05:00:00.000Z'),
  undefined,
  undefined,
  undefined,
  [{ name: 'github-advisories', source: recoveredSource.source }],
)
assert.equal(recovered.state.sourceHealth['github-advisories']?.consecutiveFailures, 0)
assert.equal(recovered.events.some(event => event.kind === 'source-health' && event.change === 'resolved'), true)
assert.equal(Object.keys(recovered.state.activeVulnerabilities).length, 1)

console.log('GitHub Advisory Database showcase')
console.log(`  same advisory from OSV + GitHub: 2 reports -> ${firstVulnerabilities.length} Radar incident`)
console.log(`  merged aliases: ${firstVulnerabilities[0]?.advisory.aliases.join(', ')}`)
console.log(`  merged fixed versions: ${firstVulnerabilities[0]?.advisory.fixedVersions.join(', ')}`)
console.log(`  GitHub API requests: ${healthyGitHub.calls()} (network = none; deterministic fetch stub)`)
console.log(`  GitHub outage: finding retained; source failures = ${outage.state.sourceHealth['github-advisories']?.consecutiveFailures}`)
console.log('  recovery: source-health incident resolved; vulnerability was not falsely cleared')
