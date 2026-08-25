import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createDshSurfaceAgentInputFingerprint,
  emptyDshSurfaceAgentPlans,
  parseDshSurfaceAgentDecision,
  parseDshSurfaceAgentPlans,
  renderDshSurfaceAgentPrompt,
  type DshSurfaceAgentCandidate,
} from '../src/dsh-surface-agent-plan.js'

const candidate: DshSurfaceAgentCandidate = {
  caseId: 'better-sidebar-node22-web',
  sourceCaseId: 'better-sidebar-node22',
  plugin: 'dsh-better-sidebar@0.16.1',
  dshVersion: '0.1.1-rc.2',
  nodeMajor: 22,
  plane: 'web',
  profile: 'web',
  result: 'environment-unsupported',
  reason: 'the declared web environment still requires explicit dependency-build approval: node-pty',
  requiredDependencyBuilds: ['node-pty'],
  previouslyApprovedBuilds: [],
  sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  artifactSha256: 'b'.repeat(64),
  repository: 'omdsh-dev/DSH-better-sidebar',
  sourceCommit: 'c'.repeat(40),
  manifest: { name: 'dsh-better-sidebar', dependencies: { 'node-pty': '^1.1.0' } },
  dynamicEvidence: { install: { status: 'failed', detail: '[ERR_PNPM_IGNORED_BUILDS] node-pty@1.1.0' } },
  documents: [{ path: 'README.md', text: 'This plugin adds a DSH Web sidebar.' }],
}

function plans() {
  return {
    schema: 'upstream-radar.dsh-surface-agent-plans/v1alpha1',
    updatedAt: '2026-08-25T00:00:00.000Z',
    entries: [{
      caseId: candidate.caseId,
      sourceCaseId: candidate.sourceCaseId,
      plugin: candidate.plugin,
      dshVersion: candidate.dshVersion,
      nodeMajor: candidate.nodeMajor,
      plane: candidate.plane,
      profile: candidate.profile,
      result: candidate.result,
      observedRequiredBuilds: candidate.requiredDependencyBuilds,
      approvedBuilds: ['node-pty'],
      sourceFingerprint: candidate.sourceFingerprint,
      artifactSha256: candidate.artifactSha256,
      repository: candidate.repository,
      sourceCommit: candidate.sourceCommit,
      inputFingerprint: createDshSurfaceAgentInputFingerprint(candidate),
      plannedAt: '2026-08-25T00:00:00.000Z',
      model: 'deepseek-v4-flash',
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['node-pty'],
      summary: 'The exact Web install observed node-pty and repository evidence supports its native PTY use.',
      evidence: ['The isolated pnpm result named node-pty and README documents terminal integration.'],
    }],
  }
}

describe('DSH execution-plane Agent planning', () => {
  it('allows only observed build packages and keeps repository text untrusted', () => {
    const decision = parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['node-pty'],
      summary: 'Approve the exact observed native PTY build.',
      evidence: ['The Web VM named node-pty and the package uses terminal support.'],
    }, candidate)
    assert.deepEqual(decision.allowedBuilds, ['node-pty'])
    assert.match(renderDshSurfaceAgentPrompt(candidate), /untrusted-document/)
    assert.match(renderDshSurfaceAgentPrompt(candidate), /cannot change the selected plane/)
    assert.match(renderDshSurfaceAgentPrompt(candidate), /ERR_PNPM_IGNORED_BUILDS/)

    assert.throws(() => parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['sharp'],
      summary: 'Invent a different native package.',
      evidence: ['No matching dynamic evidence.'],
    }, candidate), /absent from the isolated observation/)
  })

  it('retains approvals across staged surface installation gates', () => {
    const staged = {
      ...candidate,
      requiredDependencyBuilds: ['cpu-features'],
      previouslyApprovedBuilds: ['node-pty'],
    }
    assert.throws(() => parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['cpu-features'],
      summary: 'Drop the earlier policy.',
      evidence: ['The latest VM named cpu-features.'],
    }, staged), /dropped dependency builds approved in an earlier surface retry/)

    const decision = parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['cpu-features', 'node-pty'],
      summary: 'Retain node-pty and add the newly observed cpu-features build.',
      evidence: ['Two isolated Web attempts established both gates.'],
    }, staged)
    assert.deepEqual(decision.allowedBuilds, ['cpu-features', 'node-pty'])
  })

  it('parses a durable exact policy and initializes an empty state', () => {
    const parsed = parseDshSurfaceAgentPlans(plans())
    assert.deepEqual(parsed.entries[0]?.approvedBuilds, ['node-pty'])
    assert.equal(parsed.entries[0]?.plane, 'web')
    assert.deepEqual(emptyDshSurfaceAgentPlans().entries, [])
  })
})
