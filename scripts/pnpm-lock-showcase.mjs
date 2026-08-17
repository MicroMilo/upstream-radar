import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const lockfile = resolve(root, 'pnpm-lock.yaml')
const cli = resolve(root, 'dist/src/cli.js')
const rootCoordinate = `${packageJson.name}@${packageJson.version}`
const result = spawnSync(process.execPath, [
  cli,
  'graph',
  'pnpm-lock',
  lockfile,
  '--root',
  rootCoordinate,
  '--json',
], { encoding: 'utf8' })

if (result.status !== 0) {
  throw new Error([result.stdout, result.stderr].filter(Boolean).join('\n'))
}

const graph = JSON.parse(result.stdout)
assert.equal(graph.source, 'pnpm-lock')
assert.equal(graph.rootNodeId, `pnpm:workspace-root:${rootCoordinate}`)
assert.ok(graph.nodes.length >= 2)
assert.ok(graph.edges.length >= 1)
assert.equal(graph.unresolved, undefined)

process.stdout.write(`${JSON.stringify({
  command: `upstream-radar graph pnpm-lock pnpm-lock.yaml --root ${rootCoordinate}`,
  source: graph.source,
  root: rootCoordinate,
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  unresolved: graph.unresolved?.length ?? 0,
  digest: graph.digest,
  noInstall: true,
  noPluginExecution: true,
}, null, 2)}\n`)
