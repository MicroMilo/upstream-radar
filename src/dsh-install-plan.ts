import { parseNpmSpec } from './npm.js'

export const DSH_INSTALL_TARGETS_SCHEMA = 'upstream-radar.dsh-install-targets/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DSH_TARGET_ID = 'deepseek-harness'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const MAX_TARGETS = 50

export interface DshInstallTarget {
  id: string
  spec: string
  reason: string
  observerTargetId?: string
  allowedBuilds?: string[]
}

export interface DshInstallTargets {
  schema: typeof DSH_INSTALL_TARGETS_SCHEMA
  plugins: DshInstallTarget[]
}

export interface DshInstallPlan {
  run: boolean
  dshVersion?: string
  matrix: {
    include: Array<{ id: string; plugin: string; allowedBuilds: string }>
  }
  triggers: string[]
  reason: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

export function parseDshInstallTargets(input: unknown): DshInstallTargets {
  const root = record(input, 'DSH install targets')
  if (root.schema !== DSH_INSTALL_TARGETS_SCHEMA) throw new Error(`DSH install targets schema must be ${DSH_INSTALL_TARGETS_SCHEMA}`)
  if (!Array.isArray(root.plugins) || root.plugins.length === 0 || root.plugins.length > MAX_TARGETS) {
    throw new Error(`DSH install targets must contain between 1 and ${MAX_TARGETS} plugins`)
  }
  const ids = new Set<string>()
  const observerIds = new Set<string>()
  const plugins = root.plugins.map((value, index): DshInstallTarget => {
    const item = record(value, `plugins[${index}]`)
    const id = boundedString(item.id, `plugins[${index}].id`, 64)
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`plugins[${index}].id must be a short lowercase label`)
    if (ids.has(id)) throw new Error(`duplicate DSH install target id: ${id}`)
    ids.add(id)
    const parsedSpec = parseNpmSpec(boundedString(item.spec, `plugins[${index}].spec`, 512))
    const spec = `${parsedSpec.name}@${parsedSpec.version}`
    const reason = boundedString(item.reason, `plugins[${index}].reason`, 2_048)
    const observerTargetId = item.observerTargetId === undefined
      ? undefined
      : boundedString(item.observerTargetId, `plugins[${index}].observerTargetId`, 128)
    if (observerTargetId !== undefined) {
      if (observerIds.has(observerTargetId)) throw new Error(`duplicate observerTargetId in DSH install targets: ${observerTargetId}`)
      observerIds.add(observerTargetId)
    }
    const rawAllowedBuilds = item.allowedBuilds
    if (rawAllowedBuilds !== undefined && (!Array.isArray(rawAllowedBuilds) || rawAllowedBuilds.length > 16)) {
      throw new Error(`plugins[${index}].allowedBuilds must be an array of at most 16 package names`)
    }
    const allowedBuilds = rawAllowedBuilds === undefined
      ? []
      : rawAllowedBuilds.map((value, buildIndex) => {
          const name = boundedString(value, `plugins[${index}].allowedBuilds[${buildIndex}]`, 214)
          if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
            throw new Error(`plugins[${index}].allowedBuilds[${buildIndex}] must be an npm package name`)
          }
          return name
        })
    if (new Set(allowedBuilds).size !== allowedBuilds.length) throw new Error(`plugins[${index}].allowedBuilds must be unique`)
    allowedBuilds.sort()
    return {
      id,
      spec,
      reason,
      ...(observerTargetId === undefined ? {} : { observerTargetId }),
      ...(allowedBuilds.length === 0 ? {} : { allowedBuilds }),
    }
  })
  plugins.sort((left, right) => left.id.localeCompare(right.id))
  return { schema: DSH_INSTALL_TARGETS_SCHEMA, plugins }
}

interface PackageCoordinate {
  name: string
  version: string
  integrity?: string
}

function packageCoordinate(value: unknown): PackageCoordinate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.name !== 'string' || typeof item.version !== 'string' || !EXACT_VERSION.test(item.version)) return undefined
  return {
    name: item.name,
    version: item.version,
    ...(typeof item.integrity === 'string' ? { integrity: item.integrity } : {}),
  }
}

