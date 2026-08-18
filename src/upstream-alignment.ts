import type { DependencyGraph, PackageManifestSnapshot } from './radar-types.js'

/**
 * The small, machine-readable boundary between source and what downstream
 * users actually consume. It deliberately describes evidence and alignment;
 * it is not a security verdict.
 */
export const UPSTREAM_DOWNSTREAM_IR_SCHEMA = 'upstream-radar.upstream-downstream-ir/v1alpha1' as const

export type AlignmentStatus = 'aligned' | 'mismatch' | 'unknown'
export type AlignmentGraphStatus = 'complete' | 'incomplete' | 'unavailable'
export type AlignmentCheckCode =
  | 'source-published-identity'
  | 'source-graph-root'
  | 'published-graph-root'
  | 'dependency-graph-coverage'

export interface AlignmentCoordinate {
  name: string
  version: string
}

export interface AlignmentCheck {
  code: AlignmentCheckCode
  status: AlignmentStatus
  summary: string
  upstream?: string
  downstream?: string
  remediation?: string
}

export interface UpstreamDownstreamIR {
  schema: typeof UPSTREAM_DOWNSTREAM_IR_SCHEMA
  targetId: string
  ecosystem: 'dsh' | 'codex' | 'pi'
  upstream: {
    repository: string
    commit: string
    packagePath: string
    coordinate: AlignmentCoordinate
  }
  downstream: {
    published?: AlignmentCoordinate
    graph: {
      status: AlignmentGraphStatus
      root?: AlignmentCoordinate
      digest?: string
      nodes: number
      edges: number
      unresolved: number
    }
  }
  status: AlignmentStatus
  checks: AlignmentCheck[]
}

export interface UpstreamDownstreamAlignmentInput {
  targetId: string
  ecosystem: 'dsh' | 'codex' | 'pi'
  source: {
    repository: string
    commit: string
    packagePath: string
  }
  manifest: PackageManifestSnapshot
  package?: {
    name: string
    version: string
  }
  graph?: DependencyGraph
  graphError?: string
}

function coordinateText(value: AlignmentCoordinate | undefined): string {
  return value === undefined ? 'unknown' : `${value.name}@${value.version}`
}

function coordinateFromManifest(manifest: PackageManifestSnapshot): AlignmentCoordinate {
  return { name: manifest.name, version: manifest.version }
}

function coordinateFromNode(value: { name: string; version: string } | undefined): AlignmentCoordinate | undefined {
  return value === undefined ? undefined : { name: value.name, version: value.version }
}

function sameCoordinate(left: AlignmentCoordinate | undefined, right: AlignmentCoordinate | undefined): boolean {
  return left?.name === right?.name && left?.version === right?.version
}

function overallStatus(checks: readonly AlignmentCheck[]): AlignmentStatus {
  if (checks.some(check => check.status === 'mismatch')) return 'mismatch'
  if (checks.some(check => check.status === 'unknown')) return 'unknown'
  return 'aligned'
}

