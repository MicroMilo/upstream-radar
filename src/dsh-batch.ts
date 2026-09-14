import { createHash } from 'node:crypto'
import { applyDshHeadlessAgentPlans } from './dsh-headless-agent-plan.js'
import { applyDshEnvironmentRecommendations, applyDshEnvironmentRecommendationsToSurfaceTargets } from './dsh-environment-recommendation.js'
import { buildDshInstallPlan, currentDshCompatibilitySources, type DshInstallTargets, parseDshInstallTargets } from './dsh-install-plan.js'
import {
  emptyDshCompatibilityLedger, parseDshCompatibilityLedger, mergeDshCompatibilityLedger,
  type DshCompatibilityExpectedCase, type DshCompatibilityLedger,
} from './dsh-compatibility-ledger.js'
import { emptyDshSurfaceLedger, parseDshSurfaceLedger, expandDshSurfaceAuthorBaselines, buildDshSurfacePlan, mergeDshSurfaceLedger, type DshSurfaceExpectedCase, type DshSurfaceLedger } from './dsh-surface.js'
import { buildDshAdapterPlan, emptyDshAdapterLedger, parseDshAdapterLedger, mergeDshAdapterLedger, type DshAdapterExpectedCase, type DshAdapterLedger } from './dsh-adapter.js'

const SCHEMA = 'upstream-radar.dsh-batch-state/v1alpha1' as const
export interface DshBatchTask {
  key: string
  kind: 'native' | 'surface' | 'adapter'
  cell: DshCompatibilityExpectedCase | DshSurfaceExpectedCase | DshAdapterExpectedCase
  status: 'pending' | 'running' | 'accepted' | 'failed'
  attempts: number
  lastAttemptAt?: string
  error?: string
}
export interface DshBatchState {
  schema: typeof SCHEMA
  executorIdentity: string
  nativeLedger: DshCompatibilityLedger
  /** Historical coordinates may bind build approvals, but never count as current runtime passes. */
  buildReviewEvidence: DshCompatibilityLedger
  surfaceLedger: DshSurfaceLedger
  adapterLedger: DshAdapterLedger
  tasks: DshBatchTask[]
}
export interface DshBatchOptions {
  installTargets: unknown
  observations: unknown
  recommendations?: unknown
  buildPlans?: unknown
  surfaceTargets?: unknown
  state?: unknown
  runtime: { platform: 'linux'; architecture: 'arm64' | 'x64' }
  executorIdentity?: string
  now?: Date
  maxTasks?: number
  checkpoint: (state: DshBatchState) => Promise<void>
  /** Only an isolated executor may implement this boundary for real artifacts. */
  execute: (task: DshBatchTask) => Promise<unknown>
}

