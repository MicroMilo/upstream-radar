import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findDependencyPaths, parseNpmLockGraph, parsePnpmLockGraph } from '../src/graph.js'

describe('dependency graph', () => {
  it('keeps distinct versions and reconstructs their paths from an npm lockfile', () => {
    const graph = parseNpmLockGraph({
      lockfileVersion: 3,
      packages: {
        '': { name: 'quarantine', version: '0.0.0', dependencies: { plugin: '1.0.0' } },
        'node_modules/plugin': {
          version: '1.0.0',
          dependencies: { framework: '2.4.7', logger: '4.0.2' },
        },
        'node_modules/framework': {
          version: '2.4.7',
          dependencies: { parser: '3.2.1', archive: '1.8.0' },
        },
        'node_modules/framework/node_modules/parser': { version: '3.2.1' },
        'node_modules/archive': { version: '1.8.0' },
        'node_modules/logger': { version: '4.0.2', dependencies: { parser: '2.9.0' } },
        'node_modules/parser': { version: '2.9.0' },
      },
    }, { name: 'plugin', version: '1.0.0' })

    assert.equal(graph.nodes.length, 6)
    assert.equal(graph.edges.length, 5)
    assert.equal(graph.source, 'npm-lock')
    const vulnerable = graph.nodes.find(node => node.name === 'parser' && node.version === '2.9.0')
    assert.ok(vulnerable)
    assert.deepEqual(
      findDependencyPaths(graph, vulnerable.id).map(path => path.map(node => `${node.name}@${node.version}`)),
      [['plugin@1.0.0', 'logger@4.0.2', 'parser@2.9.0']],
    )
  })

  it('rejects a lockfile that does not contain the requested exact root', () => {
    assert.throws(
      () => parseNpmLockGraph({ packages: { 'node_modules/plugin': { version: '2.0.0' } } }, { name: 'plugin', version: '1.0.0' }),
      /requested root package is not present/,
    )
  })

  it('synthesizes an npm workspace root from the package-lock root entry', () => {
    const graph = parseNpmLockGraph({
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
    }, { name: 'demo-dsh-plugin', version: '1.0.0' })

    assert.equal(graph.rootNodeId, 'npm:workspace-root:demo-dsh-plugin@1.0.0')
    assert.deepEqual(graph.nodes.map(node => `${node.name}@${node.version}`), [
      'demo-dsh-plugin@1.0.0',
      'logger@4.0.2',
      'parser@2.9.0',
    ])
    assert.deepEqual(graph.edges.map(edge => edge.kind), ['runtime', 'runtime'])
    assert.equal(graph.unresolved, undefined)
  })

  it('keeps optional peers from making a candidate lock graph incomplete', () => {
    const graph = parseNpmLockGraph({
      lockfileVersion: 3,
      packages: {
        'node_modules/plugin': {
          version: '1.0.0',
          peerDependencies: { optional: '^1.0.0', required: '^1.0.0' },
          peerDependenciesMeta: { optional: { optional: true } },
        },
      },
    }, { name: 'plugin', version: '1.0.0' })

    assert.deepEqual(graph.unresolved, [
      { from: 'node_modules/plugin', name: 'optional', kind: 'optional', spec: '^1.0.0' },
      { from: 'node_modules/plugin', name: 'required', kind: 'peer', spec: '^1.0.0' },
    ])
  })

  it('parses pnpm v9 snapshots and keeps exact transitive paths', () => {
    const graph = parsePnpmLockGraph(`
lockfileVersion: '9.0'

packages:

  'plugin@1.0.0': {}
  'logger@4.0.2': {}
  'parser@2.9.0': {}
  'parser@3.2.1': {}

snapshots:

  'plugin@1.0.0':
    dependencies:
      logger: 4.0.2
      parser: 3.2.1
  'logger@4.0.2':
    dependencies:
      parser: 2.9.0
  'parser@2.9.0': {}
  'parser@3.2.1': {}
`, { name: 'plugin', version: '1.0.0' })

    assert.equal(graph.source, 'pnpm-lock')
    assert.equal(graph.nodes.length, 4)
    assert.equal(graph.edges.length, 3)
    const vulnerable = graph.nodes.find(node => node.name === 'parser' && node.version === '2.9.0')
    assert.ok(vulnerable)
    assert.deepEqual(
      findDependencyPaths(graph, vulnerable.id).map(path => path.map(node => `${node.name}@${node.version}`)),
      [['plugin@1.0.0', 'logger@4.0.2', 'parser@2.9.0']],
    )
  })

  it('parses pnpm explicit mapping keys used for long peer-context locators', () => {
    const graph = parsePnpmLockGraph(`
lockfileVersion: '9.0'

packages:
  ? 'plugin@1.0.0'
  : {}
  ? 'parser@1.0.0(peer@2.0.0)'
  : {}

snapshots:
  ? 'plugin@1.0.0'
  : dependencies:
      parser: 1.0.0(peer@2.0.0)
  ? 'parser@1.0.0(peer@2.0.0)'
  : {}
`, { name: 'plugin', version: '1.0.0' })

    assert.equal(graph.nodes.length, 2)
    assert.deepEqual(graph.edges, [{
      from: 'pnpm:plugin@1.0.0',
      to: 'pnpm:parser@1.0.0(peer@2.0.0)',
      kind: 'runtime',
    }])
    assert.equal(graph.unresolved, undefined)
  })

  it('parses pnpm v6 slash locators and peer-context references', () => {
    const graph = parsePnpmLockGraph(`
lockfileVersion: 6.0

packages:
  /plugin/1.0.0:
    dependencies:
      peer-wrapper: 1.0.0_peer@2.0.0
  /peer-wrapper/1.0.0_peer@2.0.0:
    dependencies:
      peer: 2.0.0
  /peer/2.0.0:
`, { name: 'plugin', version: '1.0.0' })

    assert.equal(graph.nodes.length, 3)
    assert.equal(graph.edges.length, 2)
    assert.equal(graph.unresolved, undefined)
    assert.deepEqual(graph.nodes.map(node => node.id), [
      'pnpm:plugin/1.0.0',
      'pnpm:peer-wrapper/1.0.0_peer@2.0.0',
      'pnpm:peer/2.0.0',
    ])
  })

  it('does not guess when a pnpm reference can resolve to multiple peer contexts', () => {
    const graph = parsePnpmLockGraph(`
lockfileVersion: '9.0'

packages:
  'plugin@1.0.0': {}
  'parser@1.0.0_a@2.0.0': {}
  'parser@1.0.0_b@3.0.0': {}

snapshots:
  'plugin@1.0.0':
    dependencies:
      parser: 1.0.0
  'parser@1.0.0_a@2.0.0': {}
  'parser@1.0.0_b@3.0.0': {}
`, { name: 'plugin', version: '1.0.0' })

    assert.equal(graph.edges.length, 0)
    assert.deepEqual(graph.unresolved, [{
      from: 'pnpm:plugin@1.0.0',
      name: 'parser',
      kind: 'runtime',
      spec: '1.0.0',
    }])
  })

  it('synthesizes a project root from a pnpm v9 importer when it is not a package snapshot', () => {
    const graph = parsePnpmLockGraph(`
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      plugin:
        specifier: 1.0.0
        version: 1.0.0

packages:
  'plugin@1.0.0': {}

snapshots:
  'plugin@1.0.0': {}
`, { name: 'my-dsh-plugin', version: '1.0.0' })

    assert.equal(graph.rootNodeId, 'pnpm:workspace-root:my-dsh-plugin@1.0.0')
    assert.deepEqual(graph.nodes.map(node => `${node.name}@${node.version}`), [
      'my-dsh-plugin@1.0.0',
      'plugin@1.0.0',
    ])
    assert.deepEqual(graph.edges, [{
      from: 'pnpm:workspace-root:my-dsh-plugin@1.0.0',
      to: 'pnpm:plugin@1.0.0',
      kind: 'runtime',
    }])
  })
})
