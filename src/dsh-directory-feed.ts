import { parseDshCompatibilityLedger, type DshCompatibilityLedgerEntry } from './dsh-compatibility-ledger.js'
import { parseDshInstallTargets } from './dsh-install-plan.js'
import { parseNpmSpec } from './npm.js'
import { TOOL_VERSION } from './version.js'

export const AWESOME_DSH_COHORT_SCHEMA = 'upstream-radar.awesome-dsh-cohort/v1alpha1' as const
export const DSH_DIRECTORY_COMPATIBILITY_FEED_SCHEMA = 'upstream-radar.dsh-directory-compatibility-feed/v1alpha2' as const

const MAX_COHORT_PLUGINS = 100
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CATALOG_ENTRY = /^data\/plugins\/[A-Za-z0-9_.@-]+\.ya?ml$/

export type DshDirectoryEvidenceStatus =
  | 'observed-compatible'
  | 'observed-incompatible'
  | 'needs-review'
  | 'update-pending'
  | 'not-observed'

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
  executionPlane: 'headless'
  profile: 'headless'
  status: Exclude<DshDirectoryEvidenceStatus, 'not-observed' | 'update-pending'>
  radarResult: DshCompatibilityLedgerEntry['result']
  requiredDependencyBuilds?: string[]
  observedAt: string
  recheckDueAt: string
  reason: string
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
  evidenceUrl: string
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
    executionPlane: 'headless'
    profile: 'headless'
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
  observations?: unknown
  generatedAt: string
  repositoryBaseUrl?: string
}): DshDirectoryCompatibilityFeed {
  const cohort = parseAwesomeDshCohort(input.cohort)
  const installTargets = parseDshInstallTargets(input.installTargets)
  const ledger = parseDshCompatibilityLedger(input.ledger)
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
    const observations = installTarget === undefined
      ? []
      : ledger.entries.filter(entry => entry.targetId === installTarget.id)
    const cells = observations.map((entry): DshDirectoryEvidenceCell => ({
      caseId: entry.caseId,
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
      observedAt: entry.observedAt,
      recheckDueAt: dueAt(entry.observedAt, installTargets.refreshAfterHours),
      reason: entry.reason,
    })).sort((left, right) => left.caseId.localeCompare(right.caseId))
    const distribution = observedDistribution(plugin)
    return {
      id: plugin.id,
      repository: plugin.repository,
      repositoryUrl: `https://github.com/${plugin.repository}`,
      catalogUrl: plugin.catalogUrl,
      catalogEntry: plugin.catalogEntry,
      catalogEntryUrl: `https://github.com/${cohort.source.repository}/blob/${cohort.source.commit}/${plugin.catalogEntry}`,
      category: plugin.category,
      distribution,
      status: aggregateStatus(distribution, cells, selectedDshVersion),
      cells,
      evidenceUrl: `${repositoryBaseUrl}/blob/main/compatibility-ledger.json`,
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
      executionPlane: 'headless',
      profile: 'headless',
      isolation: 'fresh GitHub-hosted VM plus restricted container',
      consumptionRule: 'A plugin status applies only when a cell exactly matches the selected artifact. Treat update-pending, needs-review and not-observed as neither pass nor fail, and treat a cell as stale after recheckDueAt.',
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
  return entry.cells.map(cell => `\`${markdown(cell.dsh.version)}\` / Node ${cell.runtime.nodeMajor}`).join('<br>')
}

function observedCoordinate(entry: DshDirectoryCompatibilityEntry): string {
  if (entry.cells.length === 0) return '—'
  return entry.cells.map(cell => markdown(cell.observedAt)).join('<br>')
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
    '| Catalog plugin | Selected artifact | Tested artifact | Exact DSH / runtime | Evidence status | Observed |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const entry of feed.plugins) {
    lines.push(`| [${markdown(entry.repository)}](${entry.catalogUrl}) | ${selectedCoordinate(entry)} | ${cellCoordinate(entry)} | ${dshCoordinate(entry)} | \`${entry.status}\` | ${observedCoordinate(entry)} |`)
  }
  lines.push(
    '',
    '## Reading the status',
    '',
    '- `observed-compatible`: the exact artifact installed, registered and loaded in the stated headless cell.',
    '- `observed-incompatible`: the exact cell reproduced a runtime gate, install, registration or load failure.',
    '- `needs-review`: evidence exists, but Radar cannot yet separate a plugin defect from an uncovered execution plane, environment condition, or explicit dependency-build approval gate.',
    '- `update-pending`: the selected npm artifact changed and has no exact cell yet; historical evidence is retained but never inherited as the current result.',
    '- `not-observed`: the catalog entry is monitored statically but has no matching executable npm artifact in this cohort.',
    '',
    `A cell expires at its \`recheckDueAt\` value (${feed.boundary.refreshAfterHours} hours after observation). Consumers must then show it as stale. This is exact compatibility evidence, not a security review or endorsement.`,
    '',
    `[Machine-readable feed](dsh-plugin-compatibility.json) · [Full compatibility ledger](${feed.producer.repository}/blob/main/compatibility-ledger.json)`,
    '',
  )
  return lines.join('\n')
}
