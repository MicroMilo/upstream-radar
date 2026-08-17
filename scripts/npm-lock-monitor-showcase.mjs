import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { OsvClient, packageKey, parseRadarConfig, pollRadar, renderRadarEvents } = await import('../dist/src/index.js')
const { emptyRadarState } = await import('../dist/src/radar.js')

const ADVISORY_ID = 'GHSA-npm-lock-showcase'
const ADVISORY_MODIFIED = '2026-08-16T08:00:00.000Z'
const advisory = {
  id: ADVISORY_ID,
  aliases: ['CVE-2026-9002'],
  summary: 'The parser accepts an unsafe expansion sequence.',
  details: 'This deterministic advisory exists only for the local npm lockfile showcase.',
  database_specific: { severity: 'high' },
  published: ADVISORY_MODIFIED,
  modified: ADVISORY_MODIFIED,
  affected: [{
    package: { ecosystem: 'npm', name: 'parser' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.0.0' }] }],
  }],
  references: [{ url: `https://example.test/${ADVISORY_ID}` }],
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

const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-npm-monitor-'))
try {
  const manifest = join(scratch, 'package.json')
  const lockfile = join(scratch, 'package-lock.json')
  const configFile = join(scratch, 'upstream-radar.config.json')
  await writeFile(manifest, JSON.stringify({ name: 'demo-dsh-plugin', version: '1.0.0' }))
  await writeFile(lockfile, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'demo-dsh-plugin',
        version: '1.0.0',
        dependencies: { logger: '4.0.2' },
        devDependencies: { testkit: '9.0.0' },
      },
      'node_modules/logger': {
        version: '4.0.2',
        dependencies: { parser: '2.9.0' },
      },
      'node_modules/parser': { version: '2.9.0' },
      'node_modules/testkit': { version: '9.0.0' },
    },
  }))

  const cli = resolve(import.meta.dirname, '../dist/src/cli.js')
  const init = spawnSync(process.execPath, [
    cli,
    'init',
    '--npm-lock',
    lockfile,
    '--output',
    configFile,
    '--project-name',
    'DSH npm showcase',
  ], { encoding: 'utf8', cwd: scratch })
  if (init.status !== 0) throw new Error([init.stdout, init.stderr].filter(Boolean).join('\n'))

  const config = parseRadarConfig(JSON.parse(await readFile(configFile, 'utf8')))
  const graph = config.projects[0]?.plugins[0]?.graph
  assert.ok(graph)
  assert.equal(graph.source, 'npm-lock')
  assert.equal(graph.rootNodeId, 'npm:workspace-root:demo-dsh-plugin@1.0.0')
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 2)
  assert.equal(graph.nodes.some(node => node.name === 'testkit'), false)

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
    flow: 'npm-lock -> Radar config -> OSV -> DSH-ready vulnerability event',
    graph: { source: graph.source, nodes: graph.nodes.length, edges: graph.edges.length },
    rootInferredFrom: 'package.json',
    devDependenciesExcluded: true,
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
