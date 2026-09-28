import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  decideDshActiveBuildReview,
  prepareDshActiveBuildReview,
} from '../src/dsh-active-build-review.js'
import { emptyDshHeadlessAgentPlans } from '../src/dsh-headless-agent-plan.js'

it('persists the exact observed dependency-build analysis task before a bounded decision', () => {
  const candidate = {
    caseId: 'feishu-bot-node22', targetId: 'feishu-bot', plugin: 'dsh-feishu-bot@0.19.16',
    dshVersion: '0.1.6-alpha.1', nodeMajor: 22, result: 'build-approval-required' as const,
    reason: 'the isolated install requires protobufjs', requiredDependencyBuilds: ['protobufjs'],
    previouslyApprovedBuilds: [], artifactSha256: 'a'.repeat(64),
    dynamicEvidence: { runtimeGraph: { digest: `sha256:${'e'.repeat(64)}`,
      nodes: 1, edges: 0, unresolved: 0, unresolvedDependencies: [] } },
    executionEnvironment: { platform: 'linux' as const, architecture: 'arm64' as const,
      profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } },
    documents: [{ path: 'README.md', text: 'dsh plugin add dsh-feishu-bot' }],
  }
  const prepared = prepareDshActiveBuildReview(emptyDshHeadlessAgentPlans(), candidate)
  assert.equal(prepared.plans.pendingTasks?.length, 1)
  assert.match(prepared.guidance, /protobufjs/)
  assert.throws(() => decideDshActiveBuildReview(prepared.plans, candidate, {
    action: 'retry-headless', classification: 'build-approval', allowedBuilds: ['invented-build'],
    summary: 'not observed', evidence: ['observed-build-gate'],
  }), /absent|observ/)
  const next = decideDshActiveBuildReview(prepared.plans, candidate, {
    action: 'retry-headless', classification: 'build-approval', allowedBuilds: ['protobufjs'],
    summary: 'Only the exact observed build is allowed in the isolated retry.', evidence: ['observed-build-gate'],
  })
  assert.equal(next.entries[0]?.approvedBuilds[0], 'protobufjs')
  assert.equal(next.entries[0]?.artifactSha256, 'a'.repeat(64))
  assert.equal(next.entries[0]?.dependencyGraphDigest, `sha256:${'e'.repeat(64)}`)
  assert.equal(next.pendingTasks?.length, 0)
  assert.throws(() => decideDshActiveBuildReview(emptyDshHeadlessAgentPlans(), candidate, {
    action: 'retry-headless', classification: 'build-approval', allowedBuilds: ['protobufjs'],
    summary: 'No pending handoff.', evidence: ['observed-build-gate'],
  }), /pending/)
})
