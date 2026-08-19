import type { DependencyGraph, DependencyKind, PackageCoordinate } from './radar-types.js'

export const REVERSE_DEPENDENCY_INDEX_SCHEMA = 'upstream-radar.reverse-dependency-index/v1alpha1' as const

const MAX_PATHS_PER_DEPENDENCY = 8
const MAX_PATH_DEPTH = 64

type JsonRecord = Record<string, unknown>

export interface ReverseDependencyObservation {
  source: string
  pluginId: string
  plugin: PackageCoordinate
  project?: { id: string; name: string }
  graph: DependencyGraph
}

export interface ReverseDependencyPath {
  nodes: string[]
  kinds: DependencyKind[]
}

export interface ReverseDependencyUse {
  pluginId: string
  plugin: PackageCoordinate
  project?: { id: string; name: string }
  sources: string[]
  coverage: 'complete' | 'incomplete'
  paths: ReverseDependencyPath[]
}

export interface ReverseDependencyEntry {
  dependency: PackageCoordinate
  dependents: ReverseDependencyUse[]
}

export interface ReverseDependencyPluginObservation {
  source: string
  graphDigest?: string
  coverage: 'complete' | 'incomplete'
  unresolved: number
}

export interface ReverseDependencyPlugin {
  id: string
  plugin: PackageCoordinate
  project?: { id: string; name: string }
  observations: ReverseDependencyPluginObservation[]
}

export interface ReverseDependencyIndexInputs {
  files: number
  loadedFiles: number
  skipped: Array<{ source: string; reason: string }>
}

export interface ReverseDependencyIndex {
  schema: typeof REVERSE_DEPENDENCY_INDEX_SCHEMA
  generatedAt: string
  observations: number
  inputs: ReverseDependencyIndexInputs
  coverage: {
    completeObservations: number
    incompleteObservations: number
    unresolvedEdges: number
  }
  plugins: ReverseDependencyPlugin[]
  dependencies: ReverseDependencyEntry[]
}

/** A package-name change extracted from an upstream old -> new graph diff. */
export interface ReverseDependencyPackageChange {
  ecosystem: 'npm'
  name: string
  beforeVersions: string[]
  afterVersions: string[]
}

/** Downstream plugins that may be affected by one changed upstream package name. */
export interface ReverseDependencyImpact {
  dependency: { ecosystem: 'npm'; name: string }
  changedFrom: string[]
  changedTo: string[]
  observedVersions: string[]
  coverage: 'complete' | 'incomplete'
  dependents: ReverseDependencyUse[]
  truncated: boolean
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asGraph(value: unknown): DependencyGraph | undefined {
  const graph = asRecord(value)
  if (graph === undefined || graph.schema !== 'upstream-radar.dependency-graph/v1alpha1') return undefined
  if (typeof graph.rootNodeId !== 'string' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return undefined
  return graph as unknown as DependencyGraph
}

function graphFromScanReport(value: JsonRecord): DependencyGraph | undefined {
  const evidence = asRecord(value.evidence)
  const npm = asRecord(evidence?.npm)
  const audit = asRecord(npm?.dependencyAudit)
  return asGraph(evidence?.dependencyGraph) ?? asGraph(audit?.graph)
}

function packageFromScanReport(value: JsonRecord): PackageCoordinate | undefined {
  const target = asRecord(value.target)
  const name = asString(target?.name)
  const version = asString(target?.version)
  if (name === undefined || version === undefined) return undefined
  return { ecosystem: 'npm', name, version }
}

function observationsFromScan(value: JsonRecord, source: string, project?: { id: string; name: string }): ReverseDependencyObservation[] {
  const plugin = packageFromScanReport(value)
  const graph = graphFromScanReport(value)
  if (plugin === undefined || graph === undefined) return []
  const pluginId = project === undefined ? `${plugin.name}@${plugin.version}` : `${project.id}:${plugin.name}@${plugin.version}`
  return [{ source, pluginId, plugin, ...(project === undefined ? {} : { project }), graph }]
}

function parsePackageCoordinate(value: unknown, label: string): PackageCoordinate {
  const record = asRecord(value)
  const ecosystem = asString(record?.ecosystem)
  const name = asString(record?.name)
  const version = asString(record?.version)
  if (ecosystem !== 'npm' || name === undefined || version === undefined) throw new Error(`${label} is not an npm package coordinate`)
  return { ecosystem: 'npm', name, version }
}

function parseProject(value: unknown, label: string): { id: string; name: string } | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  const id = asString(record?.id)
  const name = asString(record?.name)
  if (id === undefined || name === undefined) throw new Error(`${label} is not a project identity`)
  return { id, name }
}

function parseReverseDependencyPath(value: unknown, label: string): ReverseDependencyPath {
  const record = asRecord(value)
  if (!Array.isArray(record?.nodes) || !Array.isArray(record?.kinds) || record.nodes.length !== record.kinds.length + 1) {
    throw new Error(`${label} is not a dependency path`)
  }
  const nodes = record.nodes.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) throw new Error(`${label}.nodes[${index}] is invalid`)
    return item
  })
  const allowedKinds = new Set<DependencyKind>(['runtime', 'development', 'optional', 'peer', 'host-runtime'])
  const kinds = record.kinds.map((item, index) => {
    if (typeof item !== 'string' || !allowedKinds.has(item as DependencyKind)) throw new Error(`${label}.kinds[${index}] is invalid`)
    return item as DependencyKind
  })
  return { nodes, kinds }
}

