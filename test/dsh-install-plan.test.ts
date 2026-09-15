import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyDshCompatibilityLedger, type DshCompatibilityExpectedCase, type DshCompatibilityLedgerEntry } from '../src/dsh-compatibility-ledger.js'
import { buildDshInstallPlan, parseDshInstallTargets } from '../src/dsh-install-plan.js'

const corpus = {
  schema: 'upstream-radar.dsh-install-targets/v1alpha1',
  refreshAfterHours: 168,
  runtimeProfiles: [
    { id: 'node22', nodeMajor: 22 },
    { id: 'node24', nodeMajor: 24 },
  ],
  plugins: [
    { id: 'feishu', spec: 'dsh-feishu-bot@0.16.0', observerTargetId: 'dsh-feishu-bot', allowedBuilds: ['protobufjs'], reason: 'messaging plugin' },
    { id: 'browser', spec: 'dsh-browser@1.2.3', reason: 'browser plugin' },
  ],
}

function state(dshVersion = '0.1.0-rc.8', feishuVersion = '0.16.1', sourceCommit = 'a'.repeat(40)): unknown {
  return {
    targets: {
      'deepseek-harness': {
        source: { repository: 'deepseek-ai/dsh', commit: 'd'.repeat(40), packagePath: 'package.json' },
        package: { name: '@deepseek-ai/dsh', version: dshVersion, integrity: 'sha512-dsh' },
        graph: { digest: 'sha256:dsh-graph' },
      },
      'dsh-feishu-bot': {
        source: { repository: 'example/dsh-feishu-bot', commit: sourceCommit, packagePath: 'package.json', lockfile: 'pnpm-lock.yaml' },
        package: { name: 'dsh-feishu-bot', version: feishuVersion, integrity: 'sha512-feishu' },
        graph: { digest: 'sha256:feishu-graph' },
        alignment: { status: 'aligned', checks: [{ code: 'source-published-identity', status: 'aligned' }] },
      },
    },
  }
}

const now = new Date('2026-08-21T00:00:00.000Z')

