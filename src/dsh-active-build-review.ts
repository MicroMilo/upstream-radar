import {
  createDshHeadlessAgentInputFingerprint,
  parseDshHeadlessAgentDecision,
  parseDshHeadlessAgentPlans,
  renderDshHeadlessAgentPrompt,
  type DshHeadlessAgentCandidate,
  type DshHeadlessAgentPlans,
} from './dsh-headless-agent-plan.js'

function requireExactGate(candidate: DshHeadlessAgentCandidate): void {
  if (candidate.result !== 'build-approval-required' || candidate.requiredDependencyBuilds.length === 0
    || candidate.artifactSha256 === undefined || !/^[a-f0-9]{64}$/.test(candidate.artifactSha256)
    || candidate.executionEnvironment === undefined
    || !/^sha256:[a-f0-9]{64}$/.test(candidate.dynamicEvidence?.runtimeGraph?.digest ?? '')) {
    throw new Error('dependency-build review requires an exact isolated artifact, environment, dependency graph and observed build gate')
  }
}

export function prepareDshActiveBuildReview(
  plansInput: unknown, candidate: DshHeadlessAgentCandidate,
): { plans: DshHeadlessAgentPlans; guidance: string; inputFingerprint: string } {
  requireExactGate(candidate)
  const plans = parseDshHeadlessAgentPlans(plansInput)
  const inputFingerprint = createDshHeadlessAgentInputFingerprint(candidate)
  const pending = plans.pendingTasks ?? []
  const next = parseDshHeadlessAgentPlans({ ...plans, updatedAt: new Date().toISOString(),
    pendingTasks: pending.some(task => task.caseId === candidate.caseId && task.inputFingerprint === inputFingerprint)
      ? pending : [...pending.filter(task => task.caseId !== candidate.caseId), {
        caseId: candidate.caseId, inputFingerprint, createdAt: new Date().toISOString(), attempts: 0,
      }],
  })
  return { plans: next, guidance: renderDshHeadlessAgentPrompt(candidate), inputFingerprint }
}

export function decideDshActiveBuildReview(
  plansInput: unknown, candidate: DshHeadlessAgentCandidate, decisionInput: unknown,
): DshHeadlessAgentPlans {
  requireExactGate(candidate)
  const plans = parseDshHeadlessAgentPlans(plansInput)
  const inputFingerprint = createDshHeadlessAgentInputFingerprint(candidate)
  if (!plans.pendingTasks?.some(task => task.caseId === candidate.caseId && task.inputFingerprint === inputFingerprint)) {
    throw new Error('the exact dependency-build analysis task must be pending before the Agent decision')
  }
  const decision = parseDshHeadlessAgentDecision(decisionInput, candidate)
  const entry = {
    caseId: candidate.caseId, targetId: candidate.targetId, plugin: candidate.plugin,
    dshVersion: candidate.dshVersion, nodeMajor: candidate.nodeMajor,
    executionEnvironment: candidate.executionEnvironment, result: candidate.result,
    observedRequiredBuilds: [...new Set([
      ...candidate.previouslyApprovedBuilds, ...candidate.requiredDependencyBuilds,
    ])].sort(),
    approvedBuilds: decision.action === 'retry-headless'
      ? decision.allowedBuilds : candidate.previouslyApprovedBuilds,
    artifactSha256: candidate.artifactSha256,
    dependencyGraphDigest: candidate.dynamicEvidence!.runtimeGraph!.digest,
    ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
    ...(candidate.sourceCommit === undefined ? {} : { sourceCommit: candidate.sourceCommit }),
    inputFingerprint, plannedAt: new Date().toISOString(), model: 'codex-yolo-active-case',
    ...(candidate.documentCoverageGaps === undefined ? {} : { documentCoverageGaps: candidate.documentCoverageGaps }),
    ...decision,
  }
  return parseDshHeadlessAgentPlans({ ...plans, updatedAt: new Date().toISOString(),
    entries: [...plans.entries.filter(item => item.caseId !== candidate.caseId), entry],
    pendingTasks: plans.pendingTasks.filter(task => task.caseId !== candidate.caseId),
  })
}
