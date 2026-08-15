import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NpmCandidateGraphClient } from '../src/npm-candidate.js'
import { packageKey } from '../src/osv.js'
import type { DependencyGraph, PackageCoordinate } from '../src/radar-types.js'

function graph(candidate: PackageCoordinate, unresolved: DependencyGraph['unresolved'] = []): DependencyGraph {
  const root = candidate.name
  return {
    schema: 'upstream-radar.dependency-graph/v1alpha1',
    rootNodeId: root,
    nodes: [{ id: root, name: candidate.name, version: candidate.version }],
    edges: [],
    source: 'npm-lock',
    ...(unresolved.length === 0 ? {} : { unresolved }),
  }
}

describe('npm candidate dependency graphs', () => {
  it('distinguishes complete, incomplete and unavailable candidate resolutions', async () => {
    const client = new NpmCandidateGraphClient({
      resolve: async candidate => {
        if (candidate.version === '1.2.0') throw new Error('registry timeout')
        if (candidate.version === '1.1.0') {
          return graph(candidate, [{ from: candidate.name, name: 'peer-addon', kind: 'peer', spec: '^2.0.0' }])
        }
        return graph(candidate)
      },
    })
    const candidates: PackageCoordinate[] = [
      { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
      { ecosystem: 'npm', name: 'plugin', version: '1.1.0' },
      { ecosystem: 'npm', name: 'plugin', version: '1.2.0' },
    ]

    const result = await client.query(candidates)
    assert.equal(result.get(packageKey(candidates[0]!))?.status, 'checked')
    assert.equal(result.get(packageKey(candidates[1]!))?.status, 'incomplete')
    assert.equal(result.get(packageKey(candidates[2]!))?.status, 'unavailable')
    assert.match(result.get(packageKey(candidates[2]!))?.error ?? '', /registry timeout/)
  })

  it('does not silently accept more candidates than the bounded query budget', async () => {
    const client = new NpmCandidateGraphClient({ resolve: async candidate => graph(candidate) })
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      ecosystem: 'npm' as const,
      name: `plugin-${index}`,
      version: '1.0.0',
    }))
    await assert.rejects(client.query(candidates), /exceeds the 64 package limit/)
  })
})
