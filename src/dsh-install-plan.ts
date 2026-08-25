import {
  createDshCompatibilityContractFingerprint,
  createDshCompatibilityStaticFingerprint,
  dshCompatibilityCaseId,
  emptyDshCompatibilityLedger,
  parseDshCompatibilityLedger,
  type DshCompatibilityExpectedCase,
  type DshCompatibilityLedger,
} from './dsh-compatibility-ledger.js'
import { parseNpmSpec } from './npm.js'
import { satisfiesSemverRange } from './semver.js'

export const DSH_INSTALL_TARGETS_SCHEMA = 'upstream-radar.dsh-install-targets/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DSH_TARGET_ID = 'deepseek-harness'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const MAX_TARGETS = 100
const MAX_RUNTIME_PROFILES = 8
const DEFAULT_REFRESH_AFTER_HOURS = 7 * 24

export interface DshInstallTarget {
  id: string
  spec: string
  reason: string
  observerTargetId?: string
  allowedBuilds?: string[]
  runtimeProfiles?: string[]
}

export interface DshInstallRuntimeProfile {
  id: string
  nodeMajor: number
}

export interface DshInstallTargets {
  schema: typeof DSH_INSTALL_TARGETS_SCHEMA
  refreshAfterHours: number
  runtimeProfiles: DshInstallRuntimeProfile[]
  plugins: DshInstallTarget[]
}

export interface DshInstallPlan {
  run: boolean
  dshVersion?: string
  matrix: {
    include: DshCompatibilityExpectedCase[]
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
  const refreshAfterHours = root.refreshAfterHours === undefined
    ? DEFAULT_REFRESH_AFTER_HOURS
    : Number(root.refreshAfterHours)
  if (!Number.isSafeInteger(refreshAfterHours) || refreshAfterHours < 1 || refreshAfterHours > 90 * 24) {
    throw new Error('DSH install target refreshAfterHours must be an integer between 1 and 2160')
  }
  const rawRuntimeProfiles = root.runtimeProfiles === undefined
    ? [{ id: 'node22', nodeMajor: 22 }]
    : root.runtimeProfiles
  if (!Array.isArray(rawRuntimeProfiles) || rawRuntimeProfiles.length === 0 || rawRuntimeProfiles.length > MAX_RUNTIME_PROFILES) {
    throw new Error(`DSH install targets runtimeProfiles must contain between 1 and ${MAX_RUNTIME_PROFILES} profiles`)
  }
  const runtimeProfileIds = new Set<string>()
  const nodeMajors = new Set<number>()
  const runtimeProfiles = rawRuntimeProfiles.map((value, index): DshInstallRuntimeProfile => {
    const item = record(value, `runtimeProfiles[${index}]`)
    const id = boundedString(item.id, `runtimeProfiles[${index}].id`, 48)
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(id)) throw new Error(`runtimeProfiles[${index}].id must be a short lowercase label`)
    if (runtimeProfileIds.has(id)) throw new Error(`duplicate DSH install runtime profile id: ${id}`)
    runtimeProfileIds.add(id)
    if (!Number.isSafeInteger(item.nodeMajor) || (item.nodeMajor as number) < 16 || (item.nodeMajor as number) > 40) {
      throw new Error(`runtimeProfiles[${index}].nodeMajor must be a supported Node.js major version`)
    }
    const nodeMajor = item.nodeMajor as number
    if (nodeMajors.has(nodeMajor)) throw new Error(`duplicate DSH install runtime Node major: ${nodeMajor}`)
    nodeMajors.add(nodeMajor)
    return { id, nodeMajor }
  })
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
    const rawRuntimeProfileIds = item.runtimeProfiles
    if (rawRuntimeProfileIds !== undefined && (!Array.isArray(rawRuntimeProfileIds) || rawRuntimeProfileIds.length === 0 || rawRuntimeProfileIds.length > MAX_RUNTIME_PROFILES)) {
      throw new Error(`plugins[${index}].runtimeProfiles must be an array of between 1 and ${MAX_RUNTIME_PROFILES} runtime profile ids`)
    }
    const selectedRuntimeProfiles = rawRuntimeProfileIds === undefined
      ? undefined
      : rawRuntimeProfileIds.map((value, profileIndex) => {
          const profileId = boundedString(value, `plugins[${index}].runtimeProfiles[${profileIndex}]`, 48)
          if (!runtimeProfileIds.has(profileId)) throw new Error(`plugins[${index}].runtimeProfiles[${profileIndex}] is not a configured runtime profile`)
          return profileId
        })
    if (selectedRuntimeProfiles !== undefined && new Set(selectedRuntimeProfiles).size !== selectedRuntimeProfiles.length) {
      throw new Error(`plugins[${index}].runtimeProfiles must be unique`)
    }
    return {
      id,
      spec,
      reason,
      ...(observerTargetId === undefined ? {} : { observerTargetId }),
      ...(allowedBuilds.length === 0 ? {} : { allowedBuilds }),
      ...(selectedRuntimeProfiles === undefined ? {} : { runtimeProfiles: selectedRuntimeProfiles }),
    }
  })
  plugins.sort((left, right) => left.id.localeCompare(right.id))
  return { schema: DSH_INSTALL_TARGETS_SCHEMA, refreshAfterHours, runtimeProfiles, plugins }
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