function snapshotPackage(value: unknown): PackageCoordinate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return packageCoordinate((value as Record<string, unknown>).package)
}

function coordinateChanged(before: PackageCoordinate | undefined, after: PackageCoordinate | undefined): boolean {
  return after !== undefined && (
    before === undefined
    || before.name !== after.name
    || before.version !== after.version
    || before.integrity !== after.integrity
  )
}

function observedPackage(stateInput: unknown, targetId: string): PackageCoordinate | undefined {
  if (typeof stateInput !== 'object' || stateInput === null || Array.isArray(stateInput)) return undefined
  const targets = (stateInput as Record<string, unknown>).targets
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) return undefined
  return snapshotPackage((targets as Record<string, unknown>)[targetId])
}

function observedDshVersion(stateInput: unknown): string | undefined {
  const coordinate = observedPackage(stateInput, DSH_TARGET_ID)
  return coordinate?.name === DSH_PACKAGE ? coordinate.version : undefined
}

export function buildDshInstallPlan(corpusInput: unknown, stateInput: unknown, reportInput: unknown): DshInstallPlan {
  const corpus = parseDshInstallTargets(corpusInput)
  const report = record(reportInput, 'observer report')
  if (!Array.isArray(report.changes)) throw new Error('observer report changes must be an array')
  const changes = report.changes
    .map((value, index) => ({ value: record(value, `changes[${index}]`), index }))
    .filter(({ value }) => value.meaningful === true && typeof value.targetId === 'string')

  const dshChange = changes.find(({ value }) => value.targetId === DSH_TARGET_ID)
  const dshBefore = dshChange === undefined ? undefined : snapshotPackage(dshChange.value.previous)
  const dshAfter = dshChange === undefined ? undefined : snapshotPackage(dshChange.value.current)
  const dshPackageChanged = dshAfter?.name === DSH_PACKAGE && coordinateChanged(dshBefore, dshAfter)
  const dshVersion = dshPackageChanged ? dshAfter.version : observedDshVersion(stateInput)
  const selected = new Map<string, { id: string; plugin: string; allowedBuilds: string }>()
  const triggers = new Set<string>()

  if (dshPackageChanged) {
    triggers.add(DSH_TARGET_ID)
    for (const target of corpus.plugins) {
      const expected = parseNpmSpec(target.spec)
      const observed = target.observerTargetId === undefined
        ? undefined
        : observedPackage(stateInput, target.observerTargetId)
      const plugin = observed?.name === expected.name
        ? `${observed.name}@${observed.version}`
        : target.spec
      selected.set(target.id, { id: target.id, plugin, allowedBuilds: target.allowedBuilds?.join(',') ?? '' })
    }
  }

  for (const target of corpus.plugins) {
    if (target.observerTargetId === undefined) continue
    const change = changes.find(({ value }) => value.targetId === target.observerTargetId)
    if (change === undefined) continue
    const before = snapshotPackage(change.value.previous)
    const after = snapshotPackage(change.value.current)
    if (!coordinateChanged(before, after) || after === undefined) continue
    const expected = parseNpmSpec(target.spec)
    if (after.name !== expected.name) continue
    triggers.add(target.observerTargetId)
    selected.set(target.id, {
      id: target.id,
      plugin: `${after.name}@${after.version}`,
      allowedBuilds: target.allowedBuilds?.join(',') ?? '',
    })
  }

  const include = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id))
  if (include.length === 0) {
    return {
      run: false,
      ...(dshVersion === undefined ? {} : { dshVersion }),
      matrix: { include: [] },
      triggers: [],
      reason: 'no maintained install target changed its exact published coordinate',
    }
  }
  if (dshVersion === undefined) {
    return {
      run: false,
      matrix: { include: [] },
      triggers: [...triggers].sort(),
      reason: 'a maintained plugin changed, but no exact observed DSH release is available',
    }
  }
  return {
    run: true,
    dshVersion,
    matrix: { include },
    triggers: [...triggers].sort(),
    reason: dshPackageChanged
      ? `the official DSH package changed to ${DSH_PACKAGE}@${dshVersion}`
      : 'a maintained plugin changed its exact published coordinate',
  }
}