/** Build the IR without fetching, installing, or executing anything. */
export function buildUpstreamDownstreamIR(input: UpstreamDownstreamAlignmentInput): UpstreamDownstreamIR {
  const upstream = coordinateFromManifest(input.manifest)
  const published = input.package === undefined
    ? undefined
    : { name: input.package.name, version: input.package.version }
  const graphRoot = input.graph === undefined
    ? undefined
    : coordinateFromNode(input.graph.nodes.find(node => node.id === input.graph?.rootNodeId))
  const unresolved = input.graph?.unresolved?.length ?? 0
  const graphStatus: AlignmentGraphStatus = input.graph === undefined
    ? 'unavailable'
    : unresolved > 0 || input.graphError !== undefined
      ? 'incomplete'
      : 'complete'
  const checks: AlignmentCheck[] = []

  if (published === undefined) {
    checks.push({
      code: 'source-published-identity',
      status: 'unknown',
      summary: 'The published npm package was not observed, so source identity cannot be matched to downstream bytes.',
      upstream: coordinateText(upstream),
      remediation: 'Confirm the exact npm package name and make the registry observation available before treating source and artifact as one release.',
    })
  } else if (sameCoordinate(upstream, published)) {
    checks.push({
      code: 'source-published-identity',
      status: 'aligned',
      summary: 'The source manifest and observed npm package have the same name and version.',
      upstream: coordinateText(upstream),
      downstream: coordinateText(published),
    })
  } else {
    checks.push({
      code: 'source-published-identity',
      status: 'mismatch',
      summary: 'The source manifest and observed npm package do not identify the same name and version.',
      upstream: coordinateText(upstream),
      downstream: coordinateText(published),
      remediation: 'Align package.json, the published npm package, and the observer target; if the names intentionally differ, document the build and publish mapping.',
    })
  }

  if (graphRoot === undefined) {
    checks.push({
      code: 'source-graph-root',
      status: 'unknown',
      summary: input.graphError === undefined
        ? 'No dependency graph root was observed.'
        : `The dependency graph could not be established: ${input.graphError}`,
      upstream: coordinateText(upstream),
      remediation: 'Commit a supported lockfile or correct the configured package path/importer so the root can be verified.',
    })
  } else if (sameCoordinate(upstream, graphRoot)) {
    checks.push({
      code: 'source-graph-root',
      status: 'aligned',
      summary: 'The lockfile graph root matches the source manifest.',
      upstream: coordinateText(upstream),
      downstream: coordinateText(graphRoot),
    })
  } else {
    checks.push({
      code: 'source-graph-root',
      status: 'mismatch',
      summary: 'The lockfile graph root does not match the source manifest.',
      upstream: coordinateText(upstream),
      downstream: coordinateText(graphRoot),
      remediation: 'Regenerate the lockfile from the intended package path and ensure its root name and version match package.json.',
    })
  }

  if (published === undefined || graphRoot === undefined) {
    checks.push({
      code: 'published-graph-root',
      status: 'unknown',
      summary: 'The published package cannot be compared with the dependency graph root.',
      upstream: coordinateText(published),
      downstream: coordinateText(graphRoot),
      remediation: 'Observe both the exact npm package and a complete lockfile graph before using the graph as downstream evidence.',
    })
  } else if (sameCoordinate(published, graphRoot)) {
    checks.push({
      code: 'published-graph-root',
      status: 'aligned',
      summary: 'The dependency graph root matches the observed npm package.',
      upstream: coordinateText(published),
      downstream: coordinateText(graphRoot),
    })
  } else {
    checks.push({
      code: 'published-graph-root',
      status: 'mismatch',
      summary: 'The dependency graph root does not identify the observed npm package.',
      upstream: coordinateText(published),
      downstream: coordinateText(graphRoot),
      remediation: 'Fix the package/lockfile mapping before using this graph to describe the published artifact.',
    })
  }

  checks.push({
    code: 'dependency-graph-coverage',
    status: graphStatus === 'complete' ? 'aligned' : 'unknown',
    summary: graphStatus === 'complete'
      ? 'All observed dependency edges are resolved.'
      : graphStatus === 'incomplete'
        ? `The dependency graph is incomplete${unresolved > 0 ? ` (${unresolved} unresolved edge${unresolved === 1 ? '' : 's'})` : ''}.`
        : 'The dependency graph is unavailable.',
    downstream: `${graphStatus}; ${input.graph?.nodes.length ?? 0} nodes, ${input.graph?.edges.length ?? 0} edges`,
    ...(graphStatus === 'complete' ? {} : {
      remediation: 'Resolve the missing lockfile or peer/optional edges; an empty vulnerability result is not complete coverage while this remains unknown.',
    }),
  })

  return {
    schema: UPSTREAM_DOWNSTREAM_IR_SCHEMA,
    targetId: input.targetId,
    ecosystem: input.ecosystem,
    upstream: {
      repository: input.source.repository,
      commit: input.source.commit,
      packagePath: input.source.packagePath,
      coordinate: upstream,
    },
    downstream: {
      ...(published === undefined ? {} : { published }),
      graph: {
        status: graphStatus,
        ...(graphRoot === undefined ? {} : { root: graphRoot }),
        ...(input.graph?.digest === undefined ? {} : { digest: input.graph.digest }),
        nodes: input.graph?.nodes.length ?? 0,
        edges: input.graph?.edges.length ?? 0,
        unresolved,
      },
    },
    status: overallStatus(checks),
    checks,
  }
}