function observedTarget(stateInput: unknown, targetId: string): Record<string, unknown> | undefined {
  if (typeof stateInput !== 'object' || stateInput === null || Array.isArray(stateInput)) return undefined
  const targets = (stateInput as Record<string, unknown>).targets
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) return undefined
  const target = (targets as Record<string, unknown>)[targetId]
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined
  return target as Record<string, unknown>
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const result = Object.fromEntries(keys
    .filter(key => record[key] !== undefined)
    .map(key => [key, record[key]]))
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Retain only static facts that can invalidate behavior evidence. In
 * particular, observedAt is intentionally absent: a steady scan must not make
 * every dynamic cell stale merely because the static collector ran again.
 */
function staticTargetEvidence(stateInput: unknown, targetId: string): unknown {
  const target = observedTarget(stateInput, targetId)
  if (target === undefined) return undefined
  const source = pick(target.source, ['repository', 'commit', 'packagePath', 'lockfile'])
  const manifest = pick(target.manifest, ['name', 'version', 'engines', 'peerDependencies', 'dependencies', 'optionalDependencies', 'dsh'])
  const packageCoordinate = pick(target.package, ['name', 'version', 'integrity', 'artifactDigest', 'tarball'])
  const alignment = pick(target.alignment, ['status', 'checks'])
  const graph = pick(target.graph, ['digest', 'rootNodeId', 'source', 'unresolved'])
  return {
    ...(source === undefined ? {} : { source }),
    ...(manifest === undefined ? {} : { manifest }),
    ...(packageCoordinate === undefined ? {} : { package: packageCoordinate }),
    ...(graph === undefined ? {} : { graph }),
    ...(alignment === undefined ? {} : { alignment }),
  }
}

/**
 * Resolve the exact plugin coordinate represented by one maintained target.
 * The target spec is the bootstrap coordinate; once the observer has seen a
 * newer publication of the same package, every downstream planner must bind
 * to that observed coordinate instead of comparing against stale config.
 */
export function resolveDshInstallTargetSpec(target: DshInstallTarget, stateInput: unknown): string {
  const expected = parseNpmSpec(target.spec)
  const observed = target.observerTargetId === undefined
    ? undefined
    : observedPackage(stateInput, target.observerTargetId)
  return observed?.name === expected.name ? `${observed.name}@${observed.version}` : target.spec
}

function changeForTarget(changes: readonly { value: Record<string, unknown> }[], targetId: string): Record<string, unknown> | undefined {
  return changes.find(({ value }) => value.targetId === targetId)?.value
}

function changedPluginTargets(
  corpus: DshInstallTargets,
  changes: readonly { value: Record<string, unknown> }[],
): Set<string> {
  const changed = new Set<string>()
  for (const target of corpus.plugins) {
    if (target.observerTargetId === undefined) continue
    const change = changeForTarget(changes, target.observerTargetId)
    if (change === undefined) continue
    const before = snapshotPackage(change.previous)
    const after = snapshotPackage(change.current)
    const expected = parseNpmSpec(target.spec)
    if (coordinateChanged(before, after) && after?.name === expected.name) changed.add(target.id)
  }
  return changed
}

