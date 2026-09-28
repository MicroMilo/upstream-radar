import { createHash } from 'node:crypto'

export const DSH_ACTIVE_TASK_STATE_SCHEMA = 'upstream-radar.dsh-active-task-state/v1alpha1' as const

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const TARGET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_TASKS = 256
const MAX_ATTEMPTS_PER_PLAN = 8

export interface DshActiveTaskCoordinate {
  name: string
  version: string
  integrity?: string
  sourceCommit: string
}

export interface DshActiveTask {
  id: string
  inputFingerprint: string
  targetId: string
  dshChannel: string
  trigger: {
    kind: 'plugin' | 'dsh'
    observerTargetId: string
    beforeCommit: string
    afterCommit: string
    beforeVersion?: string
    afterVersion?: string
  }
  input: {
    plugin: DshActiveTaskCoordinate
    dsh: DshActiveTaskCoordinate
  }
  status: 'pending' | 'completed' | 'superseded'
  createdAt: string
  attempts: number
  lastAttemptAt?: string
  lastRunId?: string
  lastFailure?: string
  completedAt?: string
  reportPath?: string
  evidenceDigest?: string
}

export interface DshActiveTaskState {
  schema: typeof DSH_ACTIVE_TASK_STATE_SCHEMA
  updatedAt: string
  tasks: DshActiveTask[]
}

export interface DshActiveTaskMatrixEntry {
  targetId: string
  dshChannel: string
  taskId: string
  inputFingerprint: string
}

export interface DshActiveTaskMatrix {
  include: DshActiveTaskMatrixEntry[]
}

export interface DshActiveTaskResult {
  taskId: string
  inputFingerprint: string
  status: 'completed' | 'retryable'
  reportPath?: string
  evidenceDigest?: string
  error?: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be bounded text`)
  return value
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64)
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be an ISO timestamp`)
  return parsed
}

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function packageCoordinate(value: unknown, sourceInput: unknown, label: string): DshActiveTaskCoordinate {
  const item = record(value, `${label}.package`)
  const source = record(sourceInput, `${label}.source`)
  const name = text(item.name, `${label}.package.name`, 214)
  const version = text(item.version, `${label}.package.version`, 128)
  const sourceCommit = text(source.commit, `${label}.source.commit`, 128)
  if (!EXACT_VERSION.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error(`${label} must have an exact package version and source commit`)
  }
  const integrity = item.integrity === undefined ? undefined : text(item.integrity, `${label}.package.integrity`, 512)
  return { name, version, ...(integrity === undefined ? {} : { integrity }), sourceCommit }
}

