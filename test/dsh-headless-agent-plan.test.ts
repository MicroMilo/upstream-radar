import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDshInstallPlan } from '../src/dsh-install-plan.js'
import {
  applyDshHeadlessAgentPlans,
  createDshHeadlessAgentInputFingerprint,
  emptyDshHeadlessAgentPlans,
  parseDshHeadlessAgentDecision,
  parseDshHeadlessAgentPlans,
  renderDshHeadlessAgentPrompt,
  selectDshHeadlessAgentReviewEntries,
  type DshHeadlessAgentCandidate,
} from '../src/dsh-headless-agent-plan.js'

const candidate: DshHeadlessAgentCandidate = {
  caseId: 'vision-node22',
  targetId: 'vision',
  plugin: 'dsh-vision@1.0.0',
  dshVersion: '0.1.1-rc.2',
  nodeMajor: 22,
  executionEnvironment: { platform: 'linux', architecture: 'x64', profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } },
  result: 'build-approval-required',
  reason: 'the isolated install requires explicit approval for sharp',
  requiredDependencyBuilds: ['sharp'],
  previouslyApprovedBuilds: [],
  artifactSha256: 'a'.repeat(64),
  repository: 'example/dsh-vision',
  sourceCommit: 'b'.repeat(40),
  manifest: { name: 'dsh-vision', dsh: { client: { platform: 'web' } } },
  dynamicEvidence: {
    runtimeGraph: {
      digest: `sha256:${'e'.repeat(64)}`,
      nodes: 12,
      edges: 24,
      unresolved: 1,
      unresolvedDependencies: [{
        from: 'node_modules/dsh-vision',
        name: '@deepseek-ai/dsh-client-ui-primitives',
        spec: '^0.1.1-rc.2',
        kind: 'peer',
      }],
    },
  },
  documents: [{ path: 'README.md', text: 'Install this plugin with DSH.' }],
}

function plans(action: 'retry-headless' | 'stop-headless' = 'retry-headless') {
  return {
    schema: 'upstream-radar.dsh-headless-agent-plans/v1alpha1',
    updatedAt: '2026-08-24T00:00:00.000Z',
    entries: [{
      caseId: candidate.caseId,
      targetId: candidate.targetId,
      plugin: candidate.plugin,
      dshVersion: candidate.dshVersion,
      nodeMajor: candidate.nodeMajor,
      executionEnvironment: candidate.executionEnvironment,
      result: candidate.result,
      observedRequiredBuilds: candidate.requiredDependencyBuilds,
      approvedBuilds: action === 'retry-headless' ? ['sharp'] : [],
      artifactSha256: candidate.artifactSha256,
      repository: candidate.repository,
      sourceCommit: candidate.sourceCommit,
      inputFingerprint: createDshHeadlessAgentInputFingerprint(candidate),
      plannedAt: '2026-08-24T00:00:00.000Z',
      model: 'deepseek-v4-flash',
      action,
      classification: action === 'retry-headless' ? 'build-approval' : 'insufficient-evidence',
      allowedBuilds: action === 'retry-headless' ? ['sharp'] : [],
      summary: action === 'retry-headless' ? 'Retry the exact artifact with sharp approved.' : 'Do not retry.',
      evidence: ['README.md describes the normal DSH install.'],
    }],
  }
}

const targets = {
  schema: 'upstream-radar.dsh-install-targets/v1alpha1',
  refreshAfterHours: 168,
  runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
  plugins: [{ id: 'vision', spec: 'dsh-vision@1.0.0', reason: 'vision plugin' }],
}

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
    entries: [{
      caseId: candidate.caseId,
      targetId: candidate.targetId,
      plugin: candidate.plugin,
      dshVersion: candidate.dshVersion,
      runtime: { nodeMajor: 22, nodeVersion: '22.23.0', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      staticFingerprint: `sha256:${'c'.repeat(64)}`,
      contractFingerprint: `sha256:${'d'.repeat(64)}`,
      observedAt: '2026-08-23T00:00:00.000Z',
      result: 'build-approval-required',
      reason: candidate.reason,
      requiredDependencyBuilds: ['sharp'],
      artifact: { lifecycleScripts: [], sha256: candidate.artifactSha256 },
      observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.42.0' },
      ...overrides,
    }],
  }
}

function plannedBuilds(applied: unknown): string {
  return buildDshInstallPlan(applied, { targets: { 'deepseek-harness': {
    package: { name: '@deepseek-ai/dsh', version: candidate.dshVersion },
  } } }, { changes: [] }).matrix.include[0]?.allowedBuilds ?? ''
}

