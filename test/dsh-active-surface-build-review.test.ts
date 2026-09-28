import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  decideDshActiveSurfaceBuildReview,
  prepareDshActiveSurfaceBuildReview,
} from '../src/dsh-active-surface-build-review.js'
import { emptyDshSurfaceAgentPlans, type DshSurfaceAgentCandidate } from '../src/dsh-surface-agent-plan.js'

const candidate: DshSurfaceAgentCandidate = {
  caseId: 'tui-node22', sourceCaseId: 'tui-node22-headless', plugin: 'dsh-tui@0.10.1',
  dshVersion: '0.1.6-alpha.1', nodeMajor: 22, plane: 'tui', profile: 'dsh-tui',
  result: 'environment-unsupported', reason: 'The isolated profile reported a node-pty build gate.',
  requiredDependencyBuilds: ['node-pty'], previouslyApprovedBuilds: [],
  sourceFingerprint: `sha256:${'a'.repeat(64)}`, artifactSha256: 'b'.repeat(64),
  surfaceGraphDigest: `sha256:${'c'.repeat(64)}`,
  surfaceGraphSource: 'runtime',
  dynamicEvidence: { runtimeGraphDigest: `sha256:${'c'.repeat(64)}` },
  documents: [{ path: 'README.md', text: 'The author runs the named dsh-tui profile.' }],
}

it('persists a real surface-build analysis task before approving only its observed isolated build', () => {
  const prepared = prepareDshActiveSurfaceBuildReview(emptyDshSurfaceAgentPlans(), candidate)
  assert.equal(prepared.plans.pendingTasks?.length, 1)
  assert.match(prepared.guidance, /node-pty/)
  assert.match(prepared.guidance, /runtime.*sha256/i)
  const decided = decideDshActiveSurfaceBuildReview(prepared.plans, candidate, {
    action: 'retry-surface', classification: 'build-approval', allowedBuilds: ['node-pty'],
    summary: 'Retry only the observed node-pty build inside the disposable TUI worker.',
    evidence: ['The exact isolated TUI profile reported this pending build.'],
  })
  assert.equal(decided.pendingTasks?.length, 0)
  assert.deepEqual(decided.entries[0]?.approvedBuilds, ['node-pty'])
  assert.equal(decided.entries[0]?.sourceFingerprint, candidate.sourceFingerprint)
  assert.equal(decided.entries[0]?.artifactSha256, candidate.artifactSha256)
  assert.equal(decided.entries[0]?.surfaceGraphDigest, candidate.surfaceGraphDigest)
  assert.equal(decided.entries[0]?.surfaceGraphSource, 'runtime')
  assert.equal(decided.entries[0]?.inputFingerprint, prepared.inputFingerprint)
  const changed = { ...candidate, dynamicEvidence: { runtimeGraphDigest: `sha256:${'d'.repeat(64)}` } }
  assert.throws(() => decideDshActiveSurfaceBuildReview(prepared.plans, changed, {
    action: 'retry-surface', classification: 'build-approval', allowedBuilds: ['node-pty'],
    summary: 'This is stale.', evidence: ['Old graph.'],
  }), /pending|exact/i)
  const { surfaceGraphDigest: _graph, ...withoutSurfaceGraph } = candidate
  assert.throws(() => prepareDshActiveSurfaceBuildReview(emptyDshSurfaceAgentPlans(),
    withoutSurfaceGraph), /graph/i)
  const profileLock = { ...candidate, surfaceGraphSource: 'profile-lock' as const,
    surfaceGraphDigest: `sha256:${'e'.repeat(64)}` }
  const lockReview = prepareDshActiveSurfaceBuildReview(emptyDshSurfaceAgentPlans(), profileLock)
  const lockPlan = decideDshActiveSurfaceBuildReview(lockReview.plans, profileLock, {
    action: 'retry-surface', classification: 'build-approval', allowedBuilds: ['node-pty'],
    summary: 'The exact incomplete profile lock graph supports only this observed build.',
    evidence: ['The isolated install produced a profile lock graph and named node-pty.'],
  })
  assert.equal(lockPlan.entries[0]?.surfaceGraphSource, 'profile-lock')
})
