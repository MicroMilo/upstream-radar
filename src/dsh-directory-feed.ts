import {
  dshCompatibilityCaseId,
  emptyDshCompatibilityLedger,
  parseDshCompatibilityLedger,
  type DshCompatibilityLedgerEntry,
} from './dsh-compatibility-ledger.js'
import { applyDshEnvironmentRecommendations } from './dsh-environment-recommendation.js'
import { buildDshInstallPlan, currentDshCompatibilitySources, parseDshInstallTargets } from './dsh-install-plan.js'
import { applyDshHeadlessAgentPlans } from './dsh-headless-agent-plan.js'
import { buildDshAdapterPlan, emptyDshAdapterLedger, parseDshAdapterLedger, type DshAdapterLedger } from './dsh-adapter.js'
import {
  DSH_SURFACE_LEDGER_SCHEMA,
  DSH_SURFACE_TARGETS_SCHEMA,
  buildDshSurfacePlan,
  emptyDshSurfaceLedger,
  createDshSurfaceSourceFingerprint,
  parseDshSurfaceLedger,
  type DshSurfaceLedgerEntry,
} from './dsh-surface.js'
import type { DshSurfaceObservationResult } from './dsh-surface-observation.js'
import type { DshStartupConfiguration } from './dsh-startup-configuration.js'
import { selectDshProfileEnvironment } from './dsh-profile-environment.js'
import { parseDshSurfaceAgentPlans } from './dsh-surface-agent-plan.js'
import { parseNpmSpec } from './npm.js'
import { TOOL_VERSION } from './version.js'

export const AWESOME_DSH_COHORT_SCHEMA = 'upstream-radar.awesome-dsh-cohort/v1alpha1' as const
export const DSH_DIRECTORY_COMPATIBILITY_FEED_SCHEMA = 'upstream-radar.dsh-directory-compatibility-feed/v1alpha5' as const

const MAX_COHORT_PLUGINS = 100
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CATALOG_ENTRY = /^data\/plugins\/[A-Za-z0-9_.@-]+\.ya?ml$/

export type DshDirectoryEvidenceStatus =
  | 'observed-compatible'
  | 'observed-incompatible'
  | 'needs-review'
  | 'update-pending'
  | 'not-observed'

export type DshDirectoryExecutionPlane = 'headless' | 'web' | 'tui' | 'sdk' | 'acp'
const PLANE_ORDER = { headless: 0, web: 1, tui: 2, sdk: 3, acp: 4 } as const

export interface AwesomeDshCohortPlugin {
  id: string
  catalogEntry: string
  catalogUrl: string
  repository: string
  category: string
  distribution:
    | { kind: 'npm'; name: string; selectedVersion: string; distTag?: string }
    | { kind: 'github'; installSpec?: string; reason: string }
    | { kind: 'repository-installer'; reason: string }
}

export interface AwesomeDshCohort {
  schema: typeof AWESOME_DSH_COHORT_SCHEMA
  selectedAt: string
  source: {
    repository: string
    commit: string
    commitUrl: string
    entryDirectory: string
    entryCount: number
    license: string
  }
  plugins: AwesomeDshCohortPlugin[]
}

export interface DshDirectoryEvidenceCell {
  caseId: string
  sourceCaseId?: string
  evidenceSource: 'compatibility-ledger' | 'surface-ledger' | 'adapter-ledger'
  artifact: {
    spec: string
    sha256?: string
  }
  dsh: {
    package: '@deepseek-ai/dsh'
    version: string
  }
  runtime: {
    nodeMajor: number
    nodeVersion: string
    platform: string
    architecture: string
  }
  executionPlane: DshDirectoryExecutionPlane
  profile: string
  startupConfiguration?: DshStartupConfiguration
  evidenceScope?: 'adapter-initialize-only'
  versionRole?: 'target' | 'author-baseline'
  coverageGaps?: string[]
  dependencyGraphDigests?: { profile?: string; application?: string }
  status: Exclude<DshDirectoryEvidenceStatus, 'not-observed' | 'update-pending'>
  radarResult: DshCompatibilityLedgerEntry['result'] | DshSurfaceObservationResult | DshAdapterLedger['entries'][number]['report']['result']
  requiredDependencyBuilds?: string[]
  approvedDependencyBuilds?: string[]
  /** Compatible intended-plane cells that resolve this headless-only coverage gap. */
  coveredBy?: string[]
  observedAt: string
  recheckDueAt: string
  reason: string
}

/**
 * The exact repository-derived environment scope that must be covered before
 * a directory consumer can treat the plugin as globally observed-compatible.
 */
export interface DshDirectoryEnvironmentRecommendation {
  status: 'current' | 'missing'
  preferredNodeMajor?: number
  nodeMajors: number[]
  executionProfiles: Array<DshDirectoryExecutionPlane | 'sdk' | 'acp'>
  expectedCells: string[]
  missingCells: string[]
  /** Explicit intended workflows/evidence gaps beyond the selected smoke cells. */
  coverageGaps: string[]
  sourceFingerprint?: string
  summary?: string
  evidence?: string[]
}

