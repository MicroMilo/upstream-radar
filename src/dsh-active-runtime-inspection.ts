import type { DshLiveProgress } from './dsh-live-progress.js'

const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TASK_KEY = /^[a-f0-9]{64}$/
const MAX_SIGNALS = 32
const MAX_EVENTS = 8192

export interface DshActiveLiveProgressSignal {
  caseId: string
  phase: DshLiveProgress['phase']
  kind: DshLiveProgress['kind']
  observedAt: string
  elapsedMs: number
  stdoutBytes: number
  stderrBytes: number
  outputIdleMs: number
  heartbeatAgeMs: number
  signalTrust: 'untrusted-worker-stderr-hint'
}

/** This is a model-visible hint, never proof of an install failure or a reason to kill a worker. */
export function summarizeDshActiveLiveProgress(
  events: readonly DshLiveProgress[], runningCaseIds: readonly string[], observedAt: string,
): DshActiveLiveProgressSignal[] {
  if (runningCaseIds.length > MAX_SIGNALS || runningCaseIds.some(id => !CASE_ID.test(id))
    || !Number.isFinite(Date.parse(observedAt))) throw new Error('active progress requires bounded exact running cases and broker time')
  const now = Date.parse(observedAt), scoped = new Set(runningCaseIds)
  const current = new Map<string, { latest: DshLiveProgress; outputAt: number; outputBytes: number }>()
  for (const event of events.slice(-MAX_EVENTS).sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    if (!scoped.has(event.caseId) || !Number.isFinite(Date.parse(event.observedAt))) continue
    const prior = current.get(event.caseId)
    const bytes = event.stdoutBytes + event.stderrBytes
    const at = Date.parse(event.observedAt)
    const outputAt = prior === undefined || prior.latest.phase !== event.phase || bytes > prior.outputBytes
      ? at : prior.outputAt
    current.set(event.caseId, { latest: event, outputAt, outputBytes: bytes })
  }
  return [...current.values()].map(({ latest, outputAt }) => ({
    caseId: latest.caseId, phase: latest.phase, kind: latest.kind,
    observedAt: latest.observedAt, elapsedMs: latest.elapsedMs,
    stdoutBytes: latest.stdoutBytes, stderrBytes: latest.stderrBytes,
    outputIdleMs: Math.max(0, Math.min(3_600_000, now - outputAt)),
    heartbeatAgeMs: Math.max(0, Math.min(3_600_000, now - Date.parse(latest.observedAt))),
    signalTrust: 'untrusted-worker-stderr-hint' as const,
  })).sort((a, b) => a.caseId.localeCompare(b.caseId))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not exact owned state`)
  return value as Record<string, unknown>
}

export interface DshActiveOwnedContainerState {
  caseId: string
  taskKey: string
  containerName: string
  status: string
  running: boolean
  oomKilled: boolean
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  trust: 'docker-exact-owned-container-state'
}

/** Verify the handle against durable scoped task state before exposing any Docker runtime fact. */
export function inspectDshActiveRunningContainer(
  taskInput: unknown, containerName: string, containerInput: unknown, targetId: string,
): DshActiveOwnedContainerState {
  const task = record(taskInput, 'task'), cell = record(task.cell, 'task cell')
  const key = task.key, attempts = task.attempts
  if (!CASE_ID.test(targetId) || typeof key !== 'string' || !TASK_KEY.test(key)
    || !Number.isSafeInteger(attempts) || (attempts as number) < 0 || (attempts as number) > 1_000
    || task.status !== 'running' || cell.targetId !== targetId
    || typeof cell.id !== 'string' || !CASE_ID.test(cell.id)
    || containerName !== `radar-batch-${key.slice(0, 24)}-${attempts}`) {
    throw new Error('running container is not the exact scoped task handle')
  }
  const container = record(containerInput, 'container'), config = record(container.Config, 'container Config')
  const labels = record(config.Labels, 'container labels'), host = record(container.HostConfig, 'container HostConfig')
  const state = record(container.State, 'container State')
  if (container.Name !== `/${containerName}` || labels['upstream-radar.task'] !== key
    || config.User !== '10001:10001' || !Array.isArray(container.Mounts) || container.Mounts.length !== 0
    || host.Privileged !== false || host.ReadonlyRootfs !== true || host.NetworkMode === 'host'
    || typeof host.NetworkMode !== 'string') {
    throw new Error('running container ownership or isolation checks failed')
  }
  if (!['created', 'running', 'exited', 'dead'].includes(String(state.Status))
    || typeof state.Running !== 'boolean' || typeof state.OOMKilled !== 'boolean'
    || state.Running !== (state.Status === 'running')) throw new Error('running container has inconsistent Docker state')
  const startedAt = typeof state.StartedAt === 'string' && Number.isFinite(Date.parse(state.StartedAt))
    ? state.StartedAt : undefined
  const finishedAt = typeof state.FinishedAt === 'string' && Number.isFinite(Date.parse(state.FinishedAt))
    ? state.FinishedAt : undefined
  if (state.Running && startedAt === undefined) throw new Error('running container lacks an exact Docker start time')
  const exitCode = Number.isSafeInteger(state.ExitCode) && (state.ExitCode as number) >= 0
    && (state.ExitCode as number) <= 255 ? state.ExitCode as number : undefined
  return { caseId: cell.id, taskKey: key, containerName, status: state.Status as string,
    running: state.Running, oomKilled: state.OOMKilled,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined || state.Running ? {} : { finishedAt }),
    ...(exitCode === undefined || state.Running ? {} : { exitCode }),
    trust: 'docker-exact-owned-container-state' }
}
