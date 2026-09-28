import { createHash } from 'node:crypto'
import { dshActiveCaseMonitorCovered, parseDshActiveCaseMonitorState } from './dsh-active-case-monitor-state.js'

export interface DshActiveAgentCaseSnapshot {
  launch?: unknown
  launchResult?: unknown
  summary?: unknown
  state?: unknown
  buildPlans?: unknown
  monitor?: unknown
  conclusion?: unknown
  reasoningInput?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function emptyPlan(value: unknown): boolean {
  const plan = record(value), matrix = record(plan?.matrix)
  return Array.isArray(matrix?.include) && matrix.include.length === 0
}

function explicitBlockedCoverage(summary: Record<string, unknown> | undefined): boolean {
  return ['nextNativePlan', 'nextSurfacePlan', 'nextAdapterPlan']
    .some(name => { const blocked = record(summary?.[name])?.blocked
      return Array.isArray(blocked) && blocked.length > 0 })
}

function explicitlyBlockedAuthorAdapter(summary: Record<string, unknown> | undefined, targetId: string): boolean {
  const blocked = record(summary?.nextAdapterPlan)?.blocked
  return Array.isArray(blocked) && blocked.some(value => record(value)?.targetId === targetId)
}

/** Adapter reports are independent of the generic native/headless install. An
 * exact, reviewed Feishu recipe must cover every native Node/DSH comparison
 * for each explicitly selected author adapter; unknown results remain honest
 * coverage, whereas absent reports cannot close the case.
 */
export function missingDshAuthorAdapterCoverage(targetId: string, summaryInput: unknown, stateInput: unknown): string[] {
  const summary = record(summaryInput), state = record(stateInput)
  const scope = Array.isArray(summary?.authorScopes)
    ? summary.authorScopes.map(record).find(item => item?.id === targetId) : undefined
  const recommendation = record(scope?.recommendation)
  const selected = Array.isArray(recommendation?.executionProfiles)
    ? recommendation.executionProfiles.filter(value => value === 'sdk' || value === 'acp' || value === 'headless') as string[] : []
  const native = record(state?.nativeLedger)?.entries
  const exactNatives = Array.isArray(native) ? native.map(record).filter(entry => entry?.targetId === targetId
    && entry.plugin === 'dsh-feishu-bot@0.19.16') : []
  if (exactNatives.length === 0 || selected.length === 0) return []
  const adapters = record(state?.adapterLedger)?.entries
  const observed = Array.isArray(adapters) ? adapters.map(record) : []
  const missing = new Set<string>()
  for (const entry of exactNatives) {
    const nodeMajor = record(entry?.runtime)?.nodeMajor, dshVersion = entry?.dshVersion
    if (!Number.isSafeInteger(nodeMajor) || typeof dshVersion !== 'string') {
      missing.add('exact native Node/DSH coordinate is incomplete'); continue
    }
    for (const adapter of selected) {
      if (!observed.some(value => {
        const cell = record(value?.cell)
        return cell?.targetId === targetId && cell.plugin === entry?.plugin
          && cell.nodeMajor === nodeMajor && cell.dshVersion === dshVersion && cell.adapter === adapter
      })) missing.add(`${adapter}:Node${nodeMajor}:DSH${dshVersion}`)
    }
  }
  return [...missing].slice(0, 32)
}

/** A relaunch makes the preceding batch ineligible for a new build review.
 * Require a graph-bound decision for every gate from that batch first, so one
 * approved Node/DSH cell cannot strand another exact baseline as stale.
 */
export function unresolvedFreshDshBuildGateCaseIds(targetId: string, stateInput: unknown,
  plansInput: unknown, launchRequestedAt: string): string[] {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)) {
    throw new Error('fresh dependency-build gates require one bounded target')
  }
  const requestedAt = Date.parse(launchRequestedAt)
  if (!Number.isFinite(requestedAt)) throw new Error('fresh dependency-build gates require the exact launch time')
  const entries = record(record(stateInput)?.nativeLedger)?.entries
  if (!Array.isArray(entries)) return []
  const plans = record(plansInput)
  const decisions = Array.isArray(plans?.entries) ? plans.entries.map(record) : []
  const pending = new Set(Array.isArray(plans?.pendingTasks)
    ? plans.pendingTasks.map(record).map(task => task?.caseId).filter((value): value is string => typeof value === 'string')
    : [])
  return entries.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined
    && entry.targetId === targetId && entry.result === 'build-approval-required'
    && typeof entry.caseId === 'string' && Number.isFinite(Date.parse(String(entry.observedAt)))
    && Date.parse(String(entry.observedAt)) >= requestedAt).filter(entry => {
      const artifact = record(entry.artifact), graph = record(record(entry.resolution)?.runtimeGraph)
      return pending.has(entry.caseId as string) || !decisions.some(decision => decision !== undefined
        && decision.caseId === entry.caseId && decision.targetId === targetId
        && (decision.action === 'retry-headless' || decision.action === 'stop-headless')
        && decision.artifactSha256 === artifact?.sha256
        && decision.dependencyGraphDigest === graph?.digest
        && JSON.stringify(decision.observedRequiredBuilds) === JSON.stringify(entry.requiredDependencyBuilds))
    }).map(entry => entry.caseId as string).slice(0, 32)
}

