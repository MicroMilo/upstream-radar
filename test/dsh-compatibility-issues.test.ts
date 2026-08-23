import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDshCompatibilityIssuePlan,
  dshCompatibilityIssueMarker,
  renderDshCompatibilityIssue,
  type DshCompatibilityExistingIssue,
} from '../src/dsh-compatibility-issues.js'
import {
  DSH_COMPATIBILITY_LEDGER_SCHEMA,
  type DshCompatibilityLedger,
  type DshCompatibilityLedgerEntry,
} from '../src/dsh-compatibility-ledger.js'

function entry(result: DshCompatibilityLedgerEntry['result']): DshCompatibilityLedgerEntry {
  return {
    caseId: 'openpencil-node24',
    targetId: 'openpencil',
    plugin: '@zseven-w/dsh-openpencil@0.1.0-rc.1',
    dshVersion: '0.1.1-rc.2',
    runtime: {
      nodeMajor: 24,
      nodeVersion: '24.11.1',
      platform: 'linux',
      architecture: 'x64',
      pnpmVersion: '11.7.0',
    },
    staticFingerprint: `sha256:${'a'.repeat(64)}`,
    contractFingerprint: `sha256:${'b'.repeat(64)}`,
    observedAt: '2026-08-23T00:00:00.000Z',
    result,
    reason: result === 'compatible'
      ? 'the exact artifact installed, registered and loaded with a complete host contract'
      : 'react-dom requires ^18.2.0 but the DSH profile resolves 19.2.8',
    artifact: { lifecycleScripts: [], sha256: 'c'.repeat(64), nodeEngine: '>=24.11.0' },
    resolution: {
      profileLockfile: {
        sha256: 'd'.repeat(64),
        bytes: 1_024,
        graphDigest: `sha256:${'e'.repeat(64)}`,
        nodes: 400,
        edges: 1_200,
        unresolved: 0,
      },
      runtimeGraph: {
        digest: `sha256:${'f'.repeat(64)}`,
        nodes: 420,
        edges: 1_500,
        unresolved: 0,
        optionalUnavailable: 3,
        pluginPeerContracts: result === 'peer-contract-incompatible'
          ? {
              declared: 1,
              satisfied: 0,
              mismatched: 1,
              missing: 0,
              indeterminate: 0,
              relations: [{
                name: 'react-dom',
                required: '^18.2.0',
                status: 'mismatched',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '19.2.8',
              }],
              issues: [{
                name: 'react-dom',
                required: '^18.2.0',
                status: 'mismatched',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '19.2.8',
              }],
            }
          : {
              declared: 1,
              satisfied: 1,
              mismatched: 0,
              missing: 0,
              indeterminate: 0,
              relations: [{
                name: 'react-dom',
                required: '^19.0.0',
                status: 'satisfied',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '19.2.8',
              }],
            },
      },
    },
    observer: {
      schema: 'upstream-radar.dsh-install-observation/v1alpha1',
      version: '0.41.0',
    },
  }
}

function ledger(value: DshCompatibilityLedgerEntry): DshCompatibilityLedger {
  return { schema: DSH_COMPATIBILITY_LEDGER_SCHEMA, entries: [value] }
}

function issue(value: DshCompatibilityLedgerEntry, state: 'open' | 'closed' = 'open'): DshCompatibilityExistingIssue {
  const rendered = renderDshCompatibilityIssue(value, 'https://github.com/MicroMilo/upstream-radar/actions/runs/1')
  return { number: 42, state, ...rendered }
}