export interface DshDirectoryCompatibilityEntry {
  id: string
  repository: string
  repositoryUrl: string
  catalogUrl: string
  catalogEntry: string
  catalogEntryUrl: string
  category: string
  distribution: AwesomeDshCohortPlugin['distribution']
  status: DshDirectoryEvidenceStatus
  cells: DshDirectoryEvidenceCell[]
  environmentRecommendation?: DshDirectoryEnvironmentRecommendation
  evidenceUrl: string
  surfaceEvidenceUrl?: string
  adapterEvidenceUrl?: string
}

export interface DshDirectoryCompatibilityFeed {
  schema: typeof DSH_DIRECTORY_COMPATIBILITY_FEED_SCHEMA
  generatedAt: string
  producer: {
    name: 'upstream-radar'
    version: string
    repository: string
    license: 'Apache-2.0'
  }
  selectedHost?: {
    package: '@deepseek-ai/dsh'
    version: string
  }
  sourceCatalog: AwesomeDshCohort['source']
  boundary: {
    claim: 'exact-cell compatibility evidence; not a security review, endorsement, or timeless compatibility badge'
    executionPlanes: DshDirectoryExecutionPlane[]
    profiles: string[]
    isolation: 'fresh GitHub-hosted VM plus restricted container'
    consumptionRule: string
    refreshAfterHours: number
  }
  summary: Record<DshDirectoryEvidenceStatus, number> & { total: number }
  plugins: DshDirectoryCompatibilityEntry[]
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

function timestamp(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be an ISO timestamp`)
  return parsed
}

function repository(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 256)
  if (!REPOSITORY.test(parsed)) throw new Error(`${label} must be an owner/repository coordinate`)
  return parsed
}

function httpsUrl(value: unknown, label: string): string {
  const parsed = new URL(boundedString(value, label, 2_048))
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label} must be a credential-free HTTPS URL`)
  }
  return parsed.toString()
}

function githubCatalogUrl(value: unknown, repositoryName: string, label: string): string {
  const parsed = new URL(httpsUrl(value, label))
  const expectedPath = `/${repositoryName}`.toLowerCase()
  const actualPath = parsed.pathname.replace(/\/$/, '').toLowerCase()
  if (parsed.hostname.toLowerCase() !== 'github.com' || (actualPath !== expectedPath && !actualPath.startsWith(`${expectedPath}/`))) {
    throw new Error(`${label} must stay within the selected GitHub repository`)
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  return parsed.toString()
}

function parseDistribution(value: unknown, label: string): AwesomeDshCohortPlugin['distribution'] {
  const item = record(value, label)
  const kind = boundedString(item.kind, `${label}.kind`, 64)
  if (kind === 'npm') {
    const name = boundedString(item.name, `${label}.name`, 214)
    const selectedVersion = boundedString(item.selectedVersion, `${label}.selectedVersion`, 256)
    parseNpmSpec(`${name}@${selectedVersion}`)
    const distTag = item.distTag === undefined ? undefined : boundedString(item.distTag, `${label}.distTag`, 128)
    return { kind, name, selectedVersion, ...(distTag === undefined ? {} : { distTag }) }
  }
  if (kind === 'github') {
    const reason = boundedString(item.reason, `${label}.reason`, 2_048)
    const installSpec = item.installSpec === undefined
      ? undefined
      : boundedString(item.installSpec, `${label}.installSpec`, 512)
    return { kind, reason, ...(installSpec === undefined ? {} : { installSpec }) }
  }
  if (kind === 'repository-installer') {
    return { kind, reason: boundedString(item.reason, `${label}.reason`, 2_048) }
  }
  throw new Error(`${label}.kind is unsupported`)
}

export function parseAwesomeDshCohort(input: unknown): AwesomeDshCohort {
  const root = record(input, 'awesome-dsh-plugin cohort')
  if (root.schema !== AWESOME_DSH_COHORT_SCHEMA) {
    throw new Error(`awesome-dsh-plugin cohort schema must be ${AWESOME_DSH_COHORT_SCHEMA}`)
  }
  const source = record(root.source, 'awesome-dsh-plugin cohort source')
  const commit = boundedString(source.commit, 'awesome-dsh-plugin cohort source.commit', 40)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('awesome-dsh-plugin cohort source.commit must be a full Git commit')
  const entryCount = Number(source.entryCount)
  if (!Number.isSafeInteger(entryCount) || entryCount < 1 || entryCount > 100_000) {
    throw new Error('awesome-dsh-plugin cohort source.entryCount must be a positive bounded integer')
  }
  if (!Array.isArray(root.plugins) || root.plugins.length === 0 || root.plugins.length > MAX_COHORT_PLUGINS) {
    throw new Error(`awesome-dsh-plugin cohort plugins must contain between 1 and ${MAX_COHORT_PLUGINS} entries`)
  }
  const ids = new Set<string>()
  const repositories = new Set<string>()
  const plugins = root.plugins.map((value, index): AwesomeDshCohortPlugin => {
    const item = record(value, `plugins[${index}]`)
    const id = boundedString(item.id, `plugins[${index}].id`, 64)
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`plugins[${index}].id must be a short lowercase label`)
    if (ids.has(id)) throw new Error(`duplicate awesome-dsh-plugin cohort id: ${id}`)
    ids.add(id)
    const repositoryName = repository(item.repository, `plugins[${index}].repository`)
    if (repositories.has(repositoryName)) throw new Error(`duplicate awesome-dsh-plugin cohort repository: ${repositoryName}`)
    repositories.add(repositoryName)
    const catalogEntry = boundedString(item.catalogEntry, `plugins[${index}].catalogEntry`, 512)
    if (!CATALOG_ENTRY.test(catalogEntry)) throw new Error(`plugins[${index}].catalogEntry must identify one catalog YAML entry`)
    return {
      id,
      catalogEntry,
      catalogUrl: githubCatalogUrl(item.catalogUrl, repositoryName, `plugins[${index}].catalogUrl`),
      repository: repositoryName,
      category: boundedString(item.category, `plugins[${index}].category`, 64),
      distribution: parseDistribution(item.distribution, `plugins[${index}].distribution`),
    }
  })
  plugins.sort((left, right) => left.repository.localeCompare(right.repository))
  return {
    schema: AWESOME_DSH_COHORT_SCHEMA,
    selectedAt: timestamp(root.selectedAt, 'awesome-dsh-plugin cohort selectedAt'),
    source: {
      repository: repository(source.repository, 'awesome-dsh-plugin cohort source.repository'),
      commit,
      commitUrl: httpsUrl(source.commitUrl, 'awesome-dsh-plugin cohort source.commitUrl'),
      entryDirectory: boundedString(source.entryDirectory, 'awesome-dsh-plugin cohort source.entryDirectory', 512),
      entryCount,
      license: boundedString(source.license, 'awesome-dsh-plugin cohort source.license', 128),
    },
    plugins,
  }
}