function parseReverseDependencyUse(value: unknown, label: string): ReverseDependencyUse {
  const record = asRecord(value)
  const pluginId = asString(record?.pluginId)
  if (pluginId === undefined || !Array.isArray(record?.sources) || !Array.isArray(record?.paths)) throw new Error(`${label} is not a dependent plugin record`)
  const sources = record.sources.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) throw new Error(`${label}.sources[${index}] is invalid`)
    return item
  })
  const paths = record.paths.map((item, index) => parseReverseDependencyPath(item, `${label}.paths[${index}]`))
  const coverage = record.coverage
  if (coverage !== 'complete' && coverage !== 'incomplete') throw new Error(`${label}.coverage is invalid`)
  const project = parseProject(record.project, `${label}.project`)
  return {
    pluginId,
    plugin: parsePackageCoordinate(record.plugin, `${label}.plugin`),
    ...(project === undefined ? {} : { project }),
    sources,
    coverage,
    paths,
  }
}

/** Parse a persisted reverse index before using it to route upstream changes. */
export function parseReverseDependencyIndex(value: unknown, source = 'reverse dependency index'): ReverseDependencyIndex {
  const record = asRecord(value)
  if (record === undefined || record.schema !== REVERSE_DEPENDENCY_INDEX_SCHEMA) throw new Error(`${source} has an unsupported schema`)
  const generatedAt = asString(record.generatedAt)
  if (generatedAt === undefined || !Number.isFinite(Date.parse(generatedAt))) throw new Error(`${source}.generatedAt is invalid`)
  const observations = typeof record.observations === 'number' ? record.observations : Number.NaN
  if (!Number.isInteger(observations) || observations < 0) throw new Error(`${source}.observations is invalid`)
  const inputs = asRecord(record.inputs)
  const files = typeof inputs?.files === 'number' ? inputs.files : Number.NaN
  const loadedFiles = typeof inputs?.loadedFiles === 'number' ? inputs.loadedFiles : Number.NaN
  const skippedValue = inputs?.skipped
  if (!Number.isInteger(files) || files < 0 || !Number.isInteger(loadedFiles) || loadedFiles < 0 || !Array.isArray(skippedValue)) {
    throw new Error(`${source}.inputs is invalid`)
  }
  const skipped = skippedValue.map((item, index) => {
    const record = asRecord(item)
    const skippedSource = asString(record?.source)
    const reason = asString(record?.reason)
    if (skippedSource === undefined || reason === undefined) throw new Error(`${source}.inputs.skipped[${index}] is invalid`)
    return { source: skippedSource, reason }
  })
  const coverageValue = asRecord(record.coverage)
  const completeObservations = typeof coverageValue?.completeObservations === 'number' ? coverageValue.completeObservations : Number.NaN
  const incompleteObservations = typeof coverageValue?.incompleteObservations === 'number' ? coverageValue.incompleteObservations : Number.NaN
  const unresolvedEdges = typeof coverageValue?.unresolvedEdges === 'number' ? coverageValue.unresolvedEdges : Number.NaN
  if (!Number.isInteger(completeObservations) || completeObservations < 0
    || !Number.isInteger(incompleteObservations) || incompleteObservations < 0
    || !Number.isInteger(unresolvedEdges) || unresolvedEdges < 0) {
    throw new Error(`${source}.coverage is invalid`)
  }
  if (!Array.isArray(record.plugins) || !Array.isArray(record.dependencies)) throw new Error(`${source} is missing plugins or dependencies`)
  const plugins = record.plugins.map((item, index) => {
    const pluginRecord = asRecord(item)
    const id = asString(pluginRecord?.id)
    if (id === undefined || !Array.isArray(pluginRecord?.observations)) throw new Error(`${source}.plugins[${index}] is invalid`)
    const pluginObservations = pluginRecord.observations.map((observation, observationIndex) => {
      const observationRecord = asRecord(observation)
      const observationSource = asString(observationRecord?.source)
      const graphDigest = observationRecord?.graphDigest === undefined ? undefined : asString(observationRecord.graphDigest)
      const coverage = observationRecord?.coverage
      const unresolved = typeof observationRecord?.unresolved === 'number' ? observationRecord.unresolved : Number.NaN
      if (observationSource === undefined || (graphDigest === undefined && observationRecord?.graphDigest !== undefined)
        || (coverage !== 'complete' && coverage !== 'incomplete') || !Number.isInteger(unresolved) || unresolved < 0) {
        throw new Error(`${source}.plugins[${index}].observations[${observationIndex}] is invalid`)
      }
      const observationCoverage = coverage as 'complete' | 'incomplete'
      return {
        source: observationSource,
        ...(graphDigest === undefined ? {} : { graphDigest }),
        coverage: observationCoverage,
        unresolved,
      }
    })
    const project = parseProject(pluginRecord?.project, `${source}.plugins[${index}].project`)
    return {
      id,
      plugin: parsePackageCoordinate(pluginRecord?.plugin, `${source}.plugins[${index}].plugin`),
      ...(project === undefined ? {} : { project }),
      observations: pluginObservations,
    }
  })
  const dependencies = record.dependencies.map((item, index) => {
    const dependencyRecord = asRecord(item)
    if (!Array.isArray(dependencyRecord?.dependents)) throw new Error(`${source}.dependencies[${index}] is invalid`)
    return {
      dependency: parsePackageCoordinate(dependencyRecord.dependency, `${source}.dependencies[${index}].dependency`),
      dependents: dependencyRecord.dependents.map((dependent, dependentIndex) => parseReverseDependencyUse(dependent, `${source}.dependencies[${index}].dependents[${dependentIndex}]`)),
    }
  })
  return {
    schema: REVERSE_DEPENDENCY_INDEX_SCHEMA,
    generatedAt,
    observations,
    inputs: { files, loadedFiles, skipped },
    coverage: { completeObservations, incompleteObservations, unresolvedEdges },
    plugins,
    dependencies,
  }
}