describe('DSH headless Agent planning', () => {
  it('does not rebind a saved build approval to a new architecture, package manager, or override environment', () => {
    const saved = plans()
    const bound = { ...saved, entries: saved.entries.map(entry => ({ ...entry, executionEnvironment: {
      platform: 'linux', architecture: 'x64', profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} },
    } })) }
    assert.equal(plannedBuilds(applyDshHeadlessAgentPlans(targets, bound, ledger())), 'sharp')
    const legacy = { ...saved, entries: saved.entries.map(entry => ({ ...entry, executionEnvironment: undefined })) }
    assert.equal(applyDshHeadlessAgentPlans(targets, legacy, ledger()).plugins[0]?.buildApprovals?.length ?? 0, 0)
    for (const changes of [{ runtime: { nodeMajor: 22, nodeVersion: '22.23.0', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' } },
      { profileEnvironment: { pnpmVersion: '11.8.0', overrides: {} } },
      { profileEnvironment: { pnpmVersion: '11.7.0', overrides: { sharp: '0.34.0' } } }]) {
      assert.equal(applyDshHeadlessAgentPlans(targets, bound, ledger(changes)).plugins[0]?.buildApprovals?.length ?? 0, 0)
    }
  })

  it('does not transfer a Node-specific build approval to another runtime or a newer DSH/plugin coordinate', () => {
    const twoRuntimes = { ...targets, runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }, { id: 'node24', nodeMajor: 24 }],
      plugins: [{ ...targets.plugins[0]!, runtimeProfiles: ['node22', 'node24'] }] }
    const applied = applyDshHeadlessAgentPlans(twoRuntimes, plans(), ledger())
    const state = { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: candidate.dshVersion } } } }
    const initial = buildDshInstallPlan(applied, state, { changes: [] })
    assert.equal(initial.matrix.include.find(cell => cell.nodeMajor === 22)?.allowedBuilds, 'sharp')
    assert.equal(Reflect.get(initial.matrix.include.find(cell => cell.nodeMajor === 22)!, 'expectedArtifactSha256'), candidate.artifactSha256)
    assert.equal(initial.matrix.include.find(cell => cell.nodeMajor === 24)?.allowedBuilds, '')
    state.targets['deepseek-harness'].package.version = '0.1.5-rc.2'
    assert.ok(buildDshInstallPlan(applied, state, { changes: [] }).matrix.include.every(cell => cell.allowedBuilds === ''))
    state.targets['deepseek-harness'].package.version = candidate.dshVersion
    applied.plugins[0]!.spec = 'dsh-vision@1.1.0'
    assert.ok(buildDshInstallPlan(applied, state, { changes: [] }).matrix.include.every(cell => cell.allowedBuilds === ''))
  })

  it('selects the current observed plugin coordinate instead of the stale corpus coordinate', () => {
    const mappedTargets = {
      ...targets,
      plugins: [{
        ...targets.plugins[0]!,
        observerTargetId: 'dsh-vision',
      }],
    }
    const observations = {
      targets: {
        'dsh-vision': {
          package: { name: 'dsh-vision', version: '1.1.0' },
        },
      },
    }
    const currentLedger = ledger({ plugin: 'dsh-vision@1.1.0' })

    const selected = selectDshHeadlessAgentReviewEntries(mappedTargets, observations, currentLedger)

    assert.deepEqual(selected.map(entry => entry.plugin), ['dsh-vision@1.1.0'])
    assert.deepEqual(
      selectDshHeadlessAgentReviewEntries(mappedTargets, {
        targets: { 'dsh-vision': { package: { name: 'unrelated-package', version: '1.1.0' } } },
      }, currentLedger),
      [],
    )
  })

  it('accepts one exact observed build approval and keeps repository text untrusted', () => {
    const decision = parseDshHeadlessAgentDecision({
      action: 'retry-headless',
      classification: 'build-approval',
      allowedBuilds: ['sharp'],
      summary: 'The documented package requires sharp during install.',
      evidence: ['README.md install section and the isolated pnpm result.'],
    }, candidate)
    assert.deepEqual(decision.allowedBuilds, ['sharp'])
    assert.match(renderDshHeadlessAgentPrompt(candidate), /untrusted-document/)
    assert.match(renderDshHeadlessAgentPrompt(candidate), /cannot add a Web\/TUI plane/)
    assert.match(renderDshHeadlessAgentPrompt(candidate), /dsh-client-ui-primitives/)
    assert.match(renderDshHeadlessAgentPrompt(candidate), /"architecture":"x64"/)
    assert.match(renderDshHeadlessAgentPrompt(candidate), /"pnpmVersion":"11.7.0"/)
  })

  it('rejects invented build packages and retries for non-build evidence', () => {
    assert.throws(() => parseDshHeadlessAgentDecision({
      action: 'retry-headless',
      classification: 'build-approval',
      allowedBuilds: ['node-pty'],
      summary: 'Invented environment delta.',
      evidence: ['No matching dynamic evidence.'],
    }, candidate), /absent from the isolated observation/)

    assert.throws(() => parseDshHeadlessAgentDecision({
      action: 'retry-headless',
      classification: 'build-approval',
      allowedBuilds: ['sharp'],
      summary: 'Wrong result type.',
      evidence: ['Existing peer evidence only.'],
    }, { ...candidate, result: 'peer-contract-incompatible', requiredDependencyBuilds: [] }), /only after a reproduced build-approval-required/)
  })

  it('requires the Agent to accumulate approvals across staged build gates', () => {
    const stagedCandidate = {
      ...candidate,
      reason: 'the next isolated retry requires explicit approval for protobufjs',
      requiredDependencyBuilds: ['protobufjs'],
      previouslyApprovedBuilds: ['sharp'],
    }
    assert.throws(() => parseDshHeadlessAgentDecision({
      action: 'retry-headless',
      classification: 'build-approval',
      allowedBuilds: ['protobufjs'],
      summary: 'Approve only the newly visible gate.',
      evidence: ['The latest isolated retry named protobufjs.'],
    }, stagedCandidate), /dropped dependency builds approved in an earlier retry: sharp/)

    const decision = parseDshHeadlessAgentDecision({
      action: 'retry-headless',
      classification: 'build-approval',
      allowedBuilds: ['protobufjs', 'sharp'],
      summary: 'Retain sharp and add protobufjs.',
      evidence: ['Two consecutive isolated retries established both build gates.'],
    }, stagedCandidate)
    assert.deepEqual(decision.allowedBuilds, ['protobufjs', 'sharp'])
    assert.match(renderDshHeadlessAgentPrompt(stagedCandidate), /never drop an earlier approval/)
  })

  it('overlays a retry only onto the exact artifact and runtime cell', () => {
    const applied = applyDshHeadlessAgentPlans(targets, plans(), ledger())
    assert.equal(plannedBuilds(applied), 'sharp')
    assert.deepEqual(applyDshHeadlessAgentPlans(applied, plans(), ledger()), applied, 'reapplying a saved review must not accumulate duplicate approvals')

    const compatibleRefresh = applyDshHeadlessAgentPlans(targets, plans(), ledger({
      result: 'compatible',
      reason: 'the approved exact artifact installed and loaded',
      requiredDependencyBuilds: undefined,
    }))
    assert.equal(plannedBuilds(compatibleRefresh), 'sharp')

    const differentArtifact = applyDshHeadlessAgentPlans(
      targets,
      plans(),
      ledger({ artifact: { lifecycleScripts: [], sha256: 'e'.repeat(64) } }),
    )
    assert.equal(plannedBuilds(differentArtifact), '')
  })

  it('does not turn a stopped or missing Agent plan into a static fallback', () => {
    const stopped = applyDshHeadlessAgentPlans(targets, plans('stop-headless'), ledger())
    assert.equal(plannedBuilds(stopped), '')
    const missing = applyDshHeadlessAgentPlans(targets, emptyDshHeadlessAgentPlans(), ledger())
    assert.equal(plannedBuilds(missing), '')
  })

  it('reviews an unknown post-retry result without permitting another headless retry', () => {
    const unknownCandidate: DshHeadlessAgentCandidate = {
      ...candidate,
      result: 'unknown',
      reason: 'the exact artifact installed and loaded, but the effective DSH runtime graph has one required unresolved edge',
      requiredDependencyBuilds: [],
      previouslyApprovedBuilds: ['sharp'],
    }
    const decision = parseDshHeadlessAgentDecision({
      action: 'stop-headless',
      classification: 'different-plane',
      allowedBuilds: [],
      summary: 'The remaining edge belongs to the Web UI host, so headless cannot establish compatibility.',
      evidence: ['The runtime graph lacks @deepseek-ai/dsh-client-ui-primitives.'],
    }, unknownCandidate)
    assert.equal(decision.classification, 'different-plane')

    assert.throws(() => parseDshHeadlessAgentDecision({
      action: 'retry-headless',
      classification: 'build-approval',
      allowedBuilds: ['sharp'],
      summary: 'Retry the unknown result.',
      evidence: ['No new build gate was observed.'],
    }, unknownCandidate), /only after a reproduced build-approval-required/)

    const unknownPlans = plans()
    unknownPlans.entries[0] = {
      ...unknownPlans.entries[0]!,
      result: 'unknown',
      action: 'stop-headless',
      classification: 'different-plane',
      allowedBuilds: [],
      approvedBuilds: ['sharp'],
    }
    const parsed = parseDshHeadlessAgentPlans(unknownPlans)
    assert.equal(parsed.entries[0]?.result, 'unknown')
    assert.deepEqual(parsed.entries[0]?.approvedBuilds, ['sharp'])

    const retained = applyDshHeadlessAgentPlans(targets, unknownPlans, ledger({
      result: 'unknown',
      reason: unknownCandidate.reason,
      requiredDependencyBuilds: undefined,
    }))
    assert.equal(plannedBuilds(retained), 'sharp')
  })

  it('parses a bounded durable plan state', () => {
    const parsed = parseDshHeadlessAgentPlans(plans())
    assert.equal(parsed.entries[0]?.model, 'deepseek-v4-flash')
    assert.match(parsed.entries[0]?.inputFingerprint ?? '', /^sha256:/)
    assert.throws(() => parseDshHeadlessAgentPlans({ ...plans(), entries: plans().entries.map(entry => ({ ...entry,
      executionEnvironment: { platform: 'linux', architecture: 'x64' } })) }), /environment/)
  })
})
