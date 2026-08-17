import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createRadarConfigFromPnpmLock, OsvClient, packageKey, pollRadar, renderRadarEvents } = await import('../dist/src/index.js')
const { emptyRadarState } = await import('../dist/src/radar.js')

const ADVISORY_ID = 'GHSA-pnpm-lock-showcase'
const ADVISORY_MODIFIED = '2026-08-16T08:00:00.000Z'
const lockfileText = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      logger:
        specifier: 4.0.2
        version: 4.0.2

packages:
  'logger@4.0.2': {}
  'parser@2.9.0': {}

snapshots:
  'logger@4.0.2':
    dependencies:
      parser: 2.9.0
  'parser@2.9.0': {}
`

const advisory = {
  id: ADVISORY_ID,
  aliases: ['CVE-2026-9001'],
  summary: 'The parser accepts an unsafe expansion sequence.',
  details: 'This deterministic advisory exists only for the local showcase.',
  database_specific: { severity: 'high' },
  published: ADVISORY_MODIFIED,
  modified: ADVISORY_MODIFIED,
  affected: [{
    package: { ecosystem: 'npm', name: 'parser' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.0.0' }] }],
  }],
  references: [{ url: 'https://example.test/GHSA-pnpm-lock-showcase' }],
}

const requests = []
const fetchStub = async (input, init) => {
  const url = new URL(String(input))
  requests.push({ method: init?.method ?? 'GET', path: url.pathname })
  if (url.pathname === '/v1/querybatch') {
    const payload = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      results: payload.queries.map(query => (
        query?.package?.name === 'parser' && query.version === '2.9.0'
          ? { vulns: [{ id: ADVISORY_ID, modified: ADVISORY_MODIFIED }] }
          : { vulns: [] }
      )),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.pathname === `/v1/vulns/${ADVISORY_ID}`) {
    return new Response(JSON.stringify(advisory), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('not found', { status: 404 })
}

const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-pnpm-monitor-'))
try {
  const lockfile = join(scratch, 'pnpm-lock.yaml')
  await writeFile(lockfile, lockfileText)
  const config = await createRadarConfigFromPnpmLock({
    lockfile,
    root: { name: 'demo-dsh-plugin', version: '1.0.0' },
    projectName: 'DSH pnpm showcase',
    channels: ['stdout'],
  })
  const graph = config.projects[0]?.plugins[0]?.graph
  assert.ok(graph)
  assert.equal(graph.source, 'pnpm-lock')
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 2)

  const result = await pollRadar(
    config.projects,
    emptyRadarState(),
    new OsvClient({ baseUrl: 'https://osv.example.test/', fetch: fetchStub }),
    new Date('2026-08-16T08:01:00.000Z'),
  )
  const event = result.events.find(item => item.kind === 'vulnerability')
  assert.ok(event)
  assert.equal(event.affected.name, 'parser')
  assert.equal(event.affected.version, '2.9.0')
  assert.deepEqual(event.paths.map(path => path.map(node => `${node.name}@${node.version}`)), [[
    'demo-dsh-plugin@1.0.0',
    'logger@4.0.2',
    'parser@2.9.0',
  ]])
  assert.equal(result.sourceErrors.length, 0)
  assert.equal(requests.filter(request => request.path === '/v1/querybatch').length, 1)
  assert.equal(requests.filter(request => request.path === `/v1/vulns/${ADVISORY_ID}`).length, 1)

  process.stdout.write(`${JSON.stringify({
    flow: 'pnpm-lock -> Radar config -> OSV -> DSH-ready vulnerability event',
    graph: { source: graph.source, nodes: graph.nodes.length, edges: graph.edges.length },
    alert: {
      id: event.id,
      affected: event.affected,
      severity: event.advisory.severity,
      path: event.paths[0],
    },
    packagesQueried: result.packagesQueried,
    noInstall: true,
    noPluginExecution: true,
    packageKeys: config.projects.flatMap(project => project.plugins.flatMap(plugin => plugin.graph.nodes.map(node => packageKey({ ecosystem: 'npm', name: node.name, version: node.version })))),
  }, null, 2)}\n`)
  process.stdout.write(renderRadarEvents(result.events))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
