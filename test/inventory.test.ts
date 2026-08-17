import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRadarConfig } from '../src/inventory.js'
import type { RadarConfig } from '../src/radar-types.js'

const valid: RadarConfig = {
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

  it('preserves project webhook environment routing and validates its names', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.project.webhookUrlEnv = 'RADAR_PAYMENTS_URL'
    candidate.projects[0]!.project.webhookSecretEnv = 'RADAR_PAYMENTS_SECRET'
    const parsed = parseRadarConfig(candidate)
    assert.equal(parsed.projects[0]?.project.webhookUrlEnv, 'RADAR_PAYMENTS_URL')
    assert.equal(parsed.projects[0]?.project.webhookSecretEnv, 'RADAR_PAYMENTS_SECRET')

    const invalidName = structuredClone(candidate)
    invalidName.projects[0]!.project.webhookUrlEnv = 'RADAR-PAYMENTS-URL'
    assert.throws(() => parseRadarConfig(invalidName), /webhookUrlEnv must be a valid environment variable name/)

    const secretWithoutUrl = structuredClone(valid)
    secretWithoutUrl.projects[0]!.project.webhookSecretEnv = 'RADAR_PAYMENTS_SECRET'
    assert.throws(() => parseRadarConfig(secretWithoutUrl), /webhookSecretEnv requires webhookUrlEnv/)
  })

  it('preserves npm optional peer metadata in manifests', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.plugins[0]!.manifest = {
      name: 'plugin',
      version: '1.0.0',
      peerDependencies: { 'optional-host': '^1.0.0' },
      peerDependenciesMeta: { 'optional-host': { optional: true } },
    }
    const parsed = parseRadarConfig(candidate)
    assert.deepEqual(parsed.projects[0]?.plugins[0]?.manifest?.peerDependenciesMeta, {
      'optional-host': { optional: true },
    })
  })

  it('preserves the generated DSH profile reference used for native refresh', () => {
    const candidate = structuredClone(valid)
    candidate.dshProfile = { name: 'web' }
    const parsed = parseRadarConfig(candidate)
    assert.deepEqual(parsed.dshProfile, { name: 'web' })
  })

  it('preserves the graph source and unresolved dependencies as incomplete coverage', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.plugins[0]!.graph.source = 'installed-node-modules'
    candidate.projects[0]!.plugins[0]!.graph.unresolved = [{
      from: 'plugin',
      name: 'optional-parser',
      kind: 'optional',
      spec: '^1.0.0',
    }]
    const parsed = parseRadarConfig(candidate)
    assert.equal(parsed.projects[0]?.plugins[0]?.graph.source, 'installed-node-modules')
    assert.deepEqual(parsed.projects[0]?.plugins[0]?.graph.unresolved, candidate.projects[0]!.plugins[0]!.graph.unresolved)
  })

  it('accepts an exact DSH process host-runtime evidence source', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.plugins[0]!.graph.hostRuntime = {
      source: 'dsh-process',
      resolvedNodes: 3,
      package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
    }
    const parsed = parseRadarConfig(candidate)
    assert.deepEqual(parsed.projects[0]?.plugins[0]?.graph.hostRuntime, {
      source: 'dsh-process',
      resolvedNodes: 3,
      package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
    })
  })

  it('preserves the explicit host-runtime boundary edge', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.plugins[0]!.graph.nodes.push({
      id: 'dsh-host/runtime',
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.6',
      source: 'dsh-host',
    })
    candidate.projects[0]!.plugins[0]!.graph.edges.push({
      from: 'plugin',
      to: 'dsh-host/runtime',
      kind: 'host-runtime',
    })
    const parsed = parseRadarConfig(candidate)
    assert.deepEqual(parsed.projects[0]?.plugins[0]?.graph.edges.at(-1), {
      from: 'plugin',
      to: 'dsh-host/runtime',
      kind: 'host-runtime',
    })
  })

  it('accepts a delivery-only notification policy without changing the inventory graph', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.notificationPolicy = {
      minimumSeverity: 'high',
      quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
    }
    const parsed = parseRadarConfig(candidate)
    assert.deepEqual(parsed.projects[0]?.notificationPolicy, candidate.projects[0]!.notificationPolicy)
  })

  it('rejects ambiguous notification windows', () => {
    const candidate = structuredClone(valid)
    candidate.projects[0]!.notificationPolicy = {
      quietHours: { timezone: 'Asia/Shanghai', start: '08:00', end: '08:00' },
    }
    assert.throws(() => parseRadarConfig(candidate), /start and end must be different/)
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