function entry(expected: DshCompatibilityExpectedCase, overrides: Partial<DshCompatibilityLedgerEntry> = {}): DshCompatibilityLedgerEntry {
  return {
    caseId: expected.id,
    targetId: expected.targetId,
    plugin: expected.plugin,
    dshVersion: expected.dshVersion,
    runtime: { nodeMajor: expected.nodeMajor, nodeVersion: `${expected.nodeMajor}.23.2`, platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
    staticFingerprint: expected.staticFingerprint,
    contractFingerprint: expected.contractFingerprint,
    observedAt: '2026-08-20T23:00:00.000Z',
    result: 'compatible',
    reason: 'the exact artifact installed, registered and loaded',
    artifact: { lifecycleScripts: [] },
    resolution: {
      profileLockfile: {
        sha256: 'c'.repeat(64),
        bytes: 128,
        graphDigest: `sha256:${'d'.repeat(64)}`,
        nodes: 2,
        edges: 1,
        unresolved: 0,
      },
      runtimeGraph: {
        digest: `sha256:${'e'.repeat(64)}`,
        nodes: 12,
        edges: 14,
        unresolved: 0,
        pluginPeerContracts: {
          declared: 0,
          satisfied: 0,
          mismatched: 0,
          indeterminate: 0,
          missing: 0,
          relations: [],
        },
      },
    },
    observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.41.0' },
    ...overrides,
  }
}

function baseline() {
  return buildDshInstallPlan(corpus, state(), { changes: [] }, emptyDshCompatibilityLedger(), now)
}

describe('DSH compatibility reconciliation plan', () => {
  it('tests quoted author DSH baselines as separate cells and does not invalidate them on an unrelated target release', () => {
    const targets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'web-plugin', spec: 'web-plugin@1.0.0', runtimeProfiles: ['node22'], reason: 'author baseline fixture',
        environmentRecommendation: { sourceFingerprint: `sha256:${'c'.repeat(64)}`, preferredNodeMajor: 22, nodeMajors: [22], unavailableNodeMajors: [],
          executionProfiles: ['web'], summary: 'Author baseline comparison.', evidence: ['README.md'],
          authorEnvironment: { packageManagers: [], overrides: [], workflows: [], dshVersions: [
            { version: '0.1.1-rc.2', evidence: [{ path: 'README.md', quote: 'Supports 0.1.1-rc.2' }] },
            { version: '0.1.2-rc.1', evidence: [{ path: 'README.md', quote: 'Supports 0.1.2-rc.1' }] },
          ] } } }] }
    const first = buildDshInstallPlan(targets, state('0.1.5-rc.2'), { changes: [] }, undefined, now)
    assert.deepEqual(first.matrix.include.map(cell => cell.dshVersion).sort(), ['0.1.1-rc.2', '0.1.2-rc.1', '0.1.5-rc.2'])
    assert.equal(new Set(first.matrix.include.map(cell => cell.id)).size, 3)
    const ledger = { ...emptyDshCompatibilityLedger(), entries: first.matrix.include.map(cell => entry(cell)) }
    assert.equal(buildDshInstallPlan(targets, state('0.1.5-rc.2'), { changes: [] }, ledger, now).matrix.include.length, 0)
    const changed = buildDshInstallPlan(targets, state('0.1.6-rc.1'), { changes: [] }, ledger, now)
    assert.deepEqual(changed.matrix.include.map(cell => cell.dshVersion), ['0.1.6-rc.1'])
  })

  it('plans and reuses the actual isolated architecture instead of rewriting an x64 plan after execution', () => {
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, emptyDshCompatibilityLedger(), now, new Set(),
      { platform: 'linux', architecture: 'arm64' })
    assert.equal(plan.matrix.include[0]?.architecture, 'arm64')
    const ledger = { ...emptyDshCompatibilityLedger(), entries: plan.matrix.include.map(cell => entry(cell, {
      runtime: { nodeMajor: cell.nodeMajor, nodeVersion: `${cell.nodeMajor}.23.2`, platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
    })) }
    assert.equal(buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now, new Set(),
      { platform: 'linux', architecture: 'arm64' }).run, false)
    const changed = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(changed.matrix.include.length, plan.matrix.include.length)
    assert.ok(changed.matrix.include.every(cell => cell.reasons.includes('execution-contract-changed')))
  })

  it('backfills every default runtime cell even when no package coordinate changed', () => {
    const plan = baseline()
    assert.equal(plan.run, true)
    assert.equal(plan.dshVersion, '0.1.0-rc.8')
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node22', 'feishu-node22'])
    assert.deepEqual(plan.matrix.include.map(item => item.allowedBuilds), ['', 'protobufjs'])
    assert.deepEqual(plan.matrix.include.map(item => item.reasons), [['missing-evidence'], ['missing-evidence']])
    assert.deepEqual(plan.triggers, [])
  })

  it('blocks a target instead of falling back to Node 22 when repository environment reasoning is required', () => {
    const plan = buildDshInstallPlan({
      ...corpus,
      environmentRecommendationsRequired: true,
    }, state(), { changes: [] }, emptyDshCompatibilityLedger(), now)

    assert.equal(plan.run, false)
    assert.deepEqual(plan.matrix.include, [])
    assert.deepEqual(plan.blocked.map(item => item.targetId), ['browser', 'feishu'])
    assert.match(plan.reason, /repository environment recommendation/)
  })

  it('preserves a repository-recommended Node major outside executor capability as a coverage gap', () => {
    const plan = buildDshInstallPlan({
      schema: 'upstream-radar.dsh-install-targets/v1alpha1',
      refreshAfterHours: 168,
      environmentRecommendationsRequired: true,
      runtimeProfiles: [],
      plugins: [{
        id: 'legacy',
        spec: 'legacy-plugin@1.0.0',
        runtimeProfiles: [],
        environmentRecommendation: {
          sourceFingerprint: `sha256:${'a'.repeat(64)}`,
          preferredNodeMajor: 14,
          nodeMajors: [14],
          unavailableNodeMajors: [14],
          executionProfiles: ['headless'],
          summary: 'The repository explicitly pins Node 14.',
          evidence: ['.nvmrc'],
        },
        reason: 'exercise an honest executor coverage gap',
      }],
    }, state(), { changes: [] }, emptyDshCompatibilityLedger(), now)

    assert.equal(plan.run, false)
    assert.deepEqual(plan.matrix.include, [])
    assert.match(plan.blocked[0]?.reason ?? '', /Node 14.*executable range 20-40/)
    assert.match(plan.blocked[0]?.reason ?? '', /repository evidence includes/, 'a declared or pinned runtime is not necessarily an author recommendation')
  })

  it('schedules a real Node 20 observer with pnpm 10 instead of silently replacing the declared runtime with Node 22', () => {
    const target = { ...corpus, runtimeProfiles: [{ id: 'node20', nodeMajor: 20 }],
      plugins: [{ ...corpus.plugins[0]!, runtimeProfiles: ['node20'] }] }
    const plan = buildDshInstallPlan(target, state(), { changes: [] }, emptyDshCompatibilityLedger(), now)
    assert.deepEqual(plan.matrix.include.map(cell => cell.nodeMajor), [20])
    assert.equal(plan.matrix.include[0]?.profileEnvironment?.pnpmVersion, '10.33.0')
    assert.deepEqual(plan.blocked, [])
  })

  it('stays quiet only after all desired cells have fresh exact evidence', () => {
    const first = baseline()
    const ledger = { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: first.matrix.include.map(item => entry(item)) }
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(plan.run, false)
    assert.equal(plan.dshVersion, '0.1.0-rc.8')
    assert.deepEqual(plan.matrix.include, [])
    assert.match(plan.reason, /fresh evidence/)
  })

  it('does not let a green install/load satisfy the ledger without an effective runtime graph', () => {
    const first = baseline()
    const browser = first.matrix.include.find(item => item.id === 'browser-node22') as DshCompatibilityExpectedCase
    const feishu = first.matrix.include.find(item => item.id === 'feishu-node22') as DshCompatibilityExpectedCase
    const ledger = {
      schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
      entries: [
        entry(browser, { resolution: { profileLockfile: { sha256: 'e'.repeat(64), bytes: 128 } } }),
        entry(feishu),
      ],
    }
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node22'])
    assert.deepEqual(plan.matrix.include[0]?.reasons, ['runtime-graph-missing'])
  })

  it('does not let an unresolved effective runtime graph satisfy the ledger', () => {
    const first = baseline()
    const browser = first.matrix.include.find(item => item.id === 'browser-node22') as DshCompatibilityExpectedCase
    const feishu = first.matrix.include.find(item => item.id === 'feishu-node22') as DshCompatibilityExpectedCase
    const ledger = {
      schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
      entries: [
        entry(browser, { resolution: { runtimeGraph: {
          digest: `sha256:${'f'.repeat(64)}`, nodes: 2, edges: 1, unresolved: 1,
        } } }),
        entry(feishu),
      ],
    }
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node22'])
    assert.deepEqual(plan.matrix.include[0]?.reasons, ['runtime-graph-incomplete'])
  })

  it('rechecks a green runtime graph until direct plugin peer contracts were evaluated', () => {
    const first = baseline()
    const browser = first.matrix.include.find(item => item.id === 'browser-node22') as DshCompatibilityExpectedCase
    const feishu = first.matrix.include.find(item => item.id === 'feishu-node22') as DshCompatibilityExpectedCase
    const ledger = {
      schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
      entries: [
        entry(browser, { resolution: { runtimeGraph: {
          digest: `sha256:${'f'.repeat(64)}`, nodes: 2, edges: 1, unresolved: 0,
        } } }),
        entry(feishu),
      ],
    }
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node22'])
    assert.deepEqual(plan.matrix.include[0]?.reasons, ['peer-contract-not-evaluated'])
  })

  it('retests the whole maintained default corpus when the official DSH coordinate changes', () => {
    const existing = baseline()
    const ledger = { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: existing.matrix.include.map(item => entry(item)) }
    const plan = buildDshInstallPlan(corpus, state('0.1.0-rc.9'), {
      changes: [{
        targetId: 'deepseek-harness',
        meaningful: true,
        previous: { package: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' } },
        current: { package: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.9' } },
      }],
    }, ledger, now)

    assert.equal(plan.run, true)
    assert.equal(plan.dshVersion, '0.1.0-rc.9')
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node22', 'feishu-node22'])
    assert.equal(plan.matrix.include.every(item => item.reasons.includes('dsh-coordinate-changed')), true)
    assert.deepEqual(plan.triggers, ['deepseek-harness'])
  })

  it('retests only a mapped plugin when its exact published coordinate changes', () => {
    const existing = baseline()
    const ledger = { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: existing.matrix.include.map(item => entry(item)) }
    const plan = buildDshInstallPlan(corpus, state('0.1.0-rc.8', '0.17.0'), {
      changes: [{
        targetId: 'dsh-feishu-bot',
        meaningful: true,
        previous: { package: { name: 'dsh-feishu-bot', version: '0.16.0' } },
        current: { package: { name: 'dsh-feishu-bot', version: '0.17.0' } },
      }],
    }, ledger, now)

    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['feishu-node22'])
    assert.equal(plan.matrix.include[0]?.plugin, 'dsh-feishu-bot@0.17.0')
    assert.equal(plan.matrix.include[0]?.reasons.includes('plugin-coordinate-changed'), true)
    assert.deepEqual(plan.triggers, ['dsh-feishu-bot'])
  })

  it('invalidates a fresh runtime result when static source/graph evidence drifts without an npm publication', () => {
    const first = baseline()
    const ledger = { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: first.matrix.include.map(item => entry(item)) }
    const plan = buildDshInstallPlan(corpus, state('0.1.0-rc.8', '0.16.1', 'b'.repeat(40)), { changes: [] }, ledger, now)
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['feishu-node22'])
    assert.deepEqual(plan.matrix.include[0]?.reasons, ['static-evidence-changed'])
  })

  it('periodically rechecks unchanged cells instead of treating a historical pass as permanent', () => {
    const first = baseline()
    const staleEntry = entry(first.matrix.include[0] as DshCompatibilityExpectedCase, { observedAt: '2026-08-13T00:00:00.000Z' })
    const freshEntry = entry(first.matrix.include[1] as DshCompatibilityExpectedCase)
    const ledger = { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [staleEntry, freshEntry] }
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node22'])
    assert.deepEqual(plan.matrix.include[0]?.reasons, ['stale-evidence'])
  })

  it('uses a static Node engine mismatch to schedule an alternate runtime profile once', () => {
    const first = baseline()
    const browser = first.matrix.include.find(item => item.id === 'browser-node22') as DshCompatibilityExpectedCase
    const feishu = first.matrix.include.find(item => item.id === 'feishu-node22') as DshCompatibilityExpectedCase
    const ledger = {
      schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
      entries: [
        entry(browser, { result: 'runtime-incompatible', artifact: { lifecycleScripts: [], nodeEngine: '>=24.11.0' } }),
        entry(feishu),
      ],
    }
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] }, ledger, now)
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['browser-node24'])
    assert.deepEqual(plan.matrix.include[0]?.reasons, ['missing-evidence'])
    assert.equal(plan.matrix.include[0]?.nodeMajor, 24)
  })

  it('refuses ranges, duplicate ids, and unknown runtime profiles in the maintained corpus', () => {
    assert.throws(() => parseDshInstallTargets({
      schema: 'upstream-radar.dsh-install-targets/v1alpha1',
      runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [
        { id: 'duplicate', spec: 'one@^1.0.0', reason: 'bad range' },
        { id: 'duplicate', spec: 'two@1.0.0', runtimeProfiles: ['node24'], reason: 'duplicate id' },
      ],
    }), /exact|duplicate|configured/)
  })
})