function candidateProfiles(
  corpus: DshInstallTargets,
  target: DshInstallTarget,
  plugin: string,
  ledger: DshCompatibilityLedger,
): DshInstallRuntimeProfile[] {
  const configured = new Map(corpus.runtimeProfiles.map(profile => [profile.id, profile]))
  const selected = new Map<string, DshInstallRuntimeProfile>()
  for (const id of target.runtimeProfiles ?? [corpus.runtimeProfiles[0]?.id]) {
    if (id === undefined) continue
    const profile = configured.get(id)
    if (profile !== undefined) selected.set(profile.id, profile)
  }

  // A static Node engine check may stop a dynamic run before third-party code
  // executes. Its result is useful input: try every configured, potentially
  // matching runtime once, instead of calling a Node 22 failure "the plugin is
  // incompatible" without checking the package's stated runtime.
  if (target.runtimeProfiles === undefined) {
    const runtimeMismatches = ledger.entries.filter(entry => (
      entry.targetId === target.id
      && entry.plugin === plugin
      && entry.result === 'runtime-incompatible'
      && entry.artifact.nodeEngine !== undefined
    ))
    for (const entry of runtimeMismatches) {
      const engine = entry.artifact.nodeEngine
      if (engine === undefined) continue
      for (const profile of corpus.runtimeProfiles) {
        if (selected.has(profile.id)) continue
        const potential = satisfiesSemverRange(`${profile.nodeMajor}.999.999`, engine)
        if (potential !== false) selected.set(profile.id, profile)
      }
    }
  }
  return [...selected.values()]
}

function isStale(entry: DshCompatibilityLedger['entries'][number], refreshAfterHours: number, now: Date): boolean {
  const observedAt = Date.parse(entry.observedAt)
  if (!Number.isFinite(observedAt)) return true
  const effectiveHours = entry.result === 'unknown' ? Math.min(refreshAfterHours, 24) : refreshAfterHours
  return now.getTime() - observedAt >= effectiveHours * 60 * 60 * 1_000
}

/**
 * A successful install/load alone does not establish the dependency relation
 * that Radar promises to monitor. Keep such a cell pending until its final
 * DSH profile plus host-runtime graph is complete. Failed installs deliberately
 * do not use this rule: there may be no final profile to read.
 */
function hasCompleteResolutionEvidence(entry: DshCompatibilityLedger['entries'][number]): boolean {
  if (entry.result !== 'compatible') return true
  const graph = entry.resolution?.runtimeGraph
  const contracts = graph?.pluginPeerContracts
  return graph?.digest !== undefined
    && graph.unresolved === 0
    && contracts !== undefined
    && contracts.mismatched === 0
    && contracts.missing === 0
    && contracts.indeterminate === 0
}

/**
 * Reconcile the desired current compatibility matrix with durable evidence.
 * Upstream diffs accelerate a retest, but do not decide whether a cell gets
 * tested: missing, stale, or static/contract-invalidated cells are selected
 * even when neither package published a new version.
 */