function taskKey(kind: DshBatchTask['kind'], cell: DshBatchTask['cell'], executorIdentity: string): string {
  return createHash('sha256').update(JSON.stringify({ kind, cell: { ...cell, reasons: undefined }, executorIdentity })).digest('hex')
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('batch state must be an object')
  return value as Record<string, unknown>
}
function parseState(value: unknown, executorIdentity: string): DshBatchState {
  if (value === undefined) return { schema: SCHEMA, executorIdentity, nativeLedger: emptyDshCompatibilityLedger(), buildReviewEvidence: emptyDshCompatibilityLedger(),
    surfaceLedger: emptyDshSurfaceLedger(), adapterLedger: emptyDshAdapterLedger(), tasks: [] }
  const raw = object(value)
  if (raw.schema !== SCHEMA || typeof raw.executorIdentity !== 'string' || !Array.isArray(raw.tasks) || raw.tasks.length > 2048) throw new Error('unsupported or oversized batch state')
  const tasks = raw.tasks.map(value => {
    const item = object(value)
    if (typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key) || !['native', 'surface', 'adapter'].includes(String(item.kind))
      || !['pending', 'running', 'accepted', 'failed'].includes(String(item.status))
      || !Number.isSafeInteger(item.attempts) || (item.attempts as number) < 0 || (item.attempts as number) > 1_000_000) throw new Error('invalid batch task')
    if (item.lastAttemptAt !== undefined && (typeof item.lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(item.lastAttemptAt)))) throw new Error('invalid batch attempt timestamp')
    if (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 2048)) throw new Error('invalid batch task error')
    object(item.cell)
    return structuredClone(item) as unknown as DshBatchTask
  })
  if (new Set(tasks.map(task => task.key)).size !== tasks.length) throw new Error('duplicate batch task')
  // Executor changes invalidate reuse; old report files remain separate history.
  const sameExecutor = raw.executorIdentity === executorIdentity
  const historical = parseDshCompatibilityLedger(raw.buildReviewEvidence ?? raw.nativeLedger)
  const current = parseDshCompatibilityLedger(raw.nativeLedger)
  return { schema: SCHEMA, executorIdentity,
    nativeLedger: sameExecutor ? current : emptyDshCompatibilityLedger(),
    buildReviewEvidence: parseDshCompatibilityLedger({ schema: historical.schema,
      entries: [...new Map([...historical.entries, ...current.entries].map(entry => [entry.caseId, entry])).values()] }),
    surfaceLedger: sameExecutor ? parseDshSurfaceLedger(raw.surfaceLedger) : emptyDshSurfaceLedger(),
    adapterLedger: sameExecutor ? parseDshAdapterLedger(raw.adapterLedger) : emptyDshAdapterLedger(), tasks }
}