/** Convert supported scan, exact-review, or Radar config JSON into index observations. */
export function parseReverseDependencyObservations(value: unknown, source: string): ReverseDependencyObservation[] {
  const record = asRecord(value)
  if (record === undefined) throw new Error(`${source} is not a JSON object`)
  const schema = asString(record.schema)
  if (schema === 'upstream-radar.scan/v1alpha1') return observationsFromScan(record, source)
  if (schema === 'upstream-radar.dsh-plugin-review/v1alpha1') {
    const inspection = asRecord(record.inspection)
    return inspection === undefined ? [] : observationsFromScan(inspection, `${source}#inspection`)
  }
  if (schema === 'upstream-radar.radar-config/v1alpha1') {
    if (!Array.isArray(record.projects)) throw new Error(`${source} has no projects array`)
    const observations: ReverseDependencyObservation[] = []
    for (const [projectIndex, projectValue] of record.projects.entries()) {
      const projectRecord = asRecord(projectValue)
      const project = asRecord(projectRecord?.project)
      const projectId = asString(project?.id)
      const projectName = asString(project?.name)
      if (projectId === undefined || projectName === undefined) throw new Error(`${source} project ${projectIndex} has no id/name`)
      const plugins = Array.isArray(projectRecord?.plugins) ? projectRecord.plugins : []
      for (const [pluginIndex, pluginValue] of plugins.entries()) {
        const pluginRecord = asRecord(pluginValue)
        const packageRecord = asRecord(pluginRecord?.package)
        const name = asString(packageRecord?.name)
        const version = asString(packageRecord?.version)
        const graph = asGraph(pluginRecord?.graph)
        if (name === undefined || version === undefined || graph === undefined) {
          throw new Error(`${source} project ${projectIndex} plugin ${pluginIndex} is missing an exact package or graph`)
        }
        observations.push({
          source: `${source}#projects/${projectIndex}/plugins/${pluginIndex}`,
          pluginId: `${projectId}:${name}@${version}`,
          plugin: { ecosystem: 'npm', name, version },
          project: { id: projectId, name: projectName },
          graph,
        })
      }
    }
    return observations
  }
  throw new Error(`${source} has unsupported schema ${schema ?? '(missing)'}`)
}