function cellStatus(result: DshCompatibilityLedgerEntry['result']): Exclude<DshDirectoryEvidenceStatus, 'not-observed' | 'update-pending'> {
  if (result === 'compatible') return 'observed-compatible'
  if (result === 'runtime-incompatible' || result === 'install-failed' || result === 'load-failed') {
    return 'observed-incompatible'
  }
  return 'needs-review'
}

function surfaceCellStatus(result: DshSurfaceObservationResult): Exclude<DshDirectoryEvidenceStatus, 'not-observed' | 'update-pending'> {
  if (result === 'compatible') return 'observed-compatible'
  if (result === 'surface-incompatible') return 'observed-incompatible'
  return 'needs-review'
}

function aggregateExactCellStatus(cells: readonly DshDirectoryEvidenceCell[]): DshDirectoryEvidenceStatus {
  if (cells.length === 0) return 'not-observed'
  if (cells.some(cell => cell.status === 'observed-incompatible')) return 'observed-incompatible'
  if (cells.some(cell => cell.status === 'needs-review')) return 'needs-review'
  return 'observed-compatible'
}

function aggregateStatus(
  distribution: AwesomeDshCohortPlugin['distribution'],
  cells: readonly DshDirectoryEvidenceCell[],
  selectedDshVersion?: string,
): DshDirectoryEvidenceStatus {
  if (cells.length === 0) return 'not-observed'
  if (distribution.kind !== 'npm') return aggregateExactCellStatus(cells)
  const selectedSpec = `${distribution.name}@${distribution.selectedVersion}`
  const currentCells = cells.filter(cell => (
    cell.artifact.spec === selectedSpec
    && (selectedDshVersion === undefined || cell.dsh.version === selectedDshVersion)
  ))
  if (currentCells.length === 0) return 'update-pending'
  return aggregateExactCellStatus(currentCells)
}

function dueAt(observedAt: string, refreshAfterHours: number): string {
  return new Date(Date.parse(observedAt) + refreshAfterHours * 60 * 60 * 1_000).toISOString()
}

function exactSurfaceBinding(source: DshCompatibilityLedgerEntry, surface: DshSurfaceLedgerEntry): boolean {
  return surface.sourceCaseId === source.caseId
    && surface.plugin === source.plugin
    && surface.dshVersion === source.dshVersion
    && surface.runtime.nodeMajor === source.runtime.nodeMajor
    && surface.runtime.platform === source.runtime.platform
    && surface.runtime.architecture === source.runtime.architecture
    && surface.sourceFingerprint === createDshSurfaceSourceFingerprint(source)
    && source.artifact.sha256 !== undefined
    && surface.artifact.sha256 === source.artifact.sha256
}