/** Reconcile current repository intent with durable, exact isolated observations. */
export async function runDshCompatibilityBatch(options: DshBatchOptions) {
  const now = options.now ?? new Date()
  const maximum = options.maxTasks ?? 32
  const executorIdentity = options.executorIdentity ?? 'caller-supplied-isolated-executor'
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100
    || executorIdentity.length === 0 || executorIdentity.length > 512) throw new Error('invalid batch execution bounds')
  const state = parseState(options.state, executorIdentity)
  const targets: DshInstallTargets = options.recommendations === undefined
    ? parseDshInstallTargets(options.installTargets)
    : applyDshEnvironmentRecommendations(options.installTargets, options.observations, options.recommendations)
  const effectiveTargets = () => options.buildPlans === undefined ? targets : applyDshHeadlessAgentPlans(targets, options.buildPlans, {
    schema: state.buildReviewEvidence.schema,
    entries: [...new Map([...state.buildReviewEvidence.entries, ...state.nativeLedger.entries].map(entry => [entry.caseId, entry])).values()],
  })
  const planNative = () => buildDshInstallPlan(effectiveTargets(), options.observations, { changes: [] }, state.nativeLedger, now, new Set(), options.runtime)
  const configuredSurfaces = options.surfaceTargets ?? { schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [] }
  const surfaces = options.recommendations === undefined ? configuredSurfaces
    : applyDshEnvironmentRecommendationsToSurfaceTargets(configuredSurfaces, options.installTargets, options.observations, options.recommendations)
  const allNative = () => buildDshInstallPlan(effectiveTargets(), options.observations, { changes: [] }, emptyDshCompatibilityLedger(), now, new Set(), options.runtime)
  const currentNative = () => currentDshCompatibilitySources(state.nativeLedger, allNative().matrix.include, targets.refreshAfterHours, now)
  const planSurface = () => {
    return buildDshSurfacePlan(expandDshSurfaceAuthorBaselines(surfaces, allNative()), currentNative(), state.surfaceLedger, now)
  }
  const planAdapter = () => {
    const native = currentNative(), targetVersion = allNative().dshVersion
    return buildDshAdapterPlan(targets, { ...native, entries: native.entries.filter(entry => entry.dshVersion === targetVersion) }, state.adapterLedger, now)
  }
  const nativePlan = planNative()
  const surfacePlan = planSurface()
  let executed = 0
  const transitions: unknown[] = []
  const attempted = new Set<string>()
  let desiredKeys = new Set<string>()
  async function reconcile() {
    desiredKeys = new Set<string>()
    const pending: DshBatchTask[] = []
    for (const [kind, cells] of [['native', planNative().matrix.include], ['surface', planSurface().matrix.include], ['adapter', planAdapter().matrix.include]] as const) {
      for (const cell of cells) {
        const key = taskKey(kind, cell, executorIdentity)
        desiredKeys.add(key)
        const previous = state.tasks.find(task => task.key === key)
        if (attempted.has(key)) continue
        const task: DshBatchTask = { ...previous, key, kind, cell, status: previous?.status === 'running' ? 'running' : 'pending', attempts: previous?.attempts ?? 0 }
        const index = state.tasks.findIndex(task => task.key === key)
        if (index === -1) state.tasks.push(task)
        else state.tasks[index] = task
        pending.push(task)
      }
    }
    // Retain every live handle, and only the newest accepted history per case.
    const newest = new Map(state.tasks.filter(task => task.status === 'accepted').map(task => [`${task.kind}:${task.cell.id}`, task.key]))
    state.tasks = state.tasks.filter(task => desiredKeys.has(task.key) || attempted.has(task.key) || task.status === 'running'
      || newest.get(`${task.kind}:${task.cell.id}`) === task.key)
    if (state.tasks.length > 2048) throw new Error('batch state exceeded its bounded task inventory')
    await options.checkpoint(structuredClone(state))
    return pending.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')
      || a.attempts - b.attempts || (a.lastAttemptAt ?? '').localeCompare(b.lastAttemptAt ?? '') || a.cell.id.localeCompare(b.cell.id))
  }
  while (true) {
    const pending = await reconcile()
    const task = pending[0]
    if (task === undefined || executed >= maximum) break
    attempted.add(task.key)
    const resuming = task.status === 'running'
    task.status = 'running'
    if (!resuming) task.attempts += 1
    task.lastAttemptAt = now.toISOString()
    delete task.error
    await options.checkpoint(structuredClone(state))
    executed += 1
    try {
      const report = await options.execute(structuredClone(task))
      if (task.kind === 'native') {
        const merged = mergeDshCompatibilityLedger({ ledger: state.nativeLedger,
          expected: [task.cell as DshCompatibilityExpectedCase], reports: [report] })
        if (merged.acceptedCaseIds.length !== 1) throw new Error(merged.rejectedReports.join('; ') || 'isolated report did not satisfy the scheduled case')
        state.nativeLedger = merged.ledger
        state.buildReviewEvidence = parseDshCompatibilityLedger({ schema: state.buildReviewEvidence.schema,
          entries: [...new Map([...state.buildReviewEvidence.entries, ...merged.ledger.entries].map(entry => [entry.caseId, entry])).values()] })
        transitions.push(...merged.transitions)
      } else if (task.kind === 'surface') {
        const merged = mergeDshSurfaceLedger({ ledger: state.surfaceLedger,
          expected: [task.cell as DshSurfaceExpectedCase], reports: [report] })
        if (merged.acceptedCaseIds.length !== 1) throw new Error(merged.rejectedReports.join('; ') || 'isolated profile report did not satisfy the scheduled case')
        state.surfaceLedger = merged.ledger
        transitions.push(...merged.transitions)
      } else {
        const merged = mergeDshAdapterLedger(state.adapterLedger, task.cell as DshAdapterExpectedCase, report)
        state.adapterLedger = merged.ledger
        transitions.push(...merged.transitions)
      }
      task.status = 'accepted'
    } catch (error) {
      task.status = 'failed'
      task.error = String(error instanceof Error ? error.message : error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2048)
    }
    await options.checkpoint(structuredClone(state))
  }
  return { state, executed, nativePlan, surfacePlan, nextNativePlan: planNative(), nextSurfacePlan: planSurface(), nextAdapterPlan: planAdapter(), transitions,
    orphanedRunningTasks: state.tasks.filter(task => task.status === 'running' && !desiredKeys.has(task.key)).map(task => task.key) }
}
