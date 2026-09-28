import {
  createDshSurfaceAgentHostBuildApproval,
  createDshSurfaceAgentInputFingerprint,
  parseDshSurfaceAgentDecision,
  parseDshSurfaceAgentPlans,
  renderDshSurfaceAgentPrompt,
  type DshSurfaceAgentCandidate,
  type DshSurfaceAgentPlans,
} from './dsh-surface-agent-plan.js'

function requireExactSurfaceGate(candidate: DshSurfaceAgentCandidate): void {
  if (candidate.result !== 'environment-unsupported'
    || candidate.requiredDependencyBuilds.length + (candidate.hostBuild?.failures.length ?? 0) === 0
    || !/^sha256:[a-f0-9]{64}$/.test(candidate.sourceFingerprint)
    || !/^sha256:[a-f0-9]{64}$/.test(candidate.surfaceGraphDigest ?? '')
    || !['runtime', 'profile-lock'].includes(candidate.surfaceGraphSource ?? '')
    || !/^[a-f0-9]{64}$/.test(candidate.artifactSha256)) {
    throw new Error('surface-build review requires current isolated gate, exact artifact and graph-bound source fingerprint')
  }
}

export function prepareDshActiveSurfaceBuildReview(
  plansInput: unknown, candidate: DshSurfaceAgentCandidate,
): { plans: DshSurfaceAgentPlans; guidance: string; inputFingerprint: string } {
  requireExactSurfaceGate(candidate)
  const plans = parseDshSurfaceAgentPlans(plansInput)
  const inputFingerprint = createDshSurfaceAgentInputFingerprint(candidate)
  const pending = plans.pendingTasks ?? []
  const next = parseDshSurfaceAgentPlans({ ...plans, updatedAt: new Date().toISOString(),
    pendingTasks: pending.some(task => task.caseId === candidate.caseId && task.inputFingerprint === inputFingerprint)
      ? pending : [...pending.filter(task => task.caseId !== candidate.caseId), {
        caseId: candidate.caseId, inputFingerprint, createdAt: new Date().toISOString(), attempts: 0,
      }],
  })
  return { plans: next, guidance: renderDshSurfaceAgentPrompt(candidate), inputFingerprint }
}

export function decideDshActiveSurfaceBuildReview(
  plansInput: unknown, candidate: DshSurfaceAgentCandidate, decisionInput: unknown,
): DshSurfaceAgentPlans {
  requireExactSurfaceGate(candidate)
  const plans = parseDshSurfaceAgentPlans(plansInput)
  const inputFingerprint = createDshSurfaceAgentInputFingerprint(candidate)
  if (!plans.pendingTasks?.some(task => task.caseId === candidate.caseId && task.inputFingerprint === inputFingerprint)) {
    throw new Error('the exact surface-build analysis task must be pending before the Agent decision')
  }
  const decision = parseDshSurfaceAgentDecision(decisionInput, candidate)
  const hostBuildApproval = createDshSurfaceAgentHostBuildApproval(decision, candidate)
  const entry = { caseId: candidate.caseId, sourceCaseId: candidate.sourceCaseId,
    plugin: candidate.plugin, dshVersion: candidate.dshVersion, nodeMajor: candidate.nodeMajor,
    plane: candidate.plane, profile: candidate.profile, result: candidate.result,
    observedRequiredBuilds: [...new Set([...candidate.previouslyApprovedBuilds,
      ...candidate.requiredDependencyBuilds])].sort(),
    approvedBuilds: decision.action === 'retry-surface'
      ? decision.allowedBuilds : candidate.previouslyApprovedBuilds,
    sourceFingerprint: candidate.sourceFingerprint, artifactSha256: candidate.artifactSha256,
    surfaceGraphDigest: candidate.surfaceGraphDigest,
    surfaceGraphSource: candidate.surfaceGraphSource,
    ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
    ...(candidate.sourceCommit === undefined ? {} : { sourceCommit: candidate.sourceCommit }),
    inputFingerprint, plannedAt: new Date().toISOString(), model: 'codex-yolo-active-case',
    ...(candidate.hostBuild === undefined ? {} : { hostBuild: candidate.hostBuild }),
    ...(hostBuildApproval === undefined ? {} : { hostBuildApproval }),
    ...decision,
  }
  return parseDshSurfaceAgentPlans({ ...plans, updatedAt: new Date().toISOString(),
    entries: [...plans.entries.filter(item => item.caseId !== candidate.caseId), entry],
    pendingTasks: plans.pendingTasks.filter(task => task.caseId !== candidate.caseId),
  })
}