function boundedString(value: unknown, label: string, max = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} must be a non-empty bounded string`)
  return value
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function alignmentStatus(value: unknown, label: string): AlignmentStatus {
  const status = boundedString(value, label, 16) as AlignmentStatus
  if (status !== 'aligned' && status !== 'mismatch' && status !== 'unknown') throw new Error(`${label} has an invalid status`)
  return status
}

function parseCoordinate(value: unknown, label: string): AlignmentCoordinate {
  const source = record(value, label)
  return { name: boundedString(source.name, `${label}.name`, 512), version: boundedString(source.version, `${label}.version`, 512) }
}

/** Validate persisted IR before it is exposed to reports or an Agent prompt. */
export function parseUpstreamDownstreamIR(value: unknown, label = 'alignment'): UpstreamDownstreamIR {
  const source = record(value, label)
  if (source.schema !== UPSTREAM_DOWNSTREAM_IR_SCHEMA) throw new Error(`${label} has an unsupported schema`)
  const targetId = boundedString(source.targetId, `${label}.targetId`, 128)
  const ecosystem = boundedString(source.ecosystem, `${label}.ecosystem`, 16) as UpstreamDownstreamIR['ecosystem']
  if (ecosystem !== 'dsh' && ecosystem !== 'codex' && ecosystem !== 'pi') throw new Error(`${label}.ecosystem is invalid`)
  const upstreamValue = record(source.upstream, `${label}.upstream`)
  const upstreamSource = {
    repository: boundedString(upstreamValue.repository, `${label}.upstream.repository`, 4_096),
    commit: boundedString(upstreamValue.commit, `${label}.upstream.commit`, 256),
    packagePath: boundedString(upstreamValue.packagePath, `${label}.upstream.packagePath`, 512),
    coordinate: parseCoordinate(upstreamValue.coordinate, `${label}.upstream.coordinate`),
  }
  const downstreamValue = record(source.downstream, `${label}.downstream`)
  const published = downstreamValue.published === undefined ? undefined : parseCoordinate(downstreamValue.published, `${label}.downstream.published`)
  const graphValue = record(downstreamValue.graph, `${label}.downstream.graph`)
  const graphStatus = boundedString(graphValue.status, `${label}.downstream.graph.status`, 16) as AlignmentGraphStatus
  if (graphStatus !== 'complete' && graphStatus !== 'incomplete' && graphStatus !== 'unavailable') throw new Error(`${label}.downstream.graph.status is invalid`)
  const root = graphValue.root === undefined ? undefined : parseCoordinate(graphValue.root, `${label}.downstream.graph.root`)
  const numberValue = (valueToCheck: unknown, field: string): number => {
    if (!Number.isSafeInteger(valueToCheck) || (valueToCheck as number) < 0 || (valueToCheck as number) > 1_000_000) throw new Error(`${field} must be a bounded non-negative integer`)
    return valueToCheck as number
  }
  const digest = graphValue.digest === undefined ? undefined : boundedString(graphValue.digest, `${label}.downstream.graph.digest`, 512)
  const checksValue = source.checks
  if (!Array.isArray(checksValue) || checksValue.length === 0 || checksValue.length > 32) throw new Error(`${label}.checks must contain between 1 and 32 entries`)
  const checks = checksValue.map((valueToCheck, index) => {
    const check = record(valueToCheck, `${label}.checks[${index}]`)
    const code = boundedString(check.code, `${label}.checks[${index}].code`, 64) as AlignmentCheckCode
    if (code !== 'source-published-identity' && code !== 'source-graph-root' && code !== 'published-graph-root' && code !== 'dependency-graph-coverage') {
      throw new Error(`${label}.checks[${index}].code is invalid`)
    }
    const upstreamText = check.upstream === undefined ? undefined : boundedString(check.upstream, `${label}.checks[${index}].upstream`, 1_024)
    const downstreamText = check.downstream === undefined ? undefined : boundedString(check.downstream, `${label}.checks[${index}].downstream`, 1_024)
    const remediation = check.remediation === undefined ? undefined : boundedString(check.remediation, `${label}.checks[${index}].remediation`, 4_096)
    return {
      code,
      status: alignmentStatus(check.status, `${label}.checks[${index}].status`),
      summary: boundedString(check.summary, `${label}.checks[${index}].summary`, 4_096),
      ...(upstreamText === undefined ? {} : { upstream: upstreamText }),
      ...(downstreamText === undefined ? {} : { downstream: downstreamText }),
      ...(remediation === undefined ? {} : { remediation }),
    }
  })
  const duplicateCodes = checks.map(check => check.code).filter((code, index, values) => values.indexOf(code) !== index)
  if (duplicateCodes.length > 0) throw new Error(`${label}.checks must not contain duplicate codes`)
  const parsedOverallStatus = alignmentStatus(source.status, `${label}.status`)
  if (parsedOverallStatus !== overallStatus(checks)) throw new Error(`${label}.status does not match its check statuses`)
  return {
    schema: UPSTREAM_DOWNSTREAM_IR_SCHEMA,
    targetId,
    ecosystem,
    upstream: upstreamSource,
    downstream: {
      ...(published === undefined ? {} : { published }),
      graph: {
        status: graphStatus,
        ...(root === undefined ? {} : { root }),
        ...(digest === undefined ? {} : { digest }),
        nodes: numberValue(graphValue.nodes, `${label}.downstream.graph.nodes`),
        edges: numberValue(graphValue.edges, `${label}.downstream.graph.edges`),
        unresolved: numberValue(graphValue.unresolved, `${label}.downstream.graph.unresolved`),
      },
    },
    status: parsedOverallStatus,
    checks,
  }
}
