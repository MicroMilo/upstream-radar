import { createHash } from 'node:crypto'
import { compareSemverValues, crossesBreakingVersionBoundary, satisfiesSemverRange } from './semver.js'
import {
  RADAR_EVENT_SCHEMA,
  type CompatibilityEvent,
  type CompatibilitySignal,
  type PackageManifestSnapshot,
  type ProjectInventory,
} from './radar-types.js'

export interface CompatibilityChangeInput {
  previous: PackageManifestSnapshot
  candidate: PackageManifestSnapshot
  releaseNotes?: string
  releaseNotesUrl?: string
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

  const signals: CompatibilitySignal[] = []
  if (crossesBreakingVersionBoundary(change.previous.version, change.candidate.version)) {
    signals.push({
      code: 'breaking-version-boundary',
      confidence: 'strong',
      summary: `Version ${change.previous.version} to ${change.candidate.version} crosses a semantic-version compatibility boundary.`,
      before: change.previous.version,
      after: change.candidate.version,
    })
  }
  if (change.releaseNotes !== undefined && /\bbreaking(?:[ _-]change)?\b|不兼容|破坏性变更/i.test(change.releaseNotes)) {
    signals.push({
      code: 'publisher-declared-breaking-change',
      confidence: 'confirmed',
      summary: 'The publisher explicitly describes this release as breaking.',
    })
  }
  changedSignal(signals, 'package-entrypoint-changed', 'The package entrypoint or export map changed.', {
    type: change.previous.type,
    main: change.previous.main,
    exports: change.previous.exports,
  }, {
    type: change.candidate.type,
    main: change.candidate.main,
    exports: change.candidate.exports,
  })
  changedSignal(signals, 'dsh-bundle-changed', 'The DSH bundle declaration changed.', change.previous.dsh, change.candidate.dsh)

  const previousNodeRange = change.previous.engines?.node
  const candidateNodeRange = change.candidate.engines?.node
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

  const previousPeers = change.previous.peerDependencies ?? {}
  const candidatePeers = change.candidate.peerDependencies ?? {}
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

  const previousDependencies = { ...change.previous.dependencies, ...change.previous.optionalDependencies }
  const candidateDependencies = { ...change.candidate.dependencies, ...change.candidate.optionalDependencies }
  for (const [name, range] of Object.entries(previousDependencies)) {
    if (candidateDependencies[name] !== undefined) continue
    signals.push({
      code: 'dependency-removed',
      confidence: 'needs-analysis',
      summary: `The candidate no longer declares dependency ${name}.`,
      before: range,
    })
  }

  if (change.candidate.name.startsWith('@deepseek-ai/dsh-')
    && change.previous.version.startsWith('0.')
    && change.previous.version !== change.candidate.version) {
    signals.push({
      code: 'dsh-developer-preview-change',
      confidence: 'strong',
      summary: 'A pre-1.0 DSH package changed; compatibility must be verified against installed plugins.',
      before: change.previous.version,
      after: change.candidate.version,
    })
  }

  const pluginDeclaredRange = installation.manifest?.peerDependencies?.[change.candidate.name]
  if (pluginDeclaredRange !== undefined
    && satisfiesSemverRange(change.candidate.version, pluginDeclaredRange) === false) {
    signals.push({
      code: 'plugin-dsh-range-incompatible',
      confidence: 'strong',
      summary: `${installation.package.name}@${installation.package.version} declares ${change.candidate.name}@${pluginDeclaredRange}, which excludes ${change.candidate.version}.`,
      before: pluginDeclaredRange,
      after: change.candidate.version,
    })
  }

  if (signals.length === 0) return []
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
    ...(change.releaseNotes === undefined ? {} : { releaseNotes: change.releaseNotes.slice(0, 64 * 1_024) }),
    ...(change.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: change.releaseNotesUrl.slice(0, 4_096) }),
  }]
  })
}