function packageKey(packageCoordinate: PackageCoordinate): string {
  return `${packageCoordinate.name}@${packageCoordinate.version}`
}

function pathKinds(path: string[], edgeKinds: Map<string, DependencyKind>): DependencyKind[] {
  const kinds: DependencyKind[] = []
  for (let index = 0; index < path.length - 1; index += 1) {
    const kind = edgeKinds.get(`${path[index]}\0${path[index + 1]}`)
    if (kind === undefined) throw new Error('dependency graph path references a missing edge')
    kinds.push(kind)
  }
  return kinds
}

function addUnique<T>(items: T[], value: T): void {
  if (!items.some(item => JSON.stringify(item) === JSON.stringify(value))) items.push(value)
}

function addUniqueString(items: string[], values: readonly string[]): void {
  for (const value of values) if (!items.includes(value)) items.push(value)
}

function mergeReverseDependencyUse(target: ReverseDependencyUse, source: ReverseDependencyUse): void {
  addUniqueString(target.sources, source.sources)
  if (source.coverage === 'incomplete') target.coverage = 'incomplete'
  for (const path of source.paths) addUnique(target.paths, path)
}

/**
 * Compute bounded root-to-node paths in one propagation pass.
 *
 * Calling a DFS once per node can revisit the same high-branching graph an
 * exponential number of times. A real DSH profile can contain hundreds of
 * nodes, so keep at most the same bounded path budget per node while sharing
 * the traversal across all targets.
 */
function boundedPathsByNode(
  graph: DependencyGraph,
  maxPaths = MAX_PATHS_PER_DEPENDENCY,
  maxDepth = MAX_PATH_DEPTH,
): { pathsByNode: Map<string, string[][]>; edgeKinds: Map<string, DependencyKind> } {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  if (!nodes.has(graph.rootNodeId)) throw new Error('dependency graph root node is missing')
  const outgoing = new Map<string, Array<{ to: string; kind: DependencyKind }>>()
  const edgeKinds = new Map<string, DependencyKind>()
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error('dependency graph edge references a missing node')
    const list = outgoing.get(edge.from) ?? []
    list.push({ to: edge.to, kind: edge.kind })
    outgoing.set(edge.from, list)
    const key = `${edge.from}\0${edge.to}`
    const previous = edgeKinds.get(key)
    if (previous === undefined || edge.kind.localeCompare(previous) < 0) edgeKinds.set(key, edge.kind)
  }
  for (const list of outgoing.values()) {
    list.sort((left, right) => {
      const leftNode = nodes.get(left.to)
      const rightNode = nodes.get(right.to)
      return `${leftNode?.name ?? ''}@${leftNode?.version ?? ''}:${left.to}`
        .localeCompare(`${rightNode?.name ?? ''}@${rightNode?.version ?? ''}:${right.to}`)
        || left.kind.localeCompare(right.kind)
    })
  }

  const pathsByNode = new Map<string, string[][]>([[graph.rootNodeId, [[graph.rootNodeId]]]])
  const queue = [graph.rootNodeId]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    if (current === undefined) continue
    const paths = pathsByNode.get(current) ?? []
    if (paths.length === 0) continue
    for (const path of paths) {
      if (path.length >= maxDepth) continue
      const seen = new Set(path)
      for (const edge of outgoing.get(current) ?? []) {
        if (seen.has(edge.to)) continue
        const nextPath = [...path, edge.to]
        const targetPaths = pathsByNode.get(edge.to) ?? []
        if (targetPaths.length >= maxPaths || targetPaths.some(item => JSON.stringify(item) === JSON.stringify(nextPath))) continue
        targetPaths.push(nextPath)
        pathsByNode.set(edge.to, targetPaths)
        queue.push(edge.to)
      }
    }
  }
  return { pathsByNode, edgeKinds }
}

