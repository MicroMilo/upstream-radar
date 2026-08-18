import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildReverseDependencyIndex,
  findReverseDependencyEntry,
  findReverseDependencyImpacts,
  parseReverseDependencyIndex,
  parseReverseDependencyObservations,
} from '../src/dependency-index.js'
import type { DependencyGraph } from '../src/radar-types.js'

function graph(pluginName: string, pluginVersion: string, incomplete = false): DependencyGraph {
  const root = `${pluginName}@${pluginVersion}`
  return {
    schema: 'upstream-radar.dependency-graph/v1alpha1',
    rootNodeId: root,
    nodes: [
      { id: root, name: pluginName, version: pluginVersion },
      { id: `${pluginName}:wrapper`, name: 'wrapper', version: '1.0.0' },
      { id: `${pluginName}:shared`, name: 'shared', version: '2.0.0' },
      { id: `${pluginName}:leaf`, name: 'leaf', version: '3.0.0' },
    ],
    edges: [
      { from: root, to: `${pluginName}:wrapper`, kind: 'runtime' },
      { from: `${pluginName}:wrapper`, to: `${pluginName}:shared`, kind: 'runtime' },
      { from: root, to: `${pluginName}:shared`, kind: 'peer' },
      { from: `${pluginName}:shared`, to: `${pluginName}:leaf`, kind: 'optional' },
    ],
    ...(incomplete ? { unresolved: [{ from: root, name: 'platform-only', kind: 'optional' as const, spec: '^1.0.0' }] } : {}),
  }
}

