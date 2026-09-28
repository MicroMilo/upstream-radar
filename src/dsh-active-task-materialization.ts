import { parseDshActiveTaskState, type DshActiveTask, type DshActiveTaskCoordinate } from './dsh-active-task-state.js'
import { parseDshInstallTargets, type DshInstallTarget, type DshInstallTargets } from './dsh-install-plan.js'

const DSH_TARGET_ID = 'deepseek-harness'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CLEAN_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/?)(?!.*\\)[^\u0000-\u001f\u007f]+$/

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be bounded text`)
  return value
}

export interface DshActiveTaskSourceDescriptor {
  repository: string
  ref?: string
  packagePath: string
  lockfile?: string
}

export interface DshActiveTaskMaterializationPlan {
  task: DshActiveTask
  targets: DshInstallTargets
  pluginTarget: DshInstallTarget
  pluginObserverTargetId: string
  pluginSource: DshActiveTaskSourceDescriptor
  dshSource: DshActiveTaskSourceDescriptor
  pluginDistTag: string
}

export interface DshActiveTaskExactEvidence {
  plugin: { sourceManifest: unknown; publishedManifest: unknown }
  dsh: { sourceManifest: unknown; publishedManifest: unknown }
}

function sourceDescriptor(value: unknown, label: string): DshActiveTaskSourceDescriptor {
  const source = record(record(value, label).source, `${label}.source`)
  const repository = text(source.repository, `${label}.source.repository`, 256)
  const packagePath = text(source.packagePath, `${label}.source.packagePath`, 512)
  if (!REPOSITORY.test(repository) || !CLEAN_PATH.test(packagePath)) {
    throw new Error(`${label} has an unsafe repository or package path`)
  }
  const ref = source.ref === undefined ? undefined : text(source.ref, `${label}.source.ref`, 256)
  const lockfile = source.lockfile === undefined ? undefined : text(source.lockfile, `${label}.source.lockfile`, 512)
  if (lockfile !== undefined && !CLEAN_PATH.test(lockfile)) throw new Error(`${label} has an unsafe lockfile path`)
  return { repository, ...(ref === undefined ? {} : { ref }), packagePath,
    ...(lockfile === undefined ? {} : { lockfile }) }
}

export function planDshActiveTaskMaterialization(stateInput: unknown, targetsInput: unknown,
  observationsInput: unknown, taskId: string, inputFingerprint: string): DshActiveTaskMaterializationPlan {
  const state = parseDshActiveTaskState(stateInput)
  const task = state.tasks.find(item => item.id === taskId && item.inputFingerprint === inputFingerprint)
  if (task === undefined || task.status !== 'pending') throw new Error('the selected active task is not pending in durable state')
  const targets = parseDshInstallTargets(targetsInput)
  const pluginTarget = targets.plugins.find(item => item.id === task.targetId)
  if (pluginTarget?.observerTargetId === undefined) throw new Error('the active task has no configured observer target')
  const observations = record(observationsInput, 'current observations')
  const observedTargets = record(observations.targets, 'current observations.targets')
  const pluginTemplate = observedTargets[pluginTarget.observerTargetId]
  const dshTemplate = observedTargets[DSH_TARGET_ID]
  const pluginPackage = record(record(pluginTemplate, 'plugin observation template').package,
    'plugin observation template.package')
  const pluginDistTag = text(pluginPackage.distTag, 'plugin observation template.package.distTag', 128)
  return {
    task, targets, pluginTarget, pluginObserverTargetId: pluginTarget.observerTargetId,
    pluginSource: sourceDescriptor(pluginTemplate, 'plugin observation template'),
    dshSource: sourceDescriptor(dshTemplate, 'DSH observation template'),
    pluginDistTag,
  }
}

function exactPackage(coordinate: DshActiveTaskCoordinate, publishedInput: unknown,
  selection: { distTag: string } | { versionSelector: string }, label: string): Record<string, unknown> {
  const published = record(publishedInput, `${label} registry manifest`)
  const name = text(published.name, `${label} registry manifest.name`, 214)
  const version = text(published.version, `${label} registry manifest.version`, 128)
  const dist = record(published.dist, `${label} registry manifest.dist`)
  const integrity = text(dist.integrity, `${label} registry manifest.dist.integrity`, 512)
  const tarball = text(dist.tarball, `${label} registry manifest.dist.tarball`, 2_048)
  if (name !== coordinate.name || version !== coordinate.version
    || (coordinate.integrity !== undefined && integrity !== coordinate.integrity)
    || !tarball.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`${label} registry evidence does not match the persisted exact coordinate`)
  }
  const repository = published.repository
  const repositoryUrl = typeof repository === 'string' ? repository
    : typeof repository === 'object' && repository !== null && !Array.isArray(repository)
      && typeof (repository as Record<string, unknown>).url === 'string'
      ? (repository as Record<string, unknown>).url as string : undefined
  return { name, version, ...selection, integrity, tarball,
    ...(repositoryUrl === undefined ? {} : { repository: repositoryUrl }),
    manifest: structuredClone(published) }
}

function exactSource(descriptor: DshActiveTaskSourceDescriptor, commit: string): Record<string, unknown> {
  const rawBase = `https://raw.githubusercontent.com/${descriptor.repository}/${commit}`
  return {
    repository: descriptor.repository,
    ...(descriptor.ref === undefined ? {} : { ref: descriptor.ref }),
    commit,
    packagePath: descriptor.packagePath,
    ...(descriptor.lockfile === undefined ? {} : { lockfile: descriptor.lockfile }),
    commitUrl: `https://github.com/${descriptor.repository}/commit/${commit}`,
    packageUrl: `${rawBase}/${descriptor.packagePath}`,
    ...(descriptor.lockfile === undefined ? {} : { lockfileUrl: `${rawBase}/${descriptor.lockfile}` }),
  }
}