export function buildDshInstallPlan(
  corpusInput: unknown,
  stateInput: unknown,
  reportInput: unknown,
  ledgerInput: unknown = emptyDshCompatibilityLedger(),
  now = new Date(),
  reviewedInput: ReadonlySet<string> = new Set(),
): DshInstallPlan {
  const corpus = parseDshInstallTargets(corpusInput)
  const ledger = parseDshCompatibilityLedger(ledgerInput)
  if (!Number.isFinite(now.getTime())) throw new Error('DSH install plan requires a valid current time')
  const report = record(reportInput, 'observer report')
  if (!Array.isArray(report.changes)) throw new Error('observer report changes must be an array')
  const changes = report.changes
    .map((value, index) => ({ value: record(value, `changes[${index}]`), index }))
    .filter(({ value }) => value.meaningful === true && typeof value.targetId === 'string')

  const dshChange = changeForTarget(changes, DSH_TARGET_ID)
  const dshBefore = dshChange === undefined ? undefined : snapshotPackage(dshChange.previous)
  const dshAfter = dshChange === undefined ? undefined : snapshotPackage(dshChange.current)
  const dshPackageChanged = dshAfter?.name === DSH_PACKAGE && coordinateChanged(dshBefore, dshAfter)
  const dshVersion = dshPackageChanged ? dshAfter.version : observedDshVersion(stateInput)
  const pluginChanges = changedPluginTargets(corpus, changes)
  const reviewed = reviewedInput
  const triggers = new Set<string>()
  if (dshPackageChanged) triggers.add(DSH_TARGET_ID)
  for (const target of corpus.plugins) {
    if (pluginChanges.has(target.id) && target.observerTargetId !== undefined) triggers.add(target.observerTargetId)
  }

  if (dshVersion === undefined) {
    return {
      run: false,
      matrix: { include: [] },
      triggers: [...triggers].sort(),
      reason: 'no exact observed DSH release is available, so the compatibility matrix cannot be formed',
    }
  }

  const dshStatic = staticTargetEvidence(stateInput, DSH_TARGET_ID)
  const selected = new Map<string, DshCompatibilityExpectedCase>()
  let desiredCells = 0
  for (const target of corpus.plugins) {
    const plugin = resolveDshInstallTargetSpec(target, stateInput)
    const staticFingerprint = createDshCompatibilityStaticFingerprint({
      plugin,
      dshVersion,
      pluginStatic: target.observerTargetId === undefined ? undefined : staticTargetEvidence(stateInput, target.observerTargetId),
      dshStatic,
    })
    const allowedBuilds = target.allowedBuilds ?? []
    for (const runtimeProfile of candidateProfiles(corpus, target, plugin, ledger)) {
      desiredCells += 1
      const id = dshCompatibilityCaseId(target.id, runtimeProfile.id)
      const contractFingerprint = createDshCompatibilityContractFingerprint({
        plugin,
        dshVersion,
        nodeMajor: runtimeProfile.nodeMajor,
        allowedBuilds,
      })
      const previous = ledger.entries.find(entry => entry.caseId === id)
      const reasons = new Set<string>()
      if (dshPackageChanged) reasons.add('dsh-coordinate-changed')
      if (pluginChanges.has(target.id)) reasons.add('plugin-coordinate-changed')
      if (previous === undefined) reasons.add('missing-evidence')
      else {
        if (previous.plugin !== plugin || previous.dshVersion !== dshVersion || previous.runtime.nodeMajor !== runtimeProfile.nodeMajor) {
          reasons.add('exact-coordinate-changed')
        }
        if (previous.staticFingerprint !== staticFingerprint) reasons.add('static-evidence-changed')
        if (previous.contractFingerprint !== contractFingerprint) reasons.add('execution-contract-changed')
        if (isStale(previous, corpus.refreshAfterHours, now)) reasons.add('stale-evidence')
        if (!hasCompleteResolutionEvidence(previous)) {
          const graph = previous.resolution?.runtimeGraph
          if (graph?.digest === undefined) reasons.add('runtime-graph-missing')
          else if (graph.unresolved > 0) reasons.add('runtime-graph-incomplete')
          else if (graph.pluginPeerContracts === undefined) reasons.add('peer-contract-not-evaluated')
          else if (graph.pluginPeerContracts.indeterminate > 0) reasons.add('peer-contract-indeterminate')
          else reasons.add('peer-contract-incomplete')
        }
      }
      if (reasons.size === 0) continue
      // An Agent may explicitly stop on an unchanged, non-actionable headless
      // result (for example a Web-only contract). Do not spin the same cell on
      // every scheduled run; a DSH/plugin coordinate or evidence change must
      // still invalidate that review and select it again.
      if (reviewed.has(id)
        && !dshPackageChanged
        && !pluginChanges.has(target.id)
        && !reasons.has('exact-coordinate-changed')
        && !reasons.has('static-evidence-changed')
        && !reasons.has('execution-contract-changed')
        && !reasons.has('stale-evidence')) continue
      selected.set(id, {
        id,
        targetId: target.id,
        plugin,
        dshVersion,
        nodeMajor: runtimeProfile.nodeMajor,
        allowedBuilds: allowedBuilds.join(','),
        staticFingerprint,
        contractFingerprint,
        reasons: [...reasons].sort(),
      })
    }
  }

  const include = [...selected.values()].sort((left, right) => left.id.localeCompare(right.id))
  if (include.length === 0) {
    return {
      run: false,
      dshVersion,
      matrix: { include: [] },
      triggers: [...triggers].sort(),
      reason: `all ${desiredCells} active DSH compatibility cells have fresh evidence`,
    }
  }
  return {
    run: true,
    dshVersion,
    matrix: { include },
    triggers: [...triggers].sort(),
    reason: `the compatibility ledger requires ${include.length} isolated recheck${include.length === 1 ? '' : 's'} across ${desiredCells} active cells`,
  }
}
