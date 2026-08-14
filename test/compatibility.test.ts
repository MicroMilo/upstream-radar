import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessCompatibilityChange } from '../src/compatibility.js'
import type { ProjectInventory } from '../src/radar-types.js'

const inventory: ProjectInventory = {
  schema: 'upstream-radar.inventory/v1alpha1',
  project: { id: 'payments-api', name: 'Payments API', owner: 'payments-platform', channels: ['stdout'] },
  environment: { nodeVersion: '22.18.0' },
  plugins: [{
    package: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'plugin',
      nodes: [
        { id: 'plugin', name: 'plugin', version: '1.0.0' },
        { id: 'dsh-agent', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.5' },
      ],
      edges: [{ from: 'plugin', to: 'dsh-agent', kind: 'peer' }],
    },
  }],
}

describe('compatibility change assessment', () => {
  it('routes a risky plugin update to projects that run the previous version', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: {
        name: 'plugin',
        version: '1.0.0',
        main: './dist/index.js',
        engines: { node: '>=22' },
        peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0-rc.5' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      candidate: {
        name: 'plugin',
        version: '2.0.0',
        main: './dist/plugin.js',
        engines: { node: '>=24' },
        peerDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0' },
        dsh: { bundle: { patch: './next.patch.yml' } },
      },
      releaseNotes: 'BREAKING CHANGE: requires the new DSH agent API.',
      detectedAt: '2026-08-14T04:00:00.000Z',
    })

    assert.ok(result)
    assert.equal(result.kind, 'compatibility')
    const codes = result.signals.map(signal => signal.code)
    assert.ok(codes.includes('breaking-version-boundary'))
    assert.ok(codes.includes('node-runtime-incompatible'))
    assert.ok(codes.includes('dsh-peer-incompatible'))
    assert.ok(codes.includes('dsh-bundle-changed'))
    assert.ok(codes.includes('publisher-declared-breaking-change'))
  })

  it('compares optional manifest fields when a release adds them', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: {
        name: 'plugin',
        version: '1.0.0',
      },
      candidate: {
        name: 'plugin',
        version: '1.1.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      detectedAt: '2026-08-14T04:00:00.000Z',
    })

    assert.ok(result)
    assert.ok(result.signals.some(signal => signal.code === 'dsh-bundle-changed'))
  })
})