describe('DSH compatibility issue reconciliation', () => {
  it('creates one managed issue for an actionable incompatibility', () => {
    const plan = buildDshCompatibilityIssuePlan({
      ledger: ledger(entry('load-failed')),
      existingIssues: [],
      runUrl: 'https://github.com/MicroMilo/upstream-radar/actions/runs/1',
    })
    assert.equal(plan.actions.length, 1)
    assert.equal(plan.actions[0]?.kind, 'create')
    assert.match(plan.actions[0]?.kind === 'create' ? plan.actions[0].body : '', /Reproduce the DSH registration/)
    assert.deepEqual(plan.openCaseIds, ['openpencil-node24'])
  })

  it('is quiet when the desired open issue already matches the ledger', () => {
    const incompatible = entry('load-failed')
    const plan = buildDshCompatibilityIssuePlan({
      ledger: ledger(incompatible),
      existingIssues: [issue(incompatible)],
      runUrl: 'https://github.com/MicroMilo/upstream-radar/actions/runs/1',
    })
    assert.deepEqual(plan.actions, [])
  })

  it('reopens a managed incident when the same maintained cell regresses', () => {
    const incompatible = entry('load-failed')
    const plan = buildDshCompatibilityIssuePlan({
      ledger: ledger(incompatible),
      existingIssues: [{
        number: 42,
        state: 'closed',
        title: 'resolved',
        body: dshCompatibilityIssueMarker(incompatible.caseId),
      }],
    })
    assert.equal(plan.actions[0]?.kind, 'reopen')
  })

  it('comments and closes an open incident after an isolated compatible recheck', () => {
    const compatible = entry('compatible')
    const plan = buildDshCompatibilityIssuePlan({
      ledger: ledger(compatible),
      existingIssues: [{
        number: 42,
        state: 'open',
        title: 'old incident',
        body: dshCompatibilityIssueMarker(compatible.caseId),
      }],
      runUrl: 'https://github.com/MicroMilo/upstream-radar/actions/runs/2',
    })
    assert.equal(plan.actions[0]?.kind, 'close')
    assert.match(plan.actions[0]?.kind === 'close' ? plan.actions[0].comment : '', /verified resolved/)
  })

  it('does not blame a plugin when the observer result is unknown', () => {
    const plan = buildDshCompatibilityIssuePlan({ ledger: ledger(entry('unknown')), existingIssues: [] })
    assert.deepEqual(plan.actions, [])
    assert.deepEqual(plan.ignoredUnknownCaseIds, ['openpencil-node24'])
  })

  it('keeps a headless peer-contract gap as review evidence instead of creating an incident', () => {
    const review = entry('peer-contract-incompatible')
    const plan = buildDshCompatibilityIssuePlan({ ledger: ledger(review), existingIssues: [] })
    assert.deepEqual(plan.actions, [])
    assert.deepEqual(plan.openCaseIds, [])
    assert.deepEqual(plan.reviewOnlyCaseIds, ['openpencil-node24'])
  })

  it('keeps a dependency build-approval gate as review evidence instead of blaming the plugin', () => {
    const review = {
      ...entry('unknown'),
      result: 'build-approval-required' as DshCompatibilityLedgerEntry['result'],
      reason: 'the install requires explicit approval for protobufjs',
      requiredDependencyBuilds: ['protobufjs'],
    }
    const plan = buildDshCompatibilityIssuePlan({
      ledger: ledger(review),
      existingIssues: [issue(review)],
    })

    assert.equal(plan.actions[0]?.kind, 'close')
    assert.match(plan.actions[0]?.kind === 'close' ? plan.actions[0].comment : '', /protobufjs.*does not prove the plugin artifact is incompatible/s)
    assert.deepEqual(plan.openCaseIds, [])
    assert.deepEqual(plan.reviewOnlyCaseIds, ['openpencil-node24'])
  })

  it('closes an old peer-contract incident after the evidence is reclassified', () => {
    const review = entry('peer-contract-incompatible')
    const plan = buildDshCompatibilityIssuePlan({
      ledger: ledger(review),
      existingIssues: [issue(review)],
    })
    assert.equal(plan.actions[0]?.kind, 'close')
    assert.match(plan.actions[0]?.kind === 'close' ? plan.actions[0].comment : '', /review signal, not a reproduced plugin failure/)
  })
})
