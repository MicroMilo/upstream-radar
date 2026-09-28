/** Collection can be unchanged while an exact, reviewable DSH host dependency
 * still prevents the intended plugin profile from starting. Keep that gate
 * separate from plugin compatibility and from the batch scheduler's status. */
export interface DshHostBuildGateEntry {
  caseId: string
  result: string
  hostBuildFailures?: readonly { packageSpec: string }[]
  hostBuildExecution?: { status: string; requestedApproval: { packages: readonly string[] } }
}

export interface DshUnresolvedHostBuildGate {
  caseId: string
  packages: string[]
  reason: 'native-load-failure' | 'host-build-failed'
}

export function unresolvedDshHostBuildGates(entries: readonly DshHostBuildGateEntry[]): DshUnresolvedHostBuildGate[] {
  return entries.flatMap<DshUnresolvedHostBuildGate>(entry => {
    if (entry.hostBuildExecution?.status === 'failed') return [{ caseId: entry.caseId,
      packages: [...new Set(entry.hostBuildExecution.requestedApproval.packages)].sort(), reason: 'host-build-failed' as const }]
    if (entry.result !== 'environment-unsupported' || !entry.hostBuildFailures?.length) return []
    return [{ caseId: entry.caseId, packages: [...new Set(entry.hostBuildFailures.map(failure => failure.packageSpec))].sort(),
      reason: 'native-load-failure' as const }]
  }).sort((left, right) => left.caseId.localeCompare(right.caseId))
}