function sourceManifest(value: unknown, label: string): Record<string, unknown> {
  const manifest = record(value, `${label} source manifest`)
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${label} source manifest lacks package identity`)
  }
  return structuredClone(manifest)
}

export function materializeDshActiveTaskInputs(plan: DshActiveTaskMaterializationPlan,
  evidence: DshActiveTaskExactEvidence, at = new Date()): { observations: unknown; targets: DshInstallTargets } {
  if (!Number.isFinite(at.getTime())) throw new Error('materialization time must be valid')
  const pluginManifest = sourceManifest(evidence.plugin.sourceManifest, 'plugin')
  const dshManifest = sourceManifest(evidence.dsh.sourceManifest, 'DSH')
  const pluginPackage = exactPackage(plan.task.input.plugin, evidence.plugin.publishedManifest,
    plan.task.input.policy?.pluginVersion === plan.task.input.plugin.version
      ? { versionSelector: plan.task.input.plugin.version }
      : { distTag: plan.pluginDistTag }, 'plugin')
  const dshPackage = exactPackage(plan.task.input.dsh, evidence.dsh.publishedManifest,
    plan.task.dshChannel === `exact-${plan.task.input.dsh.version}`
      ? { versionSelector: plan.task.input.dsh.version }
      : { distTag: plan.task.dshChannel }, 'DSH')
  const observedAt = at.toISOString()
  const observations = {
    schema: 'upstream-radar.observation-state/v1alpha1',
    pendingTasks: [],
    targets: {
      [DSH_TARGET_ID]: { targetId: DSH_TARGET_ID, ecosystem: 'dsh', observedAt,
        source: exactSource(plan.dshSource, plan.task.input.dsh.sourceCommit),
        manifest: dshManifest, package: dshPackage },
      [plan.pluginObserverTargetId]: { targetId: plan.pluginObserverTargetId, ecosystem: 'dsh', observedAt,
        source: exactSource(plan.pluginSource, plan.task.input.plugin.sourceCommit),
        manifest: pluginManifest, package: pluginPackage },
    },
  }
  const scopedTarget: DshInstallTarget = {
    id: plan.pluginTarget.id,
    spec: `${plan.task.input.plugin.name}@${plan.task.input.plugin.version}`,
    reason: plan.pluginTarget.reason,
    observerTargetId: plan.pluginObserverTargetId,
    ...(plan.task.input.policy === undefined ? {} : { analysisPolicy: structuredClone(plan.task.input.policy) }),
  }
  const targets = parseDshInstallTargets({ ...plan.targets, plugins: [scopedTarget] })
  return { observations, targets }
}
