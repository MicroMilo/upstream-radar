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

  it('updates accepted cells while retaining prior evidence for a missing cell', () => {
    const missingExpected: DshCompatibilityExpectedCase = {
      ...expected,
      id: 'missing-node24',
      targetId: 'missing',
      plugin: 'missing-plugin@1.0.0',
      staticFingerprint: `sha256:${'1'.repeat(64)}`,
      contractFingerprint: `sha256:${'2'.repeat(64)}`,
    }
    const initial = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected, missingExpected],
      reports: [
        report(),
        report({
          caseId: missingExpected.id,
          artifact: {
            spec: missingExpected.plugin,
            sha256: '3'.repeat(64),
            nodeEngine: '>=24.11.0',
            lifecycleScripts: [],
          },
        }),
      ],
    })

    const refreshed = mergeDshCompatibilityLedger({
      ledger: initial.ledger,
      expected: [expected, missingExpected],
      reports: [report({
        completedAt: '2026-08-22T00:00:00.000Z',
        artifact: {
          spec: expected.plugin,
          sha256: '4'.repeat(64),
          nodeEngine: '>=24.11.0',
          lifecycleScripts: [],
        },
      })],
    })

    assert.deepEqual(refreshed.acceptedCaseIds, [expected.id])
    assert.deepEqual(refreshed.missingCaseIds, [missingExpected.id])
    assert.equal(refreshed.ledger.entries.find(entry => entry.caseId === expected.id)?.observedAt, '2026-08-22T00:00:00.000Z')
    assert.equal(refreshed.ledger.entries.find(entry => entry.caseId === expected.id)?.artifact.sha256, '4'.repeat(64))
    assert.equal(refreshed.ledger.entries.find(entry => entry.caseId === missingExpected.id)?.observedAt, '2026-08-21T00:00:00.000Z')
    assert.equal(refreshed.ledger.entries.find(entry => entry.caseId === missingExpected.id)?.artifact.sha256, '3'.repeat(64))
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

  it('does not hide a new incompatibility behind artifact drift', () => {
    const compatible = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report()],
    })
    const incompatible = mergeDshCompatibilityLedger({
      ledger: compatible.ledger,
      expected: [expected],
      reports: [report({
        artifact: {
          spec: expected.plugin,
          sha256: 'f'.repeat(64),
          nodeEngine: '>=24.11.0',
          lifecycleScripts: [],
        },
        result: 'load-failed',
        reason: 'the new artifact fails during DSH boot',
      })],
    })
    assert.equal(incompatible.transitions[0]?.status, 'new-incompatibility')
  })

  it('records a fixed replacement artifact as resolved instead of generic drift', () => {
    const incompatible = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report({ result: 'install-failed', reason: 'the package cannot resolve its host dependency' })],
    })
    const resolved = mergeDshCompatibilityLedger({
      ledger: incompatible.ledger,
      expected: [expected],
      reports: [report({
        artifact: {
          spec: expected.plugin,
          sha256: 'f'.repeat(64),
          nodeEngine: '>=24.11.0',
          lifecycleScripts: [],
        },
      })],
    })
    assert.equal(resolved.transitions[0]?.status, 'resolved-incompatibility')
  })

  it('retains an exact build-approval requirement as review evidence', () => {
    const merged = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report({
        result: 'build-approval-required',
        reason: 'the install requires explicit approval for protobufjs',
        boundary: {
          approvedDependencyBuilds: [],
          requiredDependencyBuilds: ['protobufjs'],
        },
      })],
    })

    assert.deepEqual(merged.acceptedCaseIds, ['openpencil-node24'])
    assert.equal(merged.transitions[0]?.status, 'new-review-signal')
    assert.deepEqual(
      (merged.ledger.entries[0] as typeof merged.ledger.entries[number] & { requiredDependencyBuilds?: string[] })
        ?.requiredDependencyBuilds,
      ['protobufjs'],
    )
    assert.equal(parseDshCompatibilityLedger(merged.ledger).entries[0]?.result, 'build-approval-required')
  })

  it('calls an install failure reclassified as a build gate review evidence, not a changed incompatibility', () => {
    const failed = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report({ result: 'install-failed', reason: 'the traced install failed' })],
    })
    const reviewed = mergeDshCompatibilityLedger({
      ledger: failed.ledger,
      expected: [expected],
      reports: [report({
        result: 'build-approval-required',
        reason: 'the install requires explicit approval for protobufjs',
        boundary: {
          approvedDependencyBuilds: [],
          requiredDependencyBuilds: ['protobufjs'],
        },
      })],
    })

    assert.equal(reviewed.transitions[0]?.status, 'reclassified-for-review')
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

  it('does not call a non-semantic pnpm lockfile rewrite resolution drift', () => {
    const first = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report()],
    })
    const rewritten = mergeDshCompatibilityLedger({
      ledger: first.ledger,
      expected: [expected],
      reports: [report({
        resolution: {
          profileLockfile: {
            sha256: 'f'.repeat(64),
            bytes: 1300,
            graphDigest: `sha256:${'e'.repeat(64)}`,
            nodes: 12,
            edges: 14,
            unresolved: 0,
          },
        },
      })],
    })
    assert.equal(rewritten.transitions[0]?.status, 'compatible')
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
          runtimeGraph: {
            digest: `sha256:${'f'.repeat(64)}`,
            nodes: 2,
            edges: 1,
            unresolved: 1,
            unresolvedDependencies: [{
              from: 'node_modules/example',
              name: 'host-only',
              spec: '^2.0.0',
              kind: 'peer',
            }],
            hostRuntime: {
              source: 'dsh-profile-fallback',
              resolvedNodes: 1,
            },
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
    assert.deepEqual(merged.ledger.entries[0]?.resolution?.runtimeGraph, {
      digest: `sha256:${'f'.repeat(64)}`,
      nodes: 2,
      edges: 1,
      unresolved: 1,
      unresolvedDependencies: [{
        from: 'node_modules/example',
        name: 'host-only',
        spec: '^2.0.0',
        kind: 'peer',
      }],
      hostRuntime: { source: 'dsh-profile-fallback', resolvedNodes: 1 },
    })
  })

  it('retains a direct peer-contract violation as an incompatibility, not a green load result', () => {
    const merged = mergeDshCompatibilityLedger({
      ledger: emptyDshCompatibilityLedger(),
      expected: [expected],
      reports: [report({
        result: 'peer-contract-incompatible',
        reason: 'the exact artifact loaded, but host-runtime@2.1.0 does not satisfy ^3.0.0',
        resolution: {
          runtimeGraph: {
            digest: `sha256:${'f'.repeat(64)}`,
            nodes: 3,
            edges: 2,
            unresolved: 0,
            optionalUnavailable: 7,
            pluginPeerContracts: {
              declared: 1,
              satisfied: 0,
              mismatched: 1,
              indeterminate: 0,
              missing: 0,
              relations: [{
                name: 'host-runtime',
                required: '^3.0.0',
                status: 'mismatched',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '2.1.0',
              }],
              issues: [{
                name: 'host-runtime',
                required: '^3.0.0',
                status: 'mismatched',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '2.1.0',
              }],
            },
          },
        },
      })],
    })
    assert.equal(merged.transitions[0]?.status, 'new-incompatibility')
    assert.equal(merged.ledger.entries[0]?.result, 'peer-contract-incompatible')
    assert.deepEqual(merged.ledger.entries[0]?.resolution?.runtimeGraph?.pluginPeerContracts?.issues, [{
      name: 'host-runtime',
      required: '^3.0.0',
      status: 'mismatched',
      staticUsage: 'runtime-import-observed',
      resolvedVersion: '2.1.0',
    }])
    assert.equal(merged.ledger.entries[0]?.resolution?.runtimeGraph?.optionalUnavailable, 7)
  })
})