function parseTask(value: unknown, index: number): DshActiveTask {
  const item = record(value, `tasks[${index}]`)
  const id = text(item.id, `tasks[${index}].id`, 64)
  const inputFingerprint = text(item.inputFingerprint, `tasks[${index}].inputFingerprint`, 71)
  const targetId = text(item.targetId, `tasks[${index}].targetId`, 64)
  const dshChannel = text(item.dshChannel, `tasks[${index}].dshChannel`, 128)
  if (!TARGET_ID.test(targetId) || !FINGERPRINT.test(inputFingerprint)) throw new Error('active task has invalid identity')
  if (!['pending', 'completed', 'superseded'].includes(String(item.status))) throw new Error('active task has invalid status')
  if (!Number.isSafeInteger(item.attempts) || (item.attempts as number) < 0 || (item.attempts as number) > 10_000) {
    throw new Error('active task has invalid attempt count')
  }
  const trigger = record(item.trigger, `tasks[${index}].trigger`)
  const input = record(item.input, `tasks[${index}].input`)
  const plugin = record(input.plugin, `tasks[${index}].input.plugin`) as unknown as DshActiveTaskCoordinate
  const dsh = record(input.dsh, `tasks[${index}].input.dsh`) as unknown as DshActiveTaskCoordinate
  // Reuse the exact coordinate validator by presenting its package/source split.
  const parsedPlugin = packageCoordinate(plugin, { commit: plugin.sourceCommit }, `tasks[${index}].input.plugin`)
  const parsedDsh = packageCoordinate(dsh, { commit: dsh.sourceCommit }, `tasks[${index}].input.dsh`)
  const optional = (name: string, maximum = 1_024): string | undefined => item[name] === undefined
    ? undefined : text(item[name], `tasks[${index}].${name}`, maximum)
  const lastRunId = optional('lastRunId', 128)
  const lastFailure = optional('lastFailure')
  const reportPath = optional('reportPath', 512)
  const evidenceDigest = optional('evidenceDigest', 71)
  const kind = trigger.kind
  if (kind !== 'plugin' && kind !== 'dsh') throw new Error('active task has invalid trigger kind')
  const parsed: DshActiveTask = {
    id,
    inputFingerprint,
    targetId,
    dshChannel,
    trigger: {
      kind,
      observerTargetId: text(trigger.observerTargetId, `tasks[${index}].trigger.observerTargetId`, 128),
      beforeCommit: text(trigger.beforeCommit, `tasks[${index}].trigger.beforeCommit`, 128),
      afterCommit: text(trigger.afterCommit, `tasks[${index}].trigger.afterCommit`, 128),
      ...(trigger.beforeVersion === undefined ? {} : { beforeVersion: text(trigger.beforeVersion, `tasks[${index}].trigger.beforeVersion`, 128) }),
      ...(trigger.afterVersion === undefined ? {} : { afterVersion: text(trigger.afterVersion, `tasks[${index}].trigger.afterVersion`, 128) }),
    },
    input: { plugin: parsedPlugin, dsh: parsedDsh },
    status: item.status as DshActiveTask['status'],
    createdAt: timestamp(item.createdAt, `tasks[${index}].createdAt`),
    attempts: item.attempts as number,
    ...(item.lastAttemptAt === undefined ? {} : { lastAttemptAt: timestamp(item.lastAttemptAt, `tasks[${index}].lastAttemptAt`) }),
    ...(lastRunId === undefined ? {} : { lastRunId }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(item.completedAt === undefined ? {} : { completedAt: timestamp(item.completedAt, `tasks[${index}].completedAt`) }),
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
  }
  if (parsed.evidenceDigest !== undefined && !FINGERPRINT.test(parsed.evidenceDigest)) throw new Error('active task has invalid evidence digest')
  return parsed
}

export function emptyDshActiveTaskState(at = new Date(0)): DshActiveTaskState {
  return { schema: DSH_ACTIVE_TASK_STATE_SCHEMA, updatedAt: at.toISOString(), tasks: [] }
}

export function parseDshActiveTaskState(value: unknown): DshActiveTaskState {
  if (value === undefined || value === null) return emptyDshActiveTaskState()
  const state = record(value, 'active task state')
  if (state.schema !== DSH_ACTIVE_TASK_STATE_SCHEMA || !Array.isArray(state.tasks) || state.tasks.length > MAX_TASKS) {
    throw new Error('invalid active task state')
  }
  const tasks = state.tasks.map(parseTask)
  if (new Set(tasks.map(task => task.id)).size !== tasks.length
    || new Set(tasks.map(task => task.inputFingerprint)).size !== tasks.length) throw new Error('active task identities must be unique')
  return { schema: DSH_ACTIVE_TASK_STATE_SCHEMA, updatedAt: timestamp(state.updatedAt, 'active task state updatedAt'), tasks }
}

function currentInputs(targetsInput: unknown, observationsInput: unknown): Array<{
  targetId: string
  observerTargetId: string
  dshChannel: string
  input: DshActiveTask['input']
  inputFingerprint: string
}> {
  const targets = record(targetsInput, 'active cohort')
  if (!Array.isArray(targets.plugins) || targets.plugins.length > 100) throw new Error('active cohort must contain bounded plugins')
  const observations = record(observationsInput, 'observations')
  const observedTargets = record(observations.targets, 'observations.targets')
  const dshObserved = record(observedTargets['deepseek-harness'], 'observations.targets.deepseek-harness')
  const dsh = packageCoordinate(dshObserved.package, dshObserved.source, 'DSH observation')
  const dshPackage = record(dshObserved.package, 'DSH observation.package')
  const dshChannel = text(dshPackage.distTag, 'DSH observation.package.distTag', 128)
  return targets.plugins.map((raw, index) => {
    const target = record(raw, `active cohort plugins[${index}]`)
    const targetId = text(target.id, `active cohort plugins[${index}].id`, 64)
    const observerTargetId = text(target.observerTargetId, `active cohort plugins[${index}].observerTargetId`, 128)
    if (!TARGET_ID.test(targetId)) throw new Error('active cohort contains an invalid target id')
    const observed = record(observedTargets[observerTargetId], `observations.targets.${observerTargetId}`)
    const plugin = packageCoordinate(observed.package, observed.source, `${targetId} observation`)
    const input = { plugin, dsh }
    const inputFingerprint = sha(JSON.stringify({ targetId, dshChannel, input }))
    return { targetId, observerTargetId, dshChannel, input, inputFingerprint }
  }).sort((left, right) => left.targetId.localeCompare(right.targetId))
}

function changeTrigger(value: unknown): DshActiveTask['trigger'] | undefined {
  const change = record(value, 'observer change')
  if (change.meaningful !== true) return undefined
  const observerTargetId = text(change.targetId, 'observer change targetId', 128)
  const source = record(change.source, 'observer change source')
  const previous = record(change.previous, 'observer change previous')
  const current = record(change.current, 'observer change current')
  const previousManifest = record(previous.manifest, 'observer change previous manifest')
  const currentManifest = record(current.manifest, 'observer change current manifest')
  const beforeVersion = typeof previousManifest.version === 'string' ? previousManifest.version : undefined
  const afterVersion = typeof currentManifest.version === 'string' ? currentManifest.version : undefined
  return {
    kind: observerTargetId === 'deepseek-harness' ? 'dsh' : 'plugin',
    observerTargetId,
    beforeCommit: text(source.beforeCommit, 'observer change beforeCommit', 128),
    afterCommit: text(source.afterCommit, 'observer change afterCommit', 128),
    ...(beforeVersion === undefined ? {} : { beforeVersion: text(beforeVersion, 'observer change beforeVersion', 128) }),
    ...(afterVersion === undefined ? {} : { afterVersion: text(afterVersion, 'observer change afterVersion', 128) }),
  }
}

export function planDshActiveTasks(targetsInput: unknown, observationsInput: unknown, reportInput: unknown,
  stateInput: unknown, now = new Date(), maximum = MAX_ATTEMPTS_PER_PLAN): {
    state: DshActiveTaskState
    matrix: DshActiveTaskMatrix
    created: number
    deduplicated: number
    blocked: string[]
  } {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ATTEMPTS_PER_PLAN) throw new Error('invalid active task dispatch bound')
  const at = now.toISOString()
  const previous = parseDshActiveTaskState(stateInput)
  const inputs = currentInputs(targetsInput, observationsInput)
  const byObserver = new Map(inputs.map(item => [item.observerTargetId, item]))
  const currentByTarget = new Map(inputs.map(item => [`${item.targetId}:${item.dshChannel}`, item]))
  const report = record(reportInput, 'observer report')
  if (!Array.isArray(report.changes) || report.changes.length > 500) throw new Error('observer report must contain bounded changes')
  const tasks = previous.tasks.map(task => ({ ...task, trigger: { ...task.trigger }, input: {
    plugin: { ...task.input.plugin }, dsh: { ...task.input.dsh },
  } }))
  let changed = false
  for (const task of tasks) {
    if (task.status !== 'pending') continue
    const current = currentByTarget.get(`${task.targetId}:${task.dshChannel}`)
    if (current === undefined || current.inputFingerprint !== task.inputFingerprint) {
      task.status = 'superseded'
      changed = true
    }
  }
  const byFingerprint = new Map(tasks.map(task => [task.inputFingerprint, task]))
  let created = 0, deduplicated = 0
  const blocked: string[] = []
  for (const rawChange of report.changes) {
    const trigger = changeTrigger(rawChange)
    if (trigger === undefined) continue
    const affected = trigger.kind === 'dsh' ? inputs : [byObserver.get(trigger.observerTargetId)].filter(item => item !== undefined)
    if (affected.length === 0) {
      blocked.push(`No configured active plugin maps to ${trigger.observerTargetId}.`)
      continue
    }
    for (const exact of affected) {
      const existing = byFingerprint.get(exact.inputFingerprint)
      if (existing !== undefined) {
        if (existing.status === 'completed') deduplicated += 1
        continue
      }
      const id = `active-${exact.inputFingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`
      const task: DshActiveTask = { id, inputFingerprint: exact.inputFingerprint,
        targetId: exact.targetId, dshChannel: exact.dshChannel, trigger, input: exact.input,
        status: 'pending', createdAt: at, attempts: 0 }
      tasks.push(task)
      byFingerprint.set(task.inputFingerprint, task)
      created += 1
      changed = true
    }
  }
  const selected = tasks.filter(task => task.status === 'pending')
    .sort((left, right) => left.attempts - right.attempts
      || (left.lastAttemptAt ?? left.createdAt).localeCompare(right.lastAttemptAt ?? right.createdAt)
      || left.targetId.localeCompare(right.targetId)).slice(0, maximum)
  for (const task of selected) {
    task.attempts += 1
    task.lastAttemptAt = at
    changed = true
  }
  const retained = tasks.length <= MAX_TASKS ? tasks : [
    ...tasks.filter(task => task.status === 'pending'),
    ...tasks.filter(task => task.status !== 'pending').sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  ].slice(0, MAX_TASKS)
  const state: DshActiveTaskState = { schema: DSH_ACTIVE_TASK_STATE_SCHEMA,
    updatedAt: changed ? at : previous.updatedAt,
    tasks: retained.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)) }
  return { state, matrix: { include: selected.map(task => ({ targetId: task.targetId,
    dshChannel: task.dshChannel, taskId: task.id, inputFingerprint: task.inputFingerprint })) },
  created, deduplicated, blocked: blocked.slice(0, 32) }
}