/** Build a deterministic dependency -> plugin index from bounded graph observations. */
export function buildReverseDependencyIndex(
  observations: readonly ReverseDependencyObservation[],
  options: { generatedAt?: string; inputs?: ReverseDependencyIndexInputs } = {},
): ReverseDependencyIndex {
  const dependencies = new Map<string, ReverseDependencyEntry>()
  const plugins = new Map<string, ReverseDependencyPlugin>()
  let completeObservations = 0
  let incompleteObservations = 0
  let unresolvedEdges = 0

  for (const observation of observations) {
    const unresolved = observation.graph.unresolved?.length ?? 0
    const coverage = unresolved === 0 ? 'complete' : 'incomplete'
    if (coverage === 'complete') completeObservations += 1
    else incompleteObservations += 1
    unresolvedEdges += unresolved
    const plugin = plugins.get(observation.pluginId) ?? {
      id: observation.pluginId,
      plugin: observation.plugin,
      ...(observation.project === undefined ? {} : { project: observation.project }),
      observations: [],
    }
    plugin.observations.push({
      source: observation.source,
      ...(observation.graph.digest === undefined ? {} : { graphDigest: observation.graph.digest }),
      coverage,
      unresolved,
    })
    plugins.set(observation.pluginId, plugin)

    const root = observation.graph.nodes.find(node => node.id === observation.graph.rootNodeId)
    if (root === undefined) throw new Error(`${observation.source} graph root node is missing`)
    const nodesById = new Map(observation.graph.nodes.map(node => [node.id, node]))
    const { pathsByNode, edgeKinds } = boundedPathsByNode(observation.graph)
    for (const node of observation.graph.nodes) {
      if (node.id === observation.graph.rootNodeId) continue
      const paths = pathsByNode.get(node.id) ?? []
      if (paths.length === 0) continue
      const dependency = { ecosystem: 'npm' as const, name: node.name, version: node.version }
      const dependencyEntry = dependencies.get(packageKey(dependency)) ?? { dependency, dependents: [] }
      const dependent = dependencyEntry.dependents.find(item => item.pluginId === observation.pluginId)
      const target = dependent ?? {
        pluginId: observation.pluginId,
        plugin: observation.plugin,
        ...(observation.project === undefined ? {} : { project: observation.project }),
        sources: [],
        coverage,
        paths: [],
      }
      addUnique(target.sources, observation.source)
      if (coverage === 'incomplete') target.coverage = 'incomplete'
      for (const path of paths) {
        const labels = path.map(id => {
          const pathNode = nodesById.get(id)
          if (pathNode === undefined) throw new Error(`${observation.source} graph path references a missing node`)
          return `${pathNode.name}@${pathNode.version}`
        })
        addUnique(target.paths, { nodes: labels, kinds: pathKinds(path, edgeKinds) })
      }
      if (dependent === undefined) dependencyEntry.dependents.push(target)
      dependencies.set(packageKey(dependency), dependencyEntry)
    }
  }

  for (const plugin of plugins.values()) {
    plugin.observations.sort((left, right) => left.source.localeCompare(right.source))
  }
  const sortedPlugins = [...plugins.values()].sort((left, right) => left.id.localeCompare(right.id))
  const sortedDependencies = [...dependencies.values()].sort((left, right) => packageKey(left.dependency).localeCompare(packageKey(right.dependency)))
  for (const dependency of sortedDependencies) {
    dependency.dependents.sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    for (const dependent of dependency.dependents) {
      dependent.sources.sort()
      dependent.paths.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }
  }

  return {
    schema: REVERSE_DEPENDENCY_INDEX_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    observations: observations.length,
    inputs: options.inputs ?? { files: observations.length, loadedFiles: observations.length, skipped: [] },
    coverage: { completeObservations, incompleteObservations, unresolvedEdges },
    plugins: sortedPlugins,
    dependencies: sortedDependencies,
  }
}

