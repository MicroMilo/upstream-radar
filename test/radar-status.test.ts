import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRadarStatus, renderRadarStatus } from '../src/radar-status.js'
import { emptyRadarState } from '../src/radar.js'
import type { RadarConfig } from '../src/radar-types.js'

const config: RadarConfig = {
  schema: 'upstream-radar.radar-config/v1alpha1',
  projects: [{
    schema: 'upstream-radar.inventory/v1alpha1',
    project: { id: 'demo', name: 'Demo project' },
    plugins: [{
      package: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      graph: {
        schema: 'upstream-radar.dependency-graph/v1alpha1',
        rootNodeId: 'demo-plugin',
        nodes: [{ id: 'demo-plugin', name: 'demo-plugin', version: '1.0.0' }],
        edges: [],
      },
    }],
  }],
}

describe('Radar status', () => {
  it('reports a clear first-run snapshot without state or network calls', () => {
    const report = createRadarStatus(config, emptyRadarState(), {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: false,
    })

    assert.equal(report.monitoring, 'not-started')
    assert.equal(report.coverage, 'complete')
    assert.equal(report.unresolvedDependencies, 0)
    assert.equal(report.projects, 1)
    assert.equal(report.pluginBundles, 1)
    assert.equal(report.lastCheckedAt, undefined)
    assert.deepEqual(report.sources.map(source => source.status), ['not-run', 'not-run', 'not-run'])
    assert.match(renderRadarStatus(report), /No completed check is recorded yet/)
  })

  it('counts active incidents and distinguishes a failed source from a healthy run', () => {
    const state = emptyRadarState()
    state.sourceHealth = {
      osv: {
        lastAttemptedAt: '2026-08-16T01:00:00.000Z',
        lastSucceededAt: '2026-08-16T01:00:00.000Z',
        consecutiveFailures: 0,
      },
      'npm-releases': {
        lastAttemptedAt: '2026-08-16T01:01:00.000Z',
        consecutiveFailures: 2,
        lastError: 'temporary registry timeout',
      },
    }
    Object.assign(state.activeVulnerabilities, { vulnerability: {} })
    Object.assign(state.activeCompatibility, { compatibility: {} })
    Object.assign(state.activeSourceHealth ?? (state.activeSourceHealth = {}), { source: {} })
    state.pendingAnalysisTasks.push({} as never)

    const report = createRadarStatus(config, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
    })

    assert.equal(report.monitoring, 'degraded')
    assert.equal(report.coverage, 'complete')
    assert.equal(report.lastCheckedAt, '2026-08-16T01:01:00.000Z')
    assert.equal(report.activeVulnerabilities, 1)
    assert.equal(report.activeCompatibility, 1)
    assert.equal(report.activeSourceHealth, 1)
    assert.equal(report.pendingAnalysisTasks, 1)
    assert.equal(report.sources[0]?.status, 'healthy')
    assert.equal(report.sources[1]?.status, 'degraded')
    assert.match(renderRadarStatus(report), /temporary registry timeout/)
  })

  it('does not treat absent optional platform packages as a required coverage gap', () => {
    const optionalConfig = structuredClone(config)
    const graph = optionalConfig.projects[0]?.plugins[0]?.graph
    assert.ok(graph)
    graph.hostRuntime = { source: 'dsh-profile-fallback', resolvedNodes: 22 }
    graph.unresolved = [{ from: graph.rootNodeId, name: 'native-addon-darwin', kind: 'optional', spec: '1.0.0' }]

    const report = createRadarStatus(optionalConfig, emptyRadarState(), {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: false,
    })

    assert.equal(report.coverage, 'complete')
    assert.equal(report.requiredUnresolvedDependencies, 0)
    assert.equal(report.optionalDependenciesNotInstalled, 1)
    assert.equal(report.dshHostRuntimePackages, 22)
    assert.match(renderRadarStatus(report), /1 optional dependency not installed/)
  })
})
