import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyDshCompatibilityLedger,
  mergeDshCompatibilityLedger,
  parseDshCompatibilityLedger,
  renderDshCompatibilityLedgerMerge,
  type DshCompatibilityExpectedCase,
} from '../src/dsh-compatibility-ledger.js'

const expected: DshCompatibilityExpectedCase = {
  id: 'openpencil-node24',
  targetId: 'openpencil',
  plugin: '@zseven-w/dsh-openpencil@0.1.0-rc.1',
  dshVersion: '0.1.1-rc.1',
  nodeMajor: 24,
  allowedBuilds: '',
  staticFingerprint: `sha256:${'a'.repeat(64)}`,
  contractFingerprint: `sha256:${'b'.repeat(64)}`,
  reasons: ['missing-evidence'],
}

function report(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 'upstream-radar.dsh-install-observation/v1alpha1',
    tool: { name: 'upstream-radar', version: '0.41.0' },
    probe: 'dsh-install',
    scope: 'install-and-load-behavior',
    caseId: expected.id,
    completedAt: '2026-08-21T00:00:00.000Z',
    dshVersion: expected.dshVersion,
    runtime: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: '24.11.1',
      packageManager: { name: 'pnpm', version: '11.7.0' },
    },
    artifact: {
      spec: expected.plugin,
      sha256: 'c'.repeat(64),
      nodeEngine: '>=24.11.0',
      lifecycleScripts: [],
    },
    resolution: {
      profileLockfile: {
        sha256: 'd'.repeat(64),
        bytes: 1234,
        graphDigest: `sha256:${'e'.repeat(64)}`,
        nodes: 12,
        edges: 14,
        unresolved: 0,
      },
    },
    result: 'compatible',
    reason: 'the exact artifact installed, registered and loaded under the requested DSH version',
    boundary: { approvedDependencyBuilds: [] },
    ...overrides,
  }
}

describe('DSH compatibility ledger', () => {
  it('accepts only a report that proves it belongs to the exact scheduled cell', () => {
    const merged = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report()],
    })
    assert.deepEqual(merged.acceptedCaseIds, ['openpencil-node24'])
    assert.deepEqual(merged.missingCaseIds, [])
    assert.deepEqual(merged.rejectedReports, [])
    assert.equal(merged.ledger.entries[0]?.result, 'compatible')
    assert.equal(merged.ledger.entries[0]?.resolution?.profileLockfile?.graphDigest, `sha256:${'e'.repeat(64)}`)
    assert.equal(merged.transitions[0]?.status, 'compatible')
    assert.equal(parseDshCompatibilityLedger(merged.ledger).entries.length, 1)
  })

  it('keeps a report with the wrong runtime out of the ledger and schedules it again', () => {
    const wrongRuntime = report({
      runtime: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: '22.23.2',
        packageManager: { name: 'pnpm', version: '11.7.0' },
      },
    })
    const merged = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [wrongRuntime],
    })
    assert.deepEqual(merged.acceptedCaseIds, [])
    assert.deepEqual(merged.missingCaseIds, ['openpencil-node24'])
    assert.match(merged.rejectedReports[0] ?? '', /does not match scheduled Node 24/)
    assert.equal(merged.ledger.entries.length, 0)
  })

  it('makes a newly observed incompatible result actionable, then records its resolution', () => {
    const first = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report({ result: 'runtime-incompatible', reason: 'the plugin declares Node >=25' })],
    })
    assert.equal(first.transitions[0]?.status, 'new-incompatibility')

    const resolved = mergeDshCompatibilityLedger({
      ledger: first.ledger,
      expected: [expected],
      reports: [report()],
    })
    assert.equal(resolved.transitions[0]?.status, 'resolved-incompatibility')
    assert.match(renderDshCompatibilityLedgerMerge(resolved), /resolved-incompatibility/)
  })

  it('surfaces a newly resolved dependency graph even when install/load still succeeds', () => {
    const first = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report()],
    })
    const drifted = mergeDshCompatibilityLedger({
      ledger: first.ledger,
      expected: [expected],
      reports: [report({
        resolution: {
          profileLockfile: {
            sha256: 'f'.repeat(64),
            bytes: 1300,
            graphDigest: `sha256:${'0'.repeat(64)}`,
            nodes: 13,
            edges: 16,
            unresolved: 0,
          },
        },
      })],
    })
    assert.equal(drifted.transitions[0]?.status, 'resolution-drift')
    assert.match(renderDshCompatibilityLedgerMerge(drifted), /resolution-drift/)
  })

  it('retains bounded unresolved profile edges so an incomplete graph is explainable', () => {
    const merged = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report({
        resolution: {
          profileLockfile: {
            sha256: 'd'.repeat(64),
            bytes: 1234,
            graphDigest: `sha256:${'e'.repeat(64)}`,
            nodes: 2,
            edges: 1,
            unresolved: 1,
            unresolvedDependencies: [{
              from: 'pnpm:example@1.0.0',
              name: 'host-only',
              spec: '^2.0.0',
              kind: 'peer',
            }],
          },
        },
      })],
    })
    assert.deepEqual(merged.ledger.entries[0]?.resolution?.profileLockfile?.unresolvedDependencies, [{
      from: 'pnpm:example@1.0.0',
      name: 'host-only',
      spec: '^2.0.0',
      kind: 'peer',
    }])
  })
})