function surfaceCell(surface: DshSurfaceLedgerEntry, refreshAfterHours: number): DshDirectoryEvidenceCell {
  return {
    caseId: surface.caseId,
    sourceCaseId: surface.sourceCaseId,
    evidenceSource: 'surface-ledger',
    artifact: { spec: surface.plugin, sha256: surface.artifact.sha256 },
    dsh: { package: '@deepseek-ai/dsh', version: surface.dshVersion },
    runtime: {
      nodeMajor: surface.runtime.nodeMajor,
      nodeVersion: surface.runtime.nodeVersion,
      platform: surface.runtime.platform,
      architecture: surface.runtime.architecture,
    },
    executionPlane: surface.plane,
    profile: surface.profile,
    ...(surface.startupConfiguration === undefined ? {} : { startupConfiguration: surface.startupConfiguration }),
    status: surfaceCellStatus(surface.result),
    radarResult: surface.result,
    ...(surface.approvedDependencyBuilds === undefined
      ? {}
      : { approvedDependencyBuilds: surface.approvedDependencyBuilds }),
    ...(surface.requiredDependencyBuilds === undefined
      ? {}
      : { requiredDependencyBuilds: surface.requiredDependencyBuilds }),
    observedAt: surface.observedAt,
    recheckDueAt: dueAt(surface.observedAt, refreshAfterHours),
    reason: surface.reason,
  }
}