function unresolvedNativeBuildGate(targetId: string, state: Record<string, unknown> | undefined,
  plansInput: unknown): boolean {
  const entries = record(state?.nativeLedger)?.entries
  if (!Array.isArray(entries)) return false
  const plans = record(plansInput)
  const decisions = Array.isArray(plans?.entries) ? plans.entries : []
  const pending = Array.isArray(plans?.pendingTasks) ? plans.pendingTasks : []
  return entries.some(value => {
    const entry = record(value)
    if (entry?.targetId !== targetId || entry.result !== 'build-approval-required') return false
    const artifact = record(entry.artifact), graph = record(record(entry.resolution)?.runtimeGraph)
    const stopped = decisions.some(value => {
      const decision = record(value)
      return decision !== undefined && decision.caseId === entry.caseId && decision.targetId === targetId
        && decision.action === 'stop-headless' && decision.artifactSha256 === artifact?.sha256
        && decision.dependencyGraphDigest === graph?.digest
        && JSON.stringify(decision.observedRequiredBuilds) === JSON.stringify(entry.requiredDependencyBuilds)
        && !pending.some(value => record(value)?.caseId === entry.caseId)
    })
    return !stopped
  })
}

/** A final model message cannot close a case; only the exact broker-owned batch evidence can. */
function caseClosedWithAuthorAdapterRule(targetId: string, snapshot: DshActiveAgentCaseSnapshot,
  requireAuthorAdapters: boolean): boolean {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)) return false
  const launch = record(snapshot.launch), summary = record(snapshot.summary)
  const launchResult = record(snapshot.launchResult)
  const state = record(snapshot.state), monitor = record(snapshot.monitor)
  const conclusion = record(snapshot.conclusion)
  const reasoningInput = record(snapshot.reasoningInput)
  const launchId = launch?.id
  let monitorCovered = false
  const batchExitAccepted = launchResult?.exitCode === 0
    || (launchResult?.exitCode === 2 && explicitBlockedCoverage(summary))
  if (launchResult !== undefined && launchResult.id === launchId && batchExitAccepted
    && typeof launchResult.finishedAt === 'string') {
    try {
      monitorCovered = dshActiveCaseMonitorCovered(
        parseDshActiveCaseMonitorState(snapshot.monitor, targetId), launchId as string,
        launchResult.finishedAt, 45_000)
    } catch { monitorCovered = false }
  }
  if (launch?.targetId !== targetId || typeof launchId !== 'string' || !/^[a-f0-9]{32}$/.test(launchId)
    || summary?.activeLaunchId !== launchId || !Array.isArray(summary.authorScopes)
    || summary.authorScopes.length !== 1 || record(summary.authorScopes[0])?.id !== targetId
    || reasoningInput?.targetId !== targetId
    || typeof reasoningInput.inputFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(reasoningInput.inputFingerprint)
    || record(record(summary.authorScopes[0])?.recommendation)?.inputFingerprint !== reasoningInput.inputFingerprint
    || launchResult?.id !== launchId || !batchExitAccepted
    || !Number.isSafeInteger(summary.executed) || (summary.executed as number) < 0
    || !Array.isArray(summary.failedTasks) || summary.failedTasks.length !== 0
    || !Array.isArray(summary.deferredTaskKeys) || summary.deferredTaskKeys.length !== 0
    || !Array.isArray(summary.orphanedRunningTasks) || summary.orphanedRunningTasks.length !== 0
    || !emptyPlan(summary.nextNativePlan) || !emptyPlan(summary.nextSurfacePlan)
    || !emptyPlan(summary.nextAdapterPlan) || !Array.isArray(state?.tasks)
    || (requireAuthorAdapters && missingDshAuthorAdapterCoverage(targetId, summary, state).length > 0
      && !explicitlyBlockedAuthorAdapter(summary, targetId))
    || unresolvedNativeBuildGate(targetId, state, snapshot.buildPlans)
    || state.tasks.some(task => record(task)?.status !== 'accepted')
    || monitor?.targetId !== targetId || monitor.launchId !== launchId
    || ((summary.executed as number) > 0 && !monitorCovered)
    || ((summary.executed as number) > 0 && (!Number.isSafeInteger(monitor.runningWatches)
      || (monitor.runningWatches as number) < 1 || !Number.isSafeInteger(monitor.runningEvents)
      || (monitor.runningEvents as number) < 1))
    || conclusion?.targetId !== targetId || conclusion.activeLaunchId !== launchId
    || conclusion.modelAuthored !== true || conclusion.compatibilityPass !== false
    || typeof conclusion.statement !== 'string' || conclusion.statement.trim() === '') return false
  const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary,
    nativeLedger: state.nativeLedger, surfaceLedger: state.surfaceLedger,
    adapterLedger: state.adapterLedger, executorIdentity: state.executorIdentity })).digest('hex')}`
  return conclusion.evidenceDigest === evidenceDigest
}

export function dshActiveAgentCaseClosed(targetId: string, snapshot: DshActiveAgentCaseSnapshot): boolean {
  return caseClosedWithAuthorAdapterRule(targetId, snapshot, true)
}

/** Trusted local repair only: prove the old receipt was exact under the former
 * rule AND that the new rule now detects a real omission. Never use this to
 * admit a current Agent conclusion or to report compatibility.
 */
export function dshActiveAgentCaseFormerlyClosedForAdapterRepair(
  targetId: string, snapshot: DshActiveAgentCaseSnapshot): boolean {
  return missingDshAuthorAdapterCoverage(targetId, snapshot.summary, snapshot.state).length > 0
    && caseClosedWithAuthorAdapterRule(targetId, snapshot, false)
}

export interface DshActiveAgentTurnInput {
  reason: 'initial' | 'periodic'
  sessionId?: string
  snapshot: DshActiveAgentCaseSnapshot
  turnNumber: number
}

export interface DshActiveAgentSupervisorOptions {
  targetId: string
  /** Continue an exact already-recorded model case after a trusted broker repair. */
  initialSessionId?: string
  snapshot: () => Promise<DshActiveAgentCaseSnapshot>
  turn: (input: DshActiveAgentTurnInput) => Promise<{ sessionId: string; interrupted?: boolean }>
  wait: (durationMs: number) => Promise<void>
  intervalMs: number
  maxTurns: number
  onTurn?: (input: DshActiveAgentTurnInput & { sessionId: string }) => Promise<void>
}

/** The trusted caller drives periodic model turns even when no failure occurred. */
export async function runDshActiveAgentSupervisor(options: DshActiveAgentSupervisorOptions): Promise<{
  closed: boolean; turns: number; sessionId?: string
}> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.targetId)
    || (options.initialSessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.initialSessionId))
    || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > 60_000
    || !Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 512) {
    throw new Error('active agent supervisor requires a bounded exact case and cadence')
  }
  let sessionId: string | undefined = options.initialSessionId
  for (let turns = 0; turns < options.maxTurns; turns += 1) {
    const snapshot = await options.snapshot()
    if (dshActiveAgentCaseClosed(options.targetId, snapshot)) return { closed: true, turns,
      ...(sessionId === undefined ? {} : { sessionId }) }
    const input: DshActiveAgentTurnInput = { reason: sessionId ? 'periodic' : 'initial',
      ...(sessionId === undefined ? {} : { sessionId }), snapshot, turnNumber: turns + 1 }
    const result = await options.turn(input)
    if (typeof result.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.sessionId)
      || (sessionId && result.sessionId !== sessionId)) throw new Error('agent turn lost its exact resumable session')
    sessionId = result.sessionId
    if (options.onTurn) await options.onTurn({ ...input, sessionId })
    if (dshActiveAgentCaseClosed(options.targetId, await options.snapshot())) {
      return { closed: true, turns: turns + 1, sessionId }
    }
    if (turns + 1 < options.maxTurns && result.interrupted !== true) await options.wait(options.intervalMs)
  }
  return { closed: false, turns: options.maxTurns,
    ...(sessionId === undefined ? {} : { sessionId }) }
}