describe('reverse dependency index', () => {
  it('indexes exact dependencies, paths, edge kinds, and incomplete coverage', () => {
    const index = buildReverseDependencyIndex([
      {
        source: 'plugin-a-scan.json',
        pluginId: 'plugin-a@1.0.0',
        plugin: { ecosystem: 'npm', name: 'plugin-a', version: '1.0.0' },
        graph: graph('plugin-a', '1.0.0'),
      },
      {
        source: 'plugin-b-scan.json',
        pluginId: 'plugin-b@1.0.0',
        plugin: { ecosystem: 'npm', name: 'plugin-b', version: '1.0.0' },
        graph: graph('plugin-b', '1.0.0', true),
      },
    ], {
      generatedAt: '2026-08-18T00:00:00.000Z',
      inputs: { files: 2, loadedFiles: 2, skipped: [] },
    })

    assert.equal(index.schema, 'upstream-radar.reverse-dependency-index/v1alpha1')
    assert.equal(index.observations, 2)
    assert.deepEqual(index.coverage, {
      completeObservations: 1,
      incompleteObservations: 1,
      unresolvedEdges: 1,
    })

    const shared = findReverseDependencyEntry(index, { ecosystem: 'npm', name: 'shared', version: '2.0.0' })
    assert.ok(shared)
    assert.deepEqual(shared.dependents.map(dependent => [dependent.pluginId, dependent.coverage]), [
      ['plugin-a@1.0.0', 'complete'],
      ['plugin-b@1.0.0', 'incomplete'],
    ])
    const pluginAPath = shared.dependents[0]?.paths.find(path => path.nodes.length === 3)
    assert.deepEqual(pluginAPath, {
      nodes: ['plugin-a@1.0.0', 'wrapper@1.0.0', 'shared@2.0.0'],
      kinds: ['runtime', 'runtime'],
    })

    const leaf = findReverseDependencyEntry(index, { ecosystem: 'npm', name: 'leaf', version: '3.0.0' })
    assert.equal(leaf?.dependents.length, 2)
    assert.deepEqual(index.dependencies.map(item => `${item.dependency.name}@${item.dependency.version}`), [
      'leaf@3.0.0',
      'shared@2.0.0',
      'wrapper@1.0.0',
    ])
  })

  it('reads scan and Radar config evidence without treating unrelated JSON as a graph', () => {
    const scanGraph = graph('scan-plugin', '1.0.0')
    const scan = {
      schema: 'upstream-radar.scan/v1alpha1',
      target: { kind: 'npm', name: 'scan-plugin', version: '1.0.0' },
      evidence: { dependencyGraph: scanGraph },
    }
    const observations = parseReverseDependencyObservations(scan, 'scan.json')
    assert.equal(observations.length, 1)
    assert.equal(observations[0]?.pluginId, 'scan-plugin@1.0.0')

    const config = {
      schema: 'upstream-radar.radar-config/v1alpha1',
      projects: [{
        project: { id: 'demo', name: 'Demo project' },
        plugins: [{
          package: { name: 'config-plugin', version: '2.0.0' },
          graph: graph('config-plugin', '2.0.0'),
        }],
      }],
    }
    const configObservations = parseReverseDependencyObservations(config, 'config.json')
    assert.equal(configObservations.length, 1)
    assert.equal(configObservations[0]?.pluginId, 'demo:config-plugin@2.0.0')
    assert.deepEqual(configObservations[0]?.project, { id: 'demo', name: 'Demo project' })

    assert.throws(
      () => parseReverseDependencyObservations({ schema: 'unknown' }, 'unknown.json'),
      /unsupported schema unknown/,
    )
  })

  it('routes a package-name version change to every downstream plugin, even before the new version is installed', () => {
    const index = buildReverseDependencyIndex([
      {
        source: 'plugin-a.json',
        pluginId: 'plugin-a@1.0.0',
        plugin: { ecosystem: 'npm', name: 'plugin-a', version: '1.0.0' },
        graph: graph('plugin-a', '1.0.0'),
      },
      {
        source: 'plugin-b.json',
        pluginId: 'plugin-b@1.0.0',
        plugin: { ecosystem: 'npm', name: 'plugin-b', version: '1.0.0' },
        graph: graph('plugin-b', '1.0.0', true),
      },
      {
        source: 'plugin-c.json',
        pluginId: 'plugin-c@1.0.0',
        plugin: { ecosystem: 'npm', name: 'plugin-c', version: '1.0.0' },
        graph: {
          ...graph('plugin-c', '1.0.0'),
          nodes: graph('plugin-c', '1.0.0').nodes.map(node => node.name === 'shared' ? { ...node, version: '3.0.0' } : node),
        },
      },
    ])
    assert.deepEqual(parseReverseDependencyIndex(JSON.parse(JSON.stringify(index)) as unknown), index)

    const impacts = findReverseDependencyImpacts(index, [{
      ecosystem: 'npm',
      name: 'shared',
      beforeVersions: ['2.0.0'],
      afterVersions: ['3.0.0'],
    }])
    assert.equal(impacts.length, 1)
    assert.deepEqual(impacts[0], {
      dependency: { ecosystem: 'npm', name: 'shared' },
      changedFrom: ['2.0.0'],
      changedTo: ['3.0.0'],
      observedVersions: ['2.0.0'],
      coverage: 'incomplete',
      truncated: false,
      dependents: [
        {
          pluginId: 'plugin-a@1.0.0',
          plugin: { ecosystem: 'npm', name: 'plugin-a', version: '1.0.0' },
          sources: ['plugin-a.json'],
          coverage: 'complete',
          paths: [
            { nodes: ['plugin-a@1.0.0', 'shared@2.0.0'], kinds: ['peer'] },
            { nodes: ['plugin-a@1.0.0', 'wrapper@1.0.0', 'shared@2.0.0'], kinds: ['runtime', 'runtime'] },
          ],
        },
        {
          pluginId: 'plugin-b@1.0.0',
          plugin: { ecosystem: 'npm', name: 'plugin-b', version: '1.0.0' },
          sources: ['plugin-b.json'],
          coverage: 'incomplete',
          paths: [
            { nodes: ['plugin-b@1.0.0', 'shared@2.0.0'], kinds: ['peer'] },
            { nodes: ['plugin-b@1.0.0', 'wrapper@1.0.0', 'shared@2.0.0'], kinds: ['runtime', 'runtime'] },
          ],
        },
      ],
    })
  })
})