export function findReverseDependencyEntry(
  index: ReverseDependencyIndex,
  packageCoordinate: PackageCoordinate,
): ReverseDependencyEntry | undefined {
  return index.dependencies.find(item => packageKey(item.dependency) === packageKey(packageCoordinate))
}

/**
 * Find downstream plugins by package name, not exact version.
 *
 * An upstream release usually changes `parser@1` to `parser@2`, while a
 * downstream graph still records the old exact version until its author
 * republishes. Matching only the exact new coordinate would therefore miss
 * the very plugins that need attention. This function intentionally returns
 * evidence and paths, not a claim that every matched plugin is broken.
 */
export function findReverseDependencyImpacts(
  index: ReverseDependencyIndex,
  changes: readonly ReverseDependencyPackageChange[],
): ReverseDependencyImpact[] {
  const byName = new Map<string, ReverseDependencyPackageChange>()
  for (const change of changes) {
    if (change.ecosystem !== 'npm' || change.name === '') continue
    const existing = byName.get(change.name)
    if (existing === undefined) {
      byName.set(change.name, {
        ecosystem: 'npm',
        name: change.name,
        beforeVersions: [...new Set(change.beforeVersions)].sort(),
        afterVersions: [...new Set(change.afterVersions)].sort(),
      })
      continue
    }
    addUniqueString(existing.beforeVersions, change.beforeVersions)
    addUniqueString(existing.afterVersions, change.afterVersions)
    existing.beforeVersions.sort()
    existing.afterVersions.sort()
  }

  const impacts: ReverseDependencyImpact[] = []
  for (const change of [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const beforeVersions = new Set(change.beforeVersions)
    const entries = index.dependencies
      .filter(entry => entry.dependency.ecosystem === 'npm'
        && entry.dependency.name === change.name
        // A plugin already on the new version is not downstream impact from
        // this old -> new change. For a newly introduced package there is no
        // old coordinate, so package-name matching is the only available
        // evidence and remains explicitly a possible impact.
        && (beforeVersions.size === 0 || beforeVersions.has(entry.dependency.version)))
      .sort((left, right) => left.dependency.version.localeCompare(right.dependency.version))
    if (entries.length === 0) continue

    const dependentMap = new Map<string, ReverseDependencyUse>()
    for (const entry of entries) {
      for (const dependent of entry.dependents) {
        const existing = dependentMap.get(dependent.pluginId)
        if (existing === undefined) {
          dependentMap.set(dependent.pluginId, structuredClone(dependent))
        } else {
          mergeReverseDependencyUse(existing, dependent)
        }
      }
    }
    const allDependents = [...dependentMap.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    const dependents = allDependents.slice(0, 256)
    const coverage = allDependents.some(item => item.coverage === 'incomplete') ? 'incomplete' : 'complete'
    impacts.push({
      dependency: { ecosystem: 'npm', name: change.name },
      changedFrom: [...change.beforeVersions],
      changedTo: [...change.afterVersions],
      observedVersions: entries.map(entry => entry.dependency.version),
      coverage,
      dependents,
      truncated: dependents.length < allDependents.length,
    })
  }
  return impacts
}