export function reconcileDshActiveTaskResults(stateInput: unknown, matrixInput: unknown,
  resultsInput: readonly DshActiveTaskResult[], now = new Date(), runId: string): DshActiveTaskState {
  const previous = parseDshActiveTaskState(stateInput)
  const matrix = record(matrixInput, 'active task matrix')
  if (!Array.isArray(matrix.include) || matrix.include.length > MAX_ATTEMPTS_PER_PLAN) throw new Error('invalid active task matrix')
  const at = now.toISOString()
  const safeRunId = text(runId, 'active task run id', 128)
  const results = new Map(resultsInput.map(result => [`${result.taskId}:${result.inputFingerprint}`, result]))
  const scheduled = new Set(matrix.include.map((raw, index) => {
    const entry = record(raw, `active task matrix include[${index}]`)
    const taskId = text(entry.taskId, `active task matrix include[${index}].taskId`, 64)
    const inputFingerprint = text(entry.inputFingerprint, `active task matrix include[${index}].inputFingerprint`, 71)
    if (!FINGERPRINT.test(inputFingerprint)) throw new Error('matrix contains invalid active task fingerprint')
    return `${taskId}:${inputFingerprint}`
  }))
  const tasks = previous.tasks.map(task => {
    const key = `${task.id}:${task.inputFingerprint}`
    if (!scheduled.has(key) || task.status !== 'pending') return task
    const result = results.get(key)
    if (result?.status === 'completed') {
      if (result.reportPath === undefined || result.evidenceDigest === undefined
        || !FINGERPRINT.test(result.evidenceDigest)) throw new Error('completed active task lacks exact report evidence')
      const { lastFailure: _lastFailure, ...withoutFailure } = task
      return { ...withoutFailure, status: 'completed' as const, completedAt: at, lastRunId: safeRunId,
        reportPath: text(result.reportPath, 'active task report path', 512), evidenceDigest: result.evidenceDigest,
      }
    }
    return { ...task, lastRunId: safeRunId,
      lastFailure: text(result?.error ?? 'result artifact was not produced', 'active task retry reason', 1_024) }
  })
  return { schema: DSH_ACTIVE_TASK_STATE_SCHEMA, updatedAt: at, tasks }
}
