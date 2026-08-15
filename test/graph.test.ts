import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findDependencyPaths, parseNpmLockGraph } from '../src/graph.js'

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
})
