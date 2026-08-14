import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRadarConfig } from '../src/inventory.js'

const valid = {
  schema: 'upstream-radar.radar-config/v1alpha1',
  projects: [{
    schema: 'upstream-radar.inventory/v1alpha1',
    project: { id: 'project-a', name: 'Project A', channels: ['stdout'] },
    plugins: [{
      package: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
      graph: {
        schema: 'upstream-radar.dependency-graph/v1alpha1',
        rootNodeId: 'plugin',
        nodes: [
          { id: 'plugin', name: 'plugin', version: '1.0.0' },
          { id: 'parser', name: 'parser', version: '2.9.0' },
        ],
        edges: [{ from: 'plugin', to: 'parser', kind: 'runtime' }],
      },
    }],
  }],
}

describe('radar inventory parsing', () => {
  it('accepts a bounded project and dependency graph', () => {
    const parsed = parseRadarConfig(valid)
    assert.equal(parsed.projects[0]?.plugins[0]?.graph.nodes[1]?.version, '2.9.0')
  })

  it('rejects edges to missing nodes', () => {
    const broken = structuredClone(valid)
    broken.projects[0]!.plugins[0]!.graph.edges[0]!.to = 'missing'
    assert.throws(() => parseRadarConfig(broken), /missing node/)
  })

  it('rejects a graph whose root does not match the installed plugin', () => {
    const broken = structuredClone(valid)
    broken.projects[0]!.plugins[0]!.package.version = '2.0.0'
    assert.throws(() => parseRadarConfig(broken), /does not match graph root/)
  })
})
