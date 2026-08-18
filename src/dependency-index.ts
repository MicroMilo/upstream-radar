import { findDependencyPaths } from './graph.js'
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

function pathKinds(graph: DependencyGraph, path: string[]): DependencyKind[] {
  const kinds: DependencyKind[] = []
  for (let index = 0; index < path.length - 1; index += 1) {
    const edge = graph.edges
      .filter(candidate => candidate.from === path[index] && candidate.to === path[index + 1])
      .sort((left, right) => left.kind.localeCompare(right.kind))[0]
    if (edge === undefined) throw new Error('dependency graph path references a missing edge')
    kinds.push(edge.kind)
  }
  return kinds
}

function labelsForPath(path: Array<{ name: string; version: string }>): string[] {
  return path.map(node => `${node.name}@${node.version}`)
}

function addUnique<T>(items: T[], value: T): void {
  if (!items.some(item => JSON.stringify(item) === JSON.stringify(value))) items.push(value)
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
    for (const node of observation.graph.nodes) {
      if (node.id === observation.graph.rootNodeId) continue
      const paths = findDependencyPaths(observation.graph, node.id, {
        maxPaths: MAX_PATHS_PER_DEPENDENCY,
        maxDepth: MAX_PATH_DEPTH,
      })
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
        const labels = labelsForPath(path)
        addUnique(target.paths, { nodes: labels, kinds: pathKinds(observation.graph, path.map(item => item.id)) })
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
