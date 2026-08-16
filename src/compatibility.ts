import { createHash } from 'node:crypto'
import { compareSemverValues, crossesBreakingVersionBoundary, satisfiesSemverRange } from './semver.js'
import {
  RADAR_EVENT_SCHEMA,
  type CompatibilityDependencyCheck,
  type CompatibilityDependencyStatus,
  type CompatibilityEvent,
  type CompatibilityRemediationCoverage,
  type CompatibilityUpgradeCandidate,
  type CompatibilityUpgradePath,
  type CompatibilityVulnerabilityRemediation,
  type CompatibilityVulnerabilityStatus,
  type CompatibilitySignal,
  type PackageManifestSnapshot,
  type PluginInstallation,
  type ProjectInventory,
  type VulnerabilityAdvisory,
  type VulnerabilityEvent,
} from './radar-types.js'
import { packageKey } from './osv.js'

export interface CompatibilityChangeInput {
  previous: PackageManifestSnapshot
  candidate: PackageManifestSnapshot
  releaseNotes?: string
  releaseNotesUrl?: string
  /** Exact newer manifests from the same npm packument, used only for deterministic candidate ranking. */
  upgradeCandidates?: readonly PackageManifestSnapshot[]
  /** Exact OSV results for candidate versions, keyed by npm package coordinate. */
  candidateVulnerabilities?: ReadonlyMap<string, readonly VulnerabilityAdvisory[]>
  candidateVulnerabilityStatus?: CompatibilityVulnerabilityStatus
  /** OSV results for the bounded transitive graphs of candidate versions. */
  candidateDependencyChecks?: ReadonlyMap<string, CompatibilityDependencyCheck>
  candidateDependencyStatus?: CompatibilityDependencyStatus
  /** Active vulnerability events for this installed plugin, used only for candidate remediation evidence. */
  activeVulnerabilities?: readonly VulnerabilityEvent[]
  detectedAt: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

function text(value: unknown): string {
  const rendered = canonical(value)
  return rendered.length <= 2_048 ? rendered : `${rendered.slice(0, 2_047)}…`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function changedSignal(
  signals: CompatibilitySignal[],
  code: string,
  summary: string,
  before: unknown,
  after: unknown,
): void {
  if (canonical(before) === canonical(after)) return
  signals.push({ code, confidence: 'needs-analysis', summary, before: text(before), after: text(after) })
}

function collectCompatibilitySignals(
  inventory: ProjectInventory,
  installation: PluginInstallation,
  previous: PackageManifestSnapshot,
  candidate: PackageManifestSnapshot,
  releaseNotes?: string,
  candidateVulnerabilities: readonly VulnerabilityAdvisory[] = [],
  candidateDependencyCheck?: CompatibilityDependencyCheck,
): CompatibilitySignal[] {
  const signals: CompatibilitySignal[] = []
  if (crossesBreakingVersionBoundary(previous.version, candidate.version)) {
    signals.push({
      code: 'breaking-version-boundary',
      confidence: 'strong',
      summary: `Version ${previous.version} to ${candidate.version} crosses a semantic-version compatibility boundary.`,
      before: previous.version,
      after: candidate.version,
    })
  }
  if (releaseNotes !== undefined && /\bbreaking(?:[ _-]change)?\b|不兼容|破坏性变更/i.test(releaseNotes)) {
    signals.push({
      code: 'publisher-declared-breaking-change',
      confidence: 'confirmed',
      summary: 'The publisher explicitly describes this release as breaking.',
    })
  }
  changedSignal(signals, 'package-entrypoint-changed', 'The package entrypoint or export map changed.', {
    type: previous.type,
    main: previous.main,
    exports: previous.exports,
  }, {
    type: candidate.type,
    main: candidate.main,
    exports: candidate.exports,
  })
  changedSignal(signals, 'dsh-bundle-changed', 'The DSH bundle declaration changed.', previous.dsh, candidate.dsh)

  const previousNodeRange = previous.engines?.node
  const candidateNodeRange = candidate.engines?.node
  if (previousNodeRange !== candidateNodeRange) {
    signals.push({
      code: 'node-engine-requirement-changed',
      confidence: 'needs-analysis',
      summary: 'The supported Node.js range changed.',
      ...(previousNodeRange === undefined ? {} : { before: previousNodeRange }),
      ...(candidateNodeRange === undefined ? {} : { after: candidateNodeRange }),
    })
  }
  const installedNode = inventory.environment?.nodeVersion
  if (installedNode !== undefined && candidateNodeRange !== undefined
    && satisfiesSemverRange(installedNode, candidateNodeRange) === false) {
    signals.push({
      code: 'node-runtime-incompatible',
      confidence: 'strong',
      summary: `The project runs Node.js ${installedNode}, outside the candidate requirement ${candidateNodeRange}.`,
      before: installedNode,
      after: candidateNodeRange,
    })
  }

  const previousPeers = previous.peerDependencies ?? {}
  const candidatePeers = candidate.peerDependencies ?? {}
  for (const [name, range] of Object.entries(candidatePeers).sort(([left], [right]) => left.localeCompare(right))) {
    if (!(name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis')) continue
    const installed = installation.graph.nodes
      .filter(node => node.name === name)
      .map(node => node.version)
      .sort()[0]
    if (installed !== undefined && satisfiesSemverRange(installed, range) === false) {
      signals.push({
        code: 'dsh-peer-incompatible',
        confidence: 'strong',
        summary: `${name}@${installed} does not satisfy the candidate peer requirement ${range}.`,
        before: installed,
        after: range,
      })
    } else if (installed === undefined) {
      signals.push({
        code: 'dsh-peer-not-observed',
        confidence: 'needs-analysis',
        summary: `The candidate requires ${name}@${range}, but that package is not present in the captured graph.`,
        after: range,
      })
    }
    if (previousPeers[name] !== range) {
      signals.push({
        code: 'dsh-peer-range-changed',
        confidence: 'needs-analysis',
        summary: `The declared compatibility range for ${name} changed.`,
        ...(previousPeers[name] === undefined ? {} : { before: previousPeers[name] }),
        after: range,
      })
    }
  }

  const previousDependencies = { ...previous.dependencies, ...previous.optionalDependencies }
  const candidateDependencies = { ...candidate.dependencies, ...candidate.optionalDependencies }
  for (const [name, range] of Object.entries(previousDependencies)) {
    if (candidateDependencies[name] !== undefined) continue
    signals.push({
      code: 'dependency-removed',
      confidence: 'needs-analysis',
      summary: `The candidate no longer declares dependency ${name}.`,
      before: range,
    })
  }

  if (candidate.name.startsWith('@deepseek-ai/dsh-')
    && previous.version.startsWith('0.')
    && previous.version !== candidate.version) {
    signals.push({
      code: 'dsh-developer-preview-change',
      confidence: 'strong',
      summary: 'A pre-1.0 DSH package changed; compatibility must be verified against installed plugins.',
      before: previous.version,
      after: candidate.version,
    })
  }

  const pluginDeclaredRange = installation.manifest?.peerDependencies?.[candidate.name]
  if (pluginDeclaredRange !== undefined
    && satisfiesSemverRange(candidate.version, pluginDeclaredRange) === false) {
    signals.push({
      code: 'plugin-dsh-range-incompatible',
      confidence: 'strong',
      summary: `${installation.package.name}@${installation.package.version} declares ${candidate.name}@${pluginDeclaredRange}, which excludes ${candidate.version}.`,
      before: pluginDeclaredRange,
      after: candidate.version,
    })
  }
  for (const advisory of [...candidateVulnerabilities].sort((left, right) => left.id.localeCompare(right.id))) {
    signals.push({
      code: 'known-vulnerability',
      confidence: 'confirmed',
      summary: `OSV reports ${advisory.id} (${advisory.severity}) for this candidate version.`,
      before: advisory.id,
      ...(advisory.fixedVersions.length === 0 ? {} : { after: `fixed: ${advisory.fixedVersions.slice(0, 8).join(', ')}` }),
    })
  }
  if (candidateDependencyCheck !== undefined) {
    for (const finding of [...candidateDependencyCheck.findings]
      .sort((left, right) => packageKey(left.package).localeCompare(packageKey(right.package)) || left.advisory.id.localeCompare(right.advisory.id))) {
      const path = finding.paths[0]
      signals.push({
        code: 'candidate-dependency-vulnerability',
        confidence: 'confirmed',
        summary: `OSV reports ${finding.advisory.id} (${finding.advisory.severity}) for transitive dependency ${finding.package.name}@${finding.package.version}.`,
        before: finding.advisory.id,
        ...(path === undefined ? {} : { after: path.map(item => `${item.name}@${item.version}`).join(' -> ') }),
      })
    }
    if (candidateDependencyCheck.status === 'incomplete') {
      signals.push({
        code: 'candidate-dependency-graph-incomplete',
        confidence: 'needs-analysis',
        summary: `The candidate dependency graph has ${candidateDependencyCheck.unresolvedCount} unresolved dependency edge(s); it cannot be treated as fully checked.`,
      })
    } else if (candidateDependencyCheck.status === 'unavailable') {
      signals.push({
        code: 'candidate-dependency-check-unavailable',
        confidence: 'needs-analysis',
        summary: 'The candidate dependency graph or its vulnerability query was unavailable; transitive dependency risk is unknown.',
      })
    }
  }
  return signals
}

function isDeterministicallyBlocked(signals: readonly CompatibilitySignal[]): boolean {
  return signals.some(signal => signal.confidence === 'confirmed' || signal.confidence === 'strong')
}

function advisoryIdentifiers(advisory: VulnerabilityAdvisory): Set<string> {
  return new Set([advisory.id, ...advisory.aliases])
}

function advisoriesMatch(left: VulnerabilityAdvisory, right: VulnerabilityAdvisory): boolean {
  const leftIds = advisoryIdentifiers(left)
  for (const identifier of advisoryIdentifiers(right)) {
    if (leftIds.has(identifier)) return true
  }
  return false
}

function remediationCoverage(
  activeVulnerabilities: readonly VulnerabilityEvent[],
  previous: PackageManifestSnapshot,
  vulnerabilityStatus: CompatibilityVulnerabilityStatus,
  dependencyStatus: CompatibilityDependencyStatus,
  findingsTruncated: boolean,
): CompatibilityRemediationCoverage | undefined {
  if (activeVulnerabilities.length === 0) return undefined
  if (vulnerabilityStatus === 'unavailable') return 'unavailable'
  if (activeVulnerabilities.some(event => event.affectedSources?.includes('dsh-host') === true)) return 'unavailable'
  if (findingsTruncated) return 'partial'
  const hasTransitiveIncident = activeVulnerabilities.some(event => event.affected.name !== previous.name)
  if (hasTransitiveIncident) {
    if (dependencyStatus === 'unavailable') return 'unavailable'
    if (dependencyStatus === 'partial') return 'partial'
    if (dependencyStatus === 'not-requested') return 'not-requested'
  }
  if (dependencyStatus !== 'not-requested') return dependencyStatus
  return vulnerabilityStatus === 'checked' ? 'checked' : 'not-requested'
}

function assessVulnerabilityRemediation(
  active: VulnerabilityEvent,
  candidate: PackageManifestSnapshot,
  candidateVulnerabilities: readonly VulnerabilityAdvisory[],
  vulnerabilityStatus: CompatibilityVulnerabilityStatus,
  candidateDependencyCheck: CompatibilityDependencyCheck | undefined,
): CompatibilityVulnerabilityRemediation {
  const base = {
    incidentId: active.incidentId,
    advisoryId: active.advisory.id,
    affected: { ...active.affected },
  }

  // A plugin release cannot prove that it removes a path supplied by DSH's
  // shared host runtime. Keep the result unknown instead of treating a clean
  // plugin-local graph as proof that the host path disappeared.
  if (active.affectedSources?.includes('dsh-host') === true) {
    return {
      ...base,
      status: 'unknown',
      reason: 'The active vulnerability includes a DSH host-runtime path; this plugin candidate does not prove that shared host path is removed.',
    }
  }

  if (candidateDependencyCheck !== undefined) {
    if (candidateDependencyCheck.status !== 'checked') {
      return {
        ...base,
        status: 'unknown',
        reason: `The candidate dependency graph is ${candidateDependencyCheck.status}; all affected paths cannot be checked.`,
      }
    }
    if (candidateDependencyCheck.findingsTruncated === true) {
      return {
        ...base,
        status: 'unknown',
        reason: 'The candidate vulnerability findings were truncated by the bounded result limit; absence is not proof that every path was removed.',
      }
    }
    const matches = candidateDependencyCheck.findings.filter(finding => advisoriesMatch(active.advisory, finding.advisory))
    if (matches.length > 0) {
      const paths = [...new Map(
        matches.flatMap(finding => finding.paths.map(path => [JSON.stringify(path), path] as const)),
      ).values()].slice(0, 4)
      return {
        ...base,
        status: 'still-affected',
        reason: `The complete candidate graph still contains a path matched to ${active.advisory.id}.`,
        ...(paths.length === 0 ? {} : { remainingPaths: paths }),
      }
    }
    return {
      ...base,
      status: 'removed',
      reason: `The complete candidate graph has no OSV finding matching ${active.advisory.id}.`,
    }
  }

  // Without a candidate graph, only a vulnerability on the candidate's own
  // package can be checked from the direct OSV query. Transitive removal is
  // deliberately unknown.
  if (active.affected.name !== candidate.name || vulnerabilityStatus !== 'checked') {
    return {
      ...base,
      status: 'unknown',
      reason: active.affected.name === candidate.name
        ? 'The direct candidate vulnerability query is incomplete or unavailable.'
        : 'No complete candidate dependency graph was provided for this transitive path.',
    }
  }
  const matches = candidateVulnerabilities.filter(advisory => advisoriesMatch(active.advisory, advisory))
  if (matches.length > 0) {
    return {
      ...base,
      status: 'still-affected',
      reason: `The candidate package is still matched to ${active.advisory.id}.`,
    }
  }
  return {
    ...base,
    status: 'removed',
    reason: `The complete direct OSV query has no finding matching ${active.advisory.id}.`,
  }
}

function assessUpgradePath(
  inventory: ProjectInventory,
  installation: PluginInstallation,
  previous: PackageManifestSnapshot,
  latestCandidate: PackageManifestSnapshot,
  candidates: readonly PackageManifestSnapshot[],
  releaseNotes?: string,
  candidateVulnerabilities: ReadonlyMap<string, readonly VulnerabilityAdvisory[]> = new Map(),
  vulnerabilityStatus: CompatibilityVulnerabilityStatus = 'not-requested',
  candidateDependencyChecks: ReadonlyMap<string, CompatibilityDependencyCheck> = new Map(),
  dependencyStatus: CompatibilityDependencyStatus = 'not-requested',
  activeVulnerabilities: readonly VulnerabilityEvent[] = [],
): CompatibilityUpgradePath | undefined {
  const unique = new Map<string, PackageManifestSnapshot>()
  for (const candidate of candidates) {
    if (candidate.name !== previous.name) continue
    const order = compareSemverValues(candidate.version, previous.version)
    if (order === undefined || order <= 0) continue
    unique.set(candidate.version, candidate)
  }
  const ordered = [...unique.values()].sort((left, right) => (
    compareSemverValues(left.version, right.version) ?? left.version.localeCompare(right.version)
  ))
  if (ordered.length === 0) return undefined

  let firstCandidate: CompatibilityUpgradeCandidate | undefined
  let firstCandidateRemovingAllPaths: CompatibilityUpgradeCandidate | undefined
  const blocked: CompatibilityUpgradeCandidate[] = []
  let blockedCount = 0
  const findingsTruncated = ordered.some(candidate => candidateDependencyChecks.get(packageKey({
    ecosystem: 'npm',
    name: candidate.name,
    version: candidate.version,
  }))?.findingsTruncated === true)
  const coverage = remediationCoverage(activeVulnerabilities, previous, vulnerabilityStatus, dependencyStatus, findingsTruncated)
  for (const candidate of ordered) {
    const signals = collectCompatibilitySignals(
      inventory,
      installation,
      previous,
      candidate,
      candidate.version === latestCandidate.version ? releaseNotes : undefined,
      candidateVulnerabilities.get(packageKey({ ecosystem: 'npm', name: candidate.name, version: candidate.version })) ?? [],
      candidateDependencyChecks.get(packageKey({ ecosystem: 'npm', name: candidate.name, version: candidate.version })),
    )
    const dependencyCheck = candidateDependencyChecks.get(packageKey({
      ecosystem: 'npm',
      name: candidate.name,
      version: candidate.version,
    }))
    const assessed: CompatibilityUpgradeCandidate = {
      candidate: { ecosystem: 'npm', name: candidate.name, version: candidate.version },
      signals,
      ...(dependencyCheck === undefined ? {} : { dependencyCheck }),
    }
    const remediations = activeVulnerabilities.map(active => assessVulnerabilityRemediation(
      active,
      candidate,
      candidateVulnerabilities.get(packageKey({ ecosystem: 'npm', name: candidate.name, version: candidate.version })) ?? [],
      vulnerabilityStatus,
      dependencyCheck,
    ))
    if (remediations.length > 0) assessed.vulnerabilityRemediation = remediations
    if (isDeterministicallyBlocked(signals)) {
      blockedCount += 1
      if (blocked.length < 8) blocked.push(assessed)
    } else {
      if (firstCandidate === undefined
        && vulnerabilityStatus !== 'unavailable'
        && dependencyStatus !== 'unavailable'
        && (dependencyCheck === undefined
          ? dependencyStatus === 'not-requested'
          : dependencyCheck.status === 'checked')) {
        firstCandidate = assessed
      }
      if (firstCandidateRemovingAllPaths === undefined
        && remediations.length > 0
        && remediations.every(remediation => remediation.status === 'removed')) {
        firstCandidateRemovingAllPaths = assessed
      }
    }
  }
  const uncheckedCount = dependencyStatus === 'not-requested'
    ? 0
    : ordered.filter(candidate => candidateDependencyChecks.get(packageKey({
      ecosystem: 'npm',
      name: candidate.name,
      version: candidate.version,
    }))?.status !== 'checked').length
  return {
    evaluated: ordered.length,
    blockedCount,
    vulnerabilityStatus,
    dependencyStatus,
    uncheckedCount,
    ...(firstCandidate === undefined ? {} : { firstCandidate }),
    ...(coverage === undefined ? {} : { remediationCoverage: coverage }),
    ...(firstCandidateRemovingAllPaths === undefined ? {} : { firstCandidateRemovingAllPaths }),
    blocked,
  }
}

/** Find deterministic incompatibilities and high-value change signals before asking a model. */
export function assessCompatibilityChange(
  inventory: ProjectInventory,
  change: CompatibilityChangeInput,
): CompatibilityEvent | undefined {
  return assessCompatibilityChanges(inventory, change)[0]
}

/** Assess one upstream package update against every installed plugin that contains it. */
export function assessCompatibilityChanges(
  inventory: ProjectInventory,
  change: CompatibilityChangeInput,
): CompatibilityEvent[] {
  if (change.previous.name !== change.candidate.name) throw new Error('compatibility comparison requires the same package name')
  if (!Number.isFinite(Date.parse(change.detectedAt))) throw new Error('compatibility change has an invalid detection time')
  const versionOrder = compareSemverValues(change.candidate.version, change.previous.version)
  if (versionOrder !== undefined && versionOrder <= 0) return []
  const installations = inventory.plugins.filter(plugin => plugin.graph.nodes.some(node => (
    node.name === change.previous.name && node.version === change.previous.version
  )))
  if (installations.length === 0) return []

  return installations.flatMap((installation) => {
    const signals = collectCompatibilitySignals(
      inventory,
      installation,
      change.previous,
      change.candidate,
      change.releaseNotes,
      change.candidateVulnerabilities?.get(packageKey({ ecosystem: 'npm', name: change.candidate.name, version: change.candidate.version })) ?? [],
      change.candidateDependencyChecks?.get(packageKey({
        ecosystem: 'npm',
        name: change.candidate.name,
        version: change.candidate.version,
      })),
    )

    if (signals.length === 0) return []
    const upgradePath = change.upgradeCandidates === undefined
      ? undefined
      : assessUpgradePath(
        inventory,
        installation,
        change.previous,
        change.candidate,
        change.upgradeCandidates,
        change.releaseNotes,
        change.candidateVulnerabilities ?? new Map(),
        change.candidateVulnerabilityStatus ?? 'not-requested',
        change.candidateDependencyChecks ?? new Map(),
        change.candidateDependencyStatus ?? 'not-requested',
        (change.activeVulnerabilities ?? []).filter(event => (
          event.project.id === inventory.project.id
          && event.plugin.name === installation.package.name
          && event.plugin.version === installation.package.version
        )),
      )
    const eventSeed = [inventory.project.id, installation.package.name, installation.package.version, change.previous.name, change.previous.version, change.candidate.version, change.detectedAt].join('\0')
    const incidentSeed = [inventory.project.id, installation.package.name, installation.package.version, change.previous.name, change.previous.version].join('\0')
    return [{
      schema: RADAR_EVENT_SCHEMA,
      id: `event-${hash(eventSeed)}`,
      incidentId: `incident-${hash(incidentSeed)}`,
      kind: 'compatibility',
      change: 'new',
      detectedAt: new Date(change.detectedAt).toISOString(),
      project: { ...inventory.project },
      route: {
        ...(inventory.project.owner === undefined ? {} : { owner: inventory.project.owner }),
        channels: inventory.project.channels === undefined || inventory.project.channels.length === 0
          ? ['stdout']
          : [...inventory.project.channels],
      },
      plugin: { ...installation.package },
      installed: {
        ecosystem: 'npm',
        name: change.previous.name,
        version: change.previous.version,
      },
      candidate: {
        ecosystem: 'npm',
        name: change.candidate.name,
        version: change.candidate.version,
      },
      signals,
      ...(upgradePath === undefined ? {} : { upgradePath }),
      ...(change.releaseNotes === undefined ? {} : { releaseNotes: change.releaseNotes.slice(0, 64 * 1_024) }),
      ...(change.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: change.releaseNotesUrl.slice(0, 4_096) }),
    }]
  })
}
