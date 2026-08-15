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

  it('finds the first intermediate candidate without a deterministic blocker', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: {
        name: 'plugin',
        version: '1.0.0',
        main: './dist/index.js',
        engines: { node: '>=22' },
      },
      candidate: {
        name: 'plugin',
        version: '2.0.0',
        main: './dist/plugin.js',
        engines: { node: '>=24' },
      },
      upgradeCandidates: [
        { name: 'plugin', version: '1.1.0', main: './dist/index.js', engines: { node: '>=22' } },
        { name: 'plugin', version: '1.2.0', main: './dist/index.js', engines: { node: '>=24' } },
        { name: 'plugin', version: '2.0.0', main: './dist/plugin.js', engines: { node: '>=24' } },
      ],
      detectedAt: '2026-08-14T04:00:00.000Z',
    })

    assert.ok(result?.upgradePath)
    assert.equal(result.upgradePath.evaluated, 3)
    assert.equal(result.upgradePath.blockedCount, 2)
    assert.equal(result.upgradePath.firstCandidate?.candidate.version, '1.1.0')
    assert.deepEqual(result.upgradePath.blocked.map(item => item.candidate.version), ['1.2.0', '2.0.0'])
    assert.equal(result.upgradePath.firstCandidate?.signals.length, 0)
    assert.equal(result.upgradePath.vulnerabilityStatus, 'not-requested')
  })

  it('skips an intermediate candidate with a known OSV vulnerability', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: {
        name: 'plugin',
        version: '1.0.0',
        main: './dist/index.js',
        engines: { node: '>=22' },
      },
      candidate: {
        name: 'plugin',
        version: '2.0.0',
        main: './dist/plugin.js',
        engines: { node: '>=24' },
      },
      upgradeCandidates: [
        { name: 'plugin', version: '1.1.0', main: './dist/index.js', engines: { node: '>=22' } },
        { name: 'plugin', version: '1.2.0', main: './dist/index.js', engines: { node: '>=22' } },
        { name: 'plugin', version: '2.0.0', main: './dist/plugin.js', engines: { node: '>=24' } },
      ],
      candidateVulnerabilities: new Map([
        ['npm:plugin@1.1.0', [{
          id: 'GHSA-known-plugin',
          aliases: [],
          summary: 'Known vulnerable candidate',
          details: 'The candidate is affected.',
          severity: 'high',
          modified: '2026-08-14T04:00:00.000Z',
          fixedVersions: ['1.2.0'],
          references: [],
        }]],
      ]),
      candidateVulnerabilityStatus: 'checked',
      detectedAt: '2026-08-14T04:00:00.000Z',
    })

    assert.ok(result?.upgradePath)
    assert.equal(result.upgradePath.vulnerabilityStatus, 'checked')
    assert.equal(result.upgradePath.firstCandidate?.candidate.version, '1.2.0')
    assert.equal(result.upgradePath.blocked[0]?.candidate.version, '1.1.0')
    assert.ok(result.upgradePath.blocked[0]?.signals.some(signal => signal.code === 'known-vulnerability'))
  })

  it('does not recommend a candidate when the OSV candidate check is unavailable', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: { name: 'plugin', version: '1.0.0', main: './dist/index.js' },
      candidate: { name: 'plugin', version: '2.0.0', main: './dist/plugin.js' },
      upgradeCandidates: [
        { name: 'plugin', version: '1.1.0', main: './dist/index.js' },
        { name: 'plugin', version: '2.0.0', main: './dist/plugin.js' },
      ],
      candidateVulnerabilityStatus: 'unavailable',
      detectedAt: '2026-08-14T04:00:00.000Z',
    })

    assert.ok(result?.upgradePath)
    assert.equal(result.upgradePath.vulnerabilityStatus, 'unavailable')
    assert.equal(result.upgradePath.firstCandidate, undefined)
  })

  it('does not recommend a candidate whose transitive graph is incomplete', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: { name: 'plugin', version: '1.0.0', main: './index.js' },
      candidate: { name: 'plugin', version: '1.3.0', main: './new.js' },
      upgradeCandidates: [
        { name: 'plugin', version: '1.1.0', main: './index.js' },
        { name: 'plugin', version: '1.3.0', main: './new.js' },
      ],
      candidateDependencyChecks: new Map([
        ['npm:plugin@1.1.0', { status: 'incomplete', nodeCount: 2, unresolvedCount: 1, findings: [] }],
        ['npm:plugin@1.3.0', { status: 'checked', nodeCount: 2, unresolvedCount: 0, findings: [] }],
      ]),
      candidateDependencyStatus: 'partial',
      detectedAt: '2026-08-14T04:00:00.000Z',
    })

    assert.ok(result?.upgradePath)
    assert.equal(result.upgradePath.dependencyStatus, 'partial')
    assert.equal(result.upgradePath.uncheckedCount, 1)
    assert.equal(result.upgradePath.firstCandidate?.candidate.version, '1.3.0')
    assert.ok(result.upgradePath.blocked.length === 0)
  })

  it('does not treat an equal or older semantic version as a candidate upgrade', () => {
    const result = assessCompatibilityChange(inventory, {
      previous: { name: 'plugin', version: '2.0.0', main: './current.js' },
      candidate: { name: 'plugin', version: '1.9.0', main: './older.js' },
      detectedAt: '2026-08-14T04:00:00.000Z',
    })
    assert.equal(result, undefined)
  })
})
