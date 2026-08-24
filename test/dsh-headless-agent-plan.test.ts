import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyDshHeadlessAgentPlans,
  createDshHeadlessAgentInputFingerprint,
  emptyDshHeadlessAgentPlans,
  parseDshHeadlessAgentDecision,
  parseDshHeadlessAgentPlans,
  renderDshHeadlessAgentPrompt,
  type DshHeadlessAgentCandidate,
} from '../src/dsh-headless-agent-plan.js'

const candidate: DshHeadlessAgentCandidate = {
  caseId: 'vision-node22',
  targetId: 'vision',
  plugin: 'dsh-vision@1.0.0',
  dshVersion: '0.1.1-rc.2',
  nodeMajor: 22,
  result: 'build-approval-required',
  reason: 'the isolated install requires explicit approval for sharp',
  requiredDependencyBuilds: ['sharp'],
  previouslyApprovedBuilds: [],
  artifactSha256: 'a'.repeat(64),
  repository: 'example/dsh-vision',
  sourceCommit: 'b'.repeat(40),
  manifest: { name: 'dsh-vision', dsh: { client: { platform: 'web' } } },
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
      result: candidate.result,
      observedRequiredBuilds: candidate.requiredDependencyBuilds,
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

describe('DSH headless Agent planning', () => {
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
    assert.deepEqual(applied.plugins[0]?.allowedBuilds, ['sharp'])

    const compatibleRefresh = applyDshHeadlessAgentPlans(targets, plans(), ledger({
      result: 'compatible',
      reason: 'the approved exact artifact installed and loaded',
      requiredDependencyBuilds: undefined,
    }))
    assert.deepEqual(compatibleRefresh.plugins[0]?.allowedBuilds, ['sharp'])

    const differentArtifact = applyDshHeadlessAgentPlans(
      targets,
      plans(),
      ledger({ artifact: { lifecycleScripts: [], sha256: 'e'.repeat(64) } }),
    )
    assert.equal(differentArtifact.plugins[0]?.allowedBuilds, undefined)
  })

  it('does not turn a stopped or missing Agent plan into a static fallback', () => {
    const stopped = applyDshHeadlessAgentPlans(targets, plans('stop-headless'), ledger())
    assert.equal(stopped.plugins[0]?.allowedBuilds, undefined)
    const missing = applyDshHeadlessAgentPlans(targets, emptyDshHeadlessAgentPlans(), ledger())
    assert.equal(missing.plugins[0]?.allowedBuilds, undefined)
  })

  it('parses a bounded durable plan state', () => {
    const parsed = parseDshHeadlessAgentPlans(plans())
    assert.equal(parsed.entries[0]?.model, 'deepseek-v4-flash')
    assert.match(parsed.entries[0]?.inputFingerprint ?? '', /^sha256:/)
  })
})
