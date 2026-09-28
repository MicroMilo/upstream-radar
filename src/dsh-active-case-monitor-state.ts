export const DSH_ACTIVE_CASE_MONITOR_SCHEMA = 'upstream-radar.dsh-active-case-monitor/v1alpha1' as const

export interface DshActiveCaseMonitorState {
  schema: typeof DSH_ACTIVE_CASE_MONITOR_SCHEMA
  targetId: string
  launchId?: string
  launchStartedAt?: string
  lastRunningWatchAt?: string
  maxRunningWatchGapMs?: number
  runningWatches: number
  runningEvents: number
}

const LAUNCH_ID = /^[a-f0-9]{32}$/
const TARGET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const validTime = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 64 && Number.isFinite(Date.parse(value))

export function createDshActiveCaseMonitorState(targetId: string): DshActiveCaseMonitorState {
  if (!TARGET_ID.test(targetId)) throw new Error('invalid exact active-case monitor target')
  return { schema: DSH_ACTIVE_CASE_MONITOR_SCHEMA, targetId, runningWatches: 0, runningEvents: 0 }
}

export function parseDshActiveCaseMonitorState(value: unknown, targetId: string): DshActiveCaseMonitorState {
  if (value === undefined) return createDshActiveCaseMonitorState(targetId)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid active-case monitor state')
  const state = value as Record<string, unknown>
  if (state.schema !== DSH_ACTIVE_CASE_MONITOR_SCHEMA || state.targetId !== targetId
    || (state.launchId !== undefined && (typeof state.launchId !== 'string' || !LAUNCH_ID.test(state.launchId)))
    || (state.launchStartedAt !== undefined && !validTime(state.launchStartedAt))
    || (state.lastRunningWatchAt !== undefined && !validTime(state.lastRunningWatchAt))
    || (state.maxRunningWatchGapMs !== undefined && (!Number.isSafeInteger(state.maxRunningWatchGapMs)
      || (state.maxRunningWatchGapMs as number) < 0))
    || !Number.isSafeInteger(state.runningWatches) || (state.runningWatches as number) < 0
    || !Number.isSafeInteger(state.runningEvents) || (state.runningEvents as number) < 0) {
    throw new Error('active-case monitor state does not match the exact target and launch contract')
  }
  return state as unknown as DshActiveCaseMonitorState
}

/** Only the broker can call this using its validated action and own response. */
export function recordDshActiveCaseMonitorAction(
  state: DshActiveCaseMonitorState, action: string, response: unknown, observedAt = new Date().toISOString(),
): DshActiveCaseMonitorState {
  if (!validTime(observedAt)) throw new Error('invalid broker-owned active-case observation time')
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return state
  const value = response as Record<string, unknown>
  if (action === 'launch' && value.started === true && typeof value.launchId === 'string'
    && LAUNCH_ID.test(value.launchId)) {
    return { schema: state.schema, targetId: state.targetId, launchId: value.launchId,
      launchStartedAt: observedAt, maxRunningWatchGapMs: 0, runningWatches: 0, runningEvents: 0 }
  }
  if (action !== 'watch' || state.launchId === undefined || value.status !== 'running'
    || value.launchId !== state.launchId || !Array.isArray(value.events) || value.events.length > 16) return state
  const prior = state.lastRunningWatchAt ?? state.launchStartedAt
  if (!validTime(prior) || Date.parse(observedAt) < Date.parse(prior)) return state
  const gap = Date.parse(observedAt) - Date.parse(prior)
  return { ...state, runningWatches: Math.min(2_000, state.runningWatches + 1),
    runningEvents: Math.min(32_000, state.runningEvents + value.events.length),
    lastRunningWatchAt: observedAt,
    maxRunningWatchGapMs: Math.max(state.maxRunningWatchGapMs ?? 0, gap) }
}

/** A single early event in a long run does not prove continuous model observation. */
export function dshActiveCaseMonitorCovered(
  state: DshActiveCaseMonitorState, launchId: string, finishedAt: string, maxAllowedGapMs: number,
): boolean {
  if (!LAUNCH_ID.test(launchId) || state.launchId !== launchId
    || !validTime(state.launchStartedAt) || !validTime(state.lastRunningWatchAt)
    || !validTime(finishedAt) || !Number.isSafeInteger(maxAllowedGapMs)
    || maxAllowedGapMs < 1_000 || maxAllowedGapMs > 120_000
    || state.runningWatches < 1 || state.runningEvents < 1
    || !Number.isSafeInteger(state.maxRunningWatchGapMs)) return false
  const start = Date.parse(state.launchStartedAt), last = Date.parse(state.lastRunningWatchAt)
  const finish = Date.parse(finishedAt)
  return start <= last && last <= finish && (state.maxRunningWatchGapMs ?? Infinity) <= maxAllowedGapMs
    && finish - last <= maxAllowedGapMs
}