function normalizedRepositoryBaseUrl(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('repositoryBaseUrl must be a credential-free HTTPS URL without query or fragment')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function buildDshDirectoryCompatibilityFeed(input: {
  cohort: unknown
  installTargets: unknown
  ledger: unknown
  surfaceLedger?: unknown
  adapterLedger?: unknown
  buildPlans?: unknown
  surfaceBuildPlans?: unknown
  observations?: unknown
  environmentRecommendations?: unknown
  generatedAt: string
  repositoryBaseUrl?: string
}): DshDirectoryCompatibilityFeed {
  const cohort = parseAwesomeDshCohort(input.cohort)
  const configuredInstallTargets = parseDshInstallTargets(input.installTargets)
  const installTargets = input.environmentRecommendations === undefined
    ? configuredInstallTargets
    : applyDshEnvironmentRecommendations(
        configuredInstallTargets,
        input.observations,
        input.environmentRecommendations,
      )
  const ledger = parseDshCompatibilityLedger(input.ledger)
  const surfaceLedger = parseDshSurfaceLedger(input.surfaceLedger ?? {
    schema: DSH_SURFACE_LEDGER_SCHEMA,
    entries: [],
  })
  const adapterLedger = parseDshAdapterLedger(input.adapterLedger)
  const surfaceBuildPlans = input.surfaceBuildPlans === undefined ? undefined : parseDshSurfaceAgentPlans(input.surfaceBuildPlans)
  const generatedAt = timestamp(input.generatedAt, 'directory feed generatedAt')
  const repositoryBaseUrl = normalizedRepositoryBaseUrl(input.repositoryBaseUrl ?? 'https://github.com/MicroMilo/upstream-radar')
  const targetByObserverId = new Map(installTargets.plugins
    .filter(target => target.observerTargetId !== undefined)
    .map(target => [target.observerTargetId as string, target]))

  const observedPackage = (targetId: string): { name: string; version: string; distTag?: string } | undefined => {
    if (typeof input.observations !== 'object' || input.observations === null || Array.isArray(input.observations)) return undefined
    const rawTargets = (input.observations as Record<string, unknown>).targets
    if (typeof rawTargets !== 'object' || rawTargets === null || Array.isArray(rawTargets)) return undefined
    const rawObservation = (rawTargets as Record<string, unknown>)[targetId]
    if (typeof rawObservation !== 'object' || rawObservation === null || Array.isArray(rawObservation)) return undefined
    const rawPackage = (rawObservation as Record<string, unknown>).package
    if (typeof rawPackage !== 'object' || rawPackage === null || Array.isArray(rawPackage)) return undefined
    const packageRecord = rawPackage as Record<string, unknown>
    if (typeof packageRecord.name !== 'string' || typeof packageRecord.version !== 'string') return undefined
    try {
      parseNpmSpec(`${packageRecord.name}@${packageRecord.version}`)
    } catch {
      return undefined
    }
    const distTag = typeof packageRecord.distTag === 'string'
      && packageRecord.distTag.trim() !== ''
      && packageRecord.distTag.length <= 128
      ? packageRecord.distTag
      : undefined
    return {
      name: packageRecord.name,
      version: packageRecord.version,
      ...(distTag === undefined ? {} : { distTag }),
    }
  }

  const observedDsh = observedPackage('deepseek-harness')
  const selectedDshVersion = observedDsh?.name === '@deepseek-ai/dsh' ? observedDsh.version : undefined
  const now = new Date(generatedAt)
  const effectiveTargets = input.buildPlans === undefined ? installTargets : applyDshHeadlessAgentPlans(installTargets, input.buildPlans, ledger)
  // This is an evidence comparison set, not an execution matrix. Local Linux
  // arm64 observations must not be compared against the GitHub x64 contract.
  const architectures: Array<'x64' | 'arm64'> = ledger.entries.some(entry => entry.runtime.platform === 'linux' && entry.runtime.architecture === 'arm64')
    ? ['x64', 'arm64'] : ['x64']
  const desiredNativeCases = architectures.flatMap(architecture => buildDshInstallPlan(effectiveTargets, input.observations,
    { changes: [] }, emptyDshCompatibilityLedger(), now, new Set(), { platform: 'linux', architecture }).matrix.include)
  const currentNative = currentDshCompatibilitySources(ledger, desiredNativeCases, installTargets.refreshAfterHours, now)
  const currentNativeCaseIds = new Set(currentNative.entries.map(entry => entry.caseId))
  const desiredAdapters = buildDshAdapterPlan(installTargets,
    { ...currentNative, entries: currentNative.entries.filter(entry => entry.dshVersion === selectedDshVersion) }, emptyDshAdapterLedger(), now)
  const currentAdapters = adapterLedger.entries.filter(entry => desiredAdapters.matrix.include.some(cell => (
    cell.id === entry.cell.id && cell.sourceFingerprint === entry.cell.sourceFingerprint
      && cell.contractFingerprint === entry.cell.contractFingerprint && cell.versionRole === entry.cell.versionRole
      && now.getTime() >= Date.parse(entry.report.completedAt)
      && now.getTime() - Date.parse(entry.report.completedAt) < installTargets.refreshAfterHours * 3_600_000
  )))

  const observedDistribution = (plugin: AwesomeDshCohortPlugin): AwesomeDshCohortPlugin['distribution'] => {
    if (plugin.distribution.kind !== 'npm') return plugin.distribution
    const observed = observedPackage(plugin.id)
    if (observed?.name !== plugin.distribution.name) return plugin.distribution
    return {
      kind: 'npm',
      name: plugin.distribution.name,
      selectedVersion: observed.version,
      ...(observed.distTag === undefined ? {} : { distTag: observed.distTag }),
    }
  }

  const plugins = cohort.plugins.map((plugin): DshDirectoryCompatibilityEntry => {
    const installTarget = targetByObserverId.get(plugin.id)
    const recommendation = installTarget?.environmentRecommendation
    const selectedRuntimeProfiles = recommendation === undefined
      ? []
      : (installTarget?.runtimeProfiles ?? [])
    const runtimeById = new Map(installTargets.runtimeProfiles.map(profile => [profile.id, profile]))
    const caseIdByNodeMajor = new Map(selectedRuntimeProfiles.map(runtimeProfileId => {
      const runtime = runtimeById.get(runtimeProfileId)
      if (runtime === undefined) throw new Error(`recommended runtime profile ${runtimeProfileId} is not configured`)
      return [runtime.nodeMajor, dshCompatibilityCaseId(installTarget?.id as string, runtime.id)] as const
    }))
    const observations = installTarget === undefined
      ? []
      : ledger.entries.filter(entry => (
          entry.targetId === installTarget.id
          && (recommendation === undefined || recommendation.nodeMajors.includes(entry.runtime.nodeMajor))
        ))
    const cells: DshDirectoryEvidenceCell[] = []
    const currentSurfaceCaseIds = new Set<string>()
    const adapters = currentAdapters.filter(entry => entry.cell.targetId === installTarget?.id)
    for (const entry of observations) {
      // Repository recommendations define the minimum required cells, not a
      // ceiling. Retain exact manually reviewed or runtime-discovered surface
      // evidence as well. A successful browser startup does not establish the
      // exact versions of browser peers or erase incomplete Node coverage.
      const matchingSurfaces = surfaceLedger.entries.filter(surface => exactSurfaceBinding(entry, surface))
      cells.push({
        caseId: entry.caseId,
        evidenceSource: 'compatibility-ledger',
        artifact: {
          spec: entry.plugin,
          ...(entry.artifact.sha256 === undefined ? {} : { sha256: entry.artifact.sha256 }),
        },
        dsh: { package: '@deepseek-ai/dsh', version: entry.dshVersion },
        runtime: {
          nodeMajor: entry.runtime.nodeMajor,
          nodeVersion: entry.runtime.nodeVersion,
          platform: entry.runtime.platform,
          architecture: entry.runtime.architecture,
        },
        executionPlane: 'headless',
        profile: 'headless',
        status: cellStatus(entry.result),
        radarResult: entry.result,
        ...(entry.requiredDependencyBuilds === undefined ? {} : { requiredDependencyBuilds: entry.requiredDependencyBuilds }),
        ...(entry.approvedDependencyBuilds === undefined ? {} : { approvedDependencyBuilds: entry.approvedDependencyBuilds }),
        observedAt: entry.observedAt,
        recheckDueAt: dueAt(entry.observedAt, installTargets.refreshAfterHours),
        reason: entry.reason,
      })
      for (const surface of matchingSurfaces) {
        cells.push(surfaceCell(surface, installTargets.refreshAfterHours))
        if (!currentNativeCaseIds.has(entry.caseId)) continue
        let profileEnvironment
        try { profileEnvironment = selectDshProfileEnvironment(recommendation?.authorEnvironment, surface.profile, entry.runtime.nodeMajor) }
        catch { continue } // An unsupported author environment cannot establish current coverage.
        const expected = buildDshSurfacePlan({ schema: DSH_SURFACE_TARGETS_SCHEMA, surfaces: [{
          id: surface.caseId, sourceCaseId: surface.sourceCaseId, plane: surface.plane, profile: surface.profile,
          runtimeId: surface.runtimeId, profileEnvironment, reason: 'current directory execution contract',
          ...(surface.startupConfiguration === undefined ? {} : { startupConfiguration: surface.startupConfiguration }),
        }] }, { ...ledger, entries: [entry] }, emptyDshSurfaceLedger(), now, input.buildPlans, surfaceBuildPlans).matrix.include[0]
        if (expected?.contractFingerprint === surface.contractFingerprint) currentSurfaceCaseIds.add(surface.caseId)
      }
    }
    for (const { cell, report } of adapters) {
      const sourceCaseId = caseIdByNodeMajor.get(cell.nodeMajor)
      cells.push({ caseId: cell.id, ...(sourceCaseId === undefined ? {} : { sourceCaseId }), evidenceSource: 'adapter-ledger',
        artifact: { spec: cell.plugin, ...(report.artifact === undefined ? {} : { sha256: report.artifact.sha256 }) },
        dsh: { package: '@deepseek-ai/dsh', version: cell.dshVersion },
        runtime: { nodeMajor: cell.nodeMajor, nodeVersion: report.runtime.nodeVersion, platform: cell.platform, architecture: cell.architecture },
        executionPlane: cell.adapter, profile: cell.profile, versionRole: cell.versionRole, evidenceScope: 'adapter-initialize-only',
        coverageGaps: [...report.coverageGaps],
        dependencyGraphDigests: { ...(report.profileGraph === undefined ? {} : { profile: report.profileGraph.digest }),
          ...(report.applicationGraph === undefined ? {} : { application: report.applicationGraph.digest }) },
        status: report.result === 'initialize-compatible' ? 'observed-compatible'
          : report.result === 'initialize-failed' ? 'observed-incompatible' : 'needs-review',
        radarResult: report.result, observedAt: report.completedAt,
        recheckDueAt: dueAt(report.completedAt, installTargets.refreshAfterHours), reason: report.reason })
    }
    cells.sort((left, right) => {
      return PLANE_ORDER[left.executionPlane] - PLANE_ORDER[right.executionPlane]
        || left.caseId.localeCompare(right.caseId)
    })
    const distribution = observedDistribution(plugin)
    const cellIsCurrent = (cell: DshDirectoryEvidenceCell): boolean => cell.evidenceSource === 'adapter-ledger'
      || currentNativeCaseIds.has(cell.sourceCaseId ?? cell.caseId)
        && (cell.evidenceSource !== 'surface-ledger' || currentSurfaceCaseIds.has(cell.caseId))
        && now.getTime() >= Date.parse(cell.observedAt)
        && now.getTime() - Date.parse(cell.observedAt) < installTargets.refreshAfterHours * 3_600_000
    const environmentRecommendation = installTarget === undefined
      || (!installTargets.environmentRecommendationsRequired && recommendation === undefined)
      ? undefined
      : recommendation === undefined
        ? {
            status: 'missing' as const,
            nodeMajors: [],
            executionProfiles: [],
            expectedCells: [],
            missingCells: ['repository-environment-recommendation'],
            coverageGaps: [],
          }
        : (() => {
            const selectedArtifact = distribution.kind === 'npm'
              ? `${distribution.name}@${distribution.selectedVersion}`
              : installTarget.spec
            const expectedCells: string[] = []
            const missingCells: string[] = []
            for (const nodeMajor of recommendation.nodeMajors) {
              const sourceCaseId = caseIdByNodeMajor.get(nodeMajor)
                ?? dshCompatibilityCaseId(installTarget.id, `node${nodeMajor}`)
              for (const plane of recommendation.executionProfiles) {
                const adapter = plane === 'sdk' || plane === 'acp'
                const versions = new Set([selectedDshVersion, ...recommendation.authorEnvironment?.dshVersions.map(item => item.version) ?? []])
                for (const version of versions) {
                  const expectedCell = `${sourceCaseId}:${plane}${version === selectedDshVersion ? '' : `:dsh-${version}`}`
                  const nativeCaseId = desiredNativeCases.find(cell => cell.targetId === installTarget.id
                    && cell.nodeMajor === nodeMajor && cell.dshVersion === version)?.id
                  expectedCells.push(expectedCell)
                  const covered = cells.some(cell => (
                    cell.artifact.spec === selectedArtifact
                    && cellIsCurrent(cell)
                    && cell.startupConfiguration === undefined
                    && cell.dsh.version === version
                    && cell.runtime.nodeMajor === nodeMajor
                    && (plane === 'headless'
                      ? cell.evidenceSource === 'compatibility-ledger'
                        && cell.caseId === nativeCaseId
                      : cell.evidenceSource === (adapter ? 'adapter-ledger' : 'surface-ledger')
                        && cell.sourceCaseId === (adapter ? sourceCaseId : nativeCaseId)
                        && cell.executionPlane === plane)
                  ))
                  if (!covered) missingCells.push(expectedCell)
                }
              }
            }
            return {
              status: 'current' as const,
              preferredNodeMajor: recommendation.preferredNodeMajor,
              nodeMajors: [...recommendation.nodeMajors],
              executionProfiles: [...recommendation.executionProfiles],
              expectedCells,
              missingCells,
              coverageGaps: [...new Set([...(recommendation.coverageGaps ?? []),
                ...adapters.flatMap(entry => entry.report.coverageGaps),
                ...desiredAdapters.blocked.filter(entry => entry.targetId === installTarget.id).map(entry => entry.reason)])],
              sourceFingerprint: recommendation.sourceFingerprint,
              summary: recommendation.summary,
              evidence: [...recommendation.evidence],
            }
          })()
    const exactCellStatus = aggregateStatus(distribution, recommendation === undefined ? cells : cells.filter(cellIsCurrent), selectedDshVersion)
    const status = environmentRecommendation?.status === 'missing'
      ? 'needs-review'
      : ((environmentRecommendation?.missingCells.length ?? 0) > 0
          || (environmentRecommendation?.coverageGaps.length ?? 0) > 0)
        ? exactCellStatus === 'observed-incompatible' ? exactCellStatus : 'needs-review'
        : exactCellStatus
    return {
      id: plugin.id,
      repository: plugin.repository,
      repositoryUrl: `https://github.com/${plugin.repository}`,
      catalogUrl: plugin.catalogUrl,
      catalogEntry: plugin.catalogEntry,
      catalogEntryUrl: `https://github.com/${cohort.source.repository}/blob/${cohort.source.commit}/${plugin.catalogEntry}`,
      category: plugin.category,
      distribution,
      status,
      cells,
      ...(environmentRecommendation === undefined ? {} : { environmentRecommendation }),
      evidenceUrl: `${repositoryBaseUrl}/blob/main/compatibility-ledger.json`,
      ...(cells.some(cell => cell.evidenceSource === 'surface-ledger')
        ? { surfaceEvidenceUrl: `${repositoryBaseUrl}/blob/main/surface-ledger.json` }
        : {}),
      ...(adapters.length === 0 ? {} : { adapterEvidenceUrl: `${repositoryBaseUrl}/blob/main/adapter-ledger.json` }),
    }
  }).sort((left, right) => left.repository.localeCompare(right.repository))

  const summary: DshDirectoryCompatibilityFeed['summary'] = {
    total: plugins.length,
    'observed-compatible': 0,
    'observed-incompatible': 0,
    'needs-review': 0,
    'update-pending': 0,
    'not-observed': 0,
  }
  for (const plugin of plugins) summary[plugin.status] += 1

  const executionPlanes = [...new Set(plugins.flatMap(plugin => plugin.cells.map(cell => cell.executionPlane)))]
    .sort((left, right) => PLANE_ORDER[left] - PLANE_ORDER[right])
  const profiles = [...new Set(plugins.flatMap(plugin => plugin.cells.map(cell => cell.profile)))].sort()

  return {
    schema: DSH_DIRECTORY_COMPATIBILITY_FEED_SCHEMA,
    generatedAt,
    producer: { name: 'upstream-radar', version: TOOL_VERSION, repository: repositoryBaseUrl, license: 'Apache-2.0' },
    ...(selectedDshVersion === undefined ? {} : {
      selectedHost: { package: '@deepseek-ai/dsh' as const, version: selectedDshVersion },
    }),
    sourceCatalog: cohort.source,
    boundary: {
      claim: 'exact-cell compatibility evidence; not a security review, endorsement, or timeless compatibility badge',
      executionPlanes,
      profiles,
      isolation: 'fresh GitHub-hosted VM plus restricted container',
      consumptionRule: 'A plugin status applies only when a cell exactly matches the selected artifact and every current repository-recommended Node/profile cell is covered. Treat a missing recommendation, a missing recommended cell, update-pending, needs-review and not-observed as neither pass nor fail, and treat a cell as stale after recheckDueAt.',
      refreshAfterHours: installTargets.refreshAfterHours,
    },
    summary,
    plugins,
  }
}

function markdown(value: string): string {
  return value.replace(/[|<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
}

function cellCoordinate(entry: DshDirectoryCompatibilityEntry): string {
  if (entry.cells.length === 0) return '—'
  return entry.cells.map(cell => `\`${markdown(cell.artifact.spec)}\``).join('<br>')
}

function selectedCoordinate(entry: DshDirectoryCompatibilityEntry): string {
  if (entry.distribution.kind !== 'npm') return '—'
  return `\`${markdown(`${entry.distribution.name}@${entry.distribution.selectedVersion}`)}\``
}

function dshCoordinate(entry: DshDirectoryCompatibilityEntry): string {
  if (entry.cells.length === 0) return '—'
  return entry.cells.map(cell => {
    const startup = cell.startupConfiguration
    const scope = startup === undefined ? '' : ` / additional: ${markdown(startup.scope)} (${markdown(Object.entries(startup.environment).map(([key, value]) => `${key}=${value}`).join(', '))})`
    const adapter = cell.evidenceScope === 'adapter-initialize-only' ? ` / initialize only (${cell.versionRole})` : ''
    return `\`${markdown(cell.dsh.version)}\` / Node ${cell.runtime.nodeMajor} / ${cell.executionPlane}${scope}${adapter}`
  }).join('<br>')
}

function observedCoordinate(entry: DshDirectoryCompatibilityEntry): string {
  if (entry.cells.length === 0) return '—'
  return entry.cells.map(cell => markdown(cell.observedAt)).join('<br>')
}

function recommendedEnvironment(entry: DshDirectoryCompatibilityEntry): string {
  const recommendation = entry.environmentRecommendation
  if (recommendation === undefined) return 'not required'
  if (recommendation.status === 'missing') return '`missing`'
  const nodes = recommendation.nodeMajors.map(major => `Node ${major}`).join(', ')
  const profiles = recommendation.executionProfiles.join(', ')
  const coverage = recommendation.missingCells.length === 0 && recommendation.coverageGaps.length === 0
    ? 'smoke cells covered'
    : `${recommendation.missingCells.length} missing cells, ${recommendation.coverageGaps.length} workflow/evidence gaps`
  return `${markdown(nodes)} / ${markdown(profiles)} (${coverage})`
}

export function renderDshDirectoryCompatibilityFeed(feed: DshDirectoryCompatibilityFeed): string {
  const lines = [
    '# DSH directory compatibility evidence',
    '',
    `Generated from catalog commit [\`${feed.sourceCatalog.commit.slice(0, 12)}\`](${feed.sourceCatalog.commitUrl}) at \`${feed.generatedAt}\`.`,
    ...(feed.selectedHost === undefined ? [] : [`Selected host: \`${feed.selectedHost.package}@${feed.selectedHost.version}\`.`]),
    '',
    `**${feed.summary['observed-compatible']} observed compatible · ${feed.summary['observed-incompatible']} observed incompatible · ${feed.summary['needs-review']} needs review · ${feed.summary['update-pending']} update pending · ${feed.summary['not-observed']} not observed**`,
    '',
    '| Catalog plugin | Selected artifact | Recommended environment | Tested artifact | Exact DSH / runtime | Evidence status | Observed |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const entry of feed.plugins) {
    lines.push(`| [${markdown(entry.repository)}](${entry.catalogUrl}) | ${selectedCoordinate(entry)} | ${recommendedEnvironment(entry)} | ${cellCoordinate(entry)} | ${dshCoordinate(entry)} | \`${entry.status}\` | ${observedCoordinate(entry)} |`)
  }
  lines.push(
    '',
    '## Reading the status',
    '',
    '- `observed-compatible`: every currently required exact cell passed; a plane-specific pass may cover only a headless gap made exclusively of that plane\'s client packages.',
    '- `observed-incompatible`: the exact cell reproduced a runtime gate, install, registration or load failure.',
    '- `needs-review`: the repository environment recommendation is missing, one of its Node/profile cells is uncovered, or existing evidence cannot yet separate a plugin defect from an environment condition or explicit dependency-build approval gate.',
    '- `update-pending`: the selected npm artifact changed and has no exact cell yet; historical evidence is retained but never inherited as the current result.',
    '- `not-observed`: the catalog entry is monitored statically but has no matching executable npm artifact in this cohort.',
    '- Additional disabled/offline startup comparisons retain their exact flags and limited scope; they never satisfy a missing default-startup requirement.',
    '- SDK/ACP evidence covers adapter initialization only, with separate author-baseline and target DSH results. It does not prove authentication, model generation or real user tasks; those untested boundaries remain explicit.',
    '',
    `A cell expires at its \`recheckDueAt\` value (${feed.boundary.refreshAfterHours} hours after observation). Consumers must then show it as stale. This is exact compatibility evidence, not a security review or endorsement.`,
    '',
    `[Machine-readable feed](dsh-plugin-compatibility.json) · [Headless ledger](${feed.producer.repository}/blob/main/compatibility-ledger.json) · [Web/TUI ledger](${feed.producer.repository}/blob/main/surface-ledger.json) · [SDK/ACP ledger](${feed.producer.repository}/blob/main/adapter-ledger.json)`,
    '',
  )
  return lines.join('\n')
}
