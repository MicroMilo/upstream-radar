import {
  DEPENDENCY_GRAPH_SCHEMA,
  INVENTORY_SCHEMA,
  RADAR_CONFIG_SCHEMA,
  type DependencyGraph,
  type DependencyKind,
  type DependencyNode,
  type PackageCoordinate,
  type PackageManifestSnapshot,
  type PluginInstallation,
  type ProjectInventory,
  type RadarNotificationPolicy,
  type RadarSeverity,
  type RadarConfig,
} from './radar-types.js'

const MAX_PROJECTS = 1_000
const MAX_PLUGINS_PER_PROJECT = 1_000
const MAX_NODES_PER_GRAPH = 100_000
const MAX_EDGES_PER_GRAPH = 250_000

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, max = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} must be a non-empty bounded string`)
  return value
}

function optionalString(value: unknown, label: string, max = 4_096): string | undefined {
  return value === undefined ? undefined : string(value, label, max)
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array with at most 100 entries`)
  return value.map((item, index) => string(item, `${label}[${index}]`, 1_024))
}

const NOTIFICATION_SEVERITIES = new Set<Exclude<RadarSeverity, 'unknown'>>([
  'info',
  'low',
  'medium',
  'high',
  'critical',
])

function clockTime(value: unknown, label: string): string {
  const parsed = string(value, label, 5)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed)) {
    throw new Error(`${label} must use HH:MM in 24-hour time`)
  }
  return parsed
}

function timezone(value: unknown, label: string): string {
  const parsed = string(value, label, 128)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed }).format()
  } catch {
    throw new Error(`${label} must be a valid IANA timezone`)
  }
  return parsed
}

function notificationPolicy(value: unknown, label: string): RadarNotificationPolicy | undefined {
  if (value === undefined) return undefined
  const source = record(value, label)
  const minimumSeverity = source.minimumSeverity === undefined
    ? undefined
    : string(source.minimumSeverity, `${label}.minimumSeverity`, 16) as RadarNotificationPolicy['minimumSeverity']
  if (minimumSeverity !== undefined && !NOTIFICATION_SEVERITIES.has(minimumSeverity)) {
    throw new Error(`${label}.minimumSeverity must be info, low, medium, high or critical`)
  }
  const quietSource = source.quietHours === undefined ? undefined : record(source.quietHours, `${label}.quietHours`)
  if (quietSource === undefined) {
    return minimumSeverity === undefined ? {} : { minimumSeverity }
  }
  const quietHours = {
    timezone: timezone(quietSource.timezone, `${label}.quietHours.timezone`),
    start: clockTime(quietSource.start, `${label}.quietHours.start`),
    end: clockTime(quietSource.end, `${label}.quietHours.end`),
  }
  if (quietHours.start === quietHours.end) {
    throw new Error(`${label}.quietHours.start and end must be different`)
  }
  return {
    ...(minimumSeverity === undefined ? {} : { minimumSeverity }),
    quietHours,
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const source = record(value, label)
  if (Object.keys(source).length > 10_000) throw new Error(`${label} has too many entries`)
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [
    string(key, `${label} key`, 512),
    string(item, `${label}.${key}`, 2_048),
  ]))
}

function peerDependenciesMeta(value: unknown, label: string): Record<string, { optional?: boolean }> | undefined {
  if (value === undefined) return undefined
  const source = record(value, label)
  if (Object.keys(source).length > 10_000) throw new Error(`${label} has too many entries`)
  const result: Record<string, { optional?: boolean }> = {}
  for (const [key, item] of Object.entries(source)) {
    const meta = record(item, `${label}.${key}`)
    if (meta.optional !== undefined && typeof meta.optional !== 'boolean') {
      throw new Error(`${label}.${key}.optional must be a boolean`)
    }
    result[string(key, `${label} key`, 512)] = meta.optional === undefined
      ? {}
      : { optional: meta.optional }
  }
  return result
}

function coordinate(value: unknown, label: string): PackageCoordinate {
  const source = record(value, label)
  if (source.ecosystem !== 'npm') throw new Error(`${label}.ecosystem must be npm`)
  return {
    ecosystem: 'npm',
    name: string(source.name, `${label}.name`, 512),
    version: string(source.version, `${label}.version`, 512),
  }
}

function manifest(value: unknown, label: string): PackageManifestSnapshot | undefined {
  if (value === undefined) return undefined
  const source = record(value, label)
  const type = optionalString(source.type, `${label}.type`, 128)
  const main = optionalString(source.main, `${label}.main`, 4_096)
  const engines = stringRecord(source.engines, `${label}.engines`)
  const dependencies = stringRecord(source.dependencies, `${label}.dependencies`)
  const optionalDependencies = stringRecord(source.optionalDependencies, `${label}.optionalDependencies`)
  const peerDependencies = stringRecord(source.peerDependencies, `${label}.peerDependencies`)
  const peerMeta = peerDependenciesMeta(source.peerDependenciesMeta, `${label}.peerDependenciesMeta`)
  return {
    name: string(source.name, `${label}.name`, 512),
    version: string(source.version, `${label}.version`, 512),
    ...(type === undefined ? {} : { type }),
    ...(main === undefined ? {} : { main }),
    ...(source.exports === undefined ? {} : { exports: structuredClone(source.exports) }),
    ...(engines === undefined ? {} : { engines }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(peerMeta === undefined ? {} : { peerDependenciesMeta: peerMeta }),
    ...(source.dsh === undefined ? {} : { dsh: structuredClone(source.dsh) }),
  }
}

export function parsePackageManifestSnapshot(value: unknown): PackageManifestSnapshot {
  const parsed = manifest(value, 'package manifest')
  if (parsed === undefined) throw new Error('package manifest must be present')
  return parsed
}

function graph(value: unknown, label: string): DependencyGraph {
  const source = record(value, label)
  if (source.schema !== DEPENDENCY_GRAPH_SCHEMA) throw new Error(`${label} has an unsupported schema`)
  if (!Array.isArray(source.nodes) || source.nodes.length === 0 || source.nodes.length > MAX_NODES_PER_GRAPH) {
    throw new Error(`${label}.nodes must contain between 1 and ${MAX_NODES_PER_GRAPH} entries`)
  }
  if (!Array.isArray(source.edges) || source.edges.length > MAX_EDGES_PER_GRAPH) {
    throw new Error(`${label}.edges must contain at most ${MAX_EDGES_PER_GRAPH} entries`)
  }
  const nodes = source.nodes.map((rawNode, index) => {
    const node = record(rawNode, `${label}.nodes[${index}]`)
    const rawNodeSource = node.source === undefined ? undefined : string(node.source, `${label}.nodes[${index}].source`, 32)
    if (rawNodeSource !== undefined && rawNodeSource !== 'profile' && rawNodeSource !== 'dsh-host') {
      throw new Error(`${label}.nodes[${index}].source has an unsupported value`)
    }
    const nodeSource = rawNodeSource as DependencyNode['source']
    return {
      id: string(node.id, `${label}.nodes[${index}].id`, 4_096),
      name: string(node.name, `${label}.nodes[${index}].name`, 512),
      version: string(node.version, `${label}.nodes[${index}].version`, 512),
      ...((nodeSource === 'profile' || nodeSource === 'dsh-host') ? { source: nodeSource } : {}),
    }
  })
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length) throw new Error(`${label} contains duplicate node ids`)
  const kinds = new Set<DependencyKind>(['runtime', 'development', 'optional', 'peer'])
  const edges = source.edges.map((rawEdge, index) => {
    const edge = record(rawEdge, `${label}.edges[${index}]`)
    const from = string(edge.from, `${label}.edges[${index}].from`, 4_096)
    const to = string(edge.to, `${label}.edges[${index}].to`, 4_096)
    const kind = string(edge.kind, `${label}.edges[${index}].kind`, 32) as DependencyKind
    if (!kinds.has(kind)) throw new Error(`${label}.edges[${index}] has an invalid dependency kind`)
    if (!ids.has(from) || !ids.has(to)) throw new Error(`${label}.edges[${index}] references a missing node`)
    return { from, to, kind }
  })
  const rootNodeId = string(source.rootNodeId, `${label}.rootNodeId`, 4_096)
  if (!ids.has(rootNodeId)) throw new Error(`${label} root references a missing node`)
  const graphSource = source.source === undefined ? undefined : string(source.source, `${label}.source`, 64)
  if (graphSource !== undefined && graphSource !== 'npm-lock' && graphSource !== 'pnpm-lock' && graphSource !== 'installed-node-modules') {
    throw new Error(`${label}.source has an unsupported value`)
  }
  const hostRuntimeValue = source.hostRuntime === undefined ? undefined : record(source.hostRuntime, `${label}.hostRuntime`)
  const hostRuntimeSource = hostRuntimeValue === undefined
    ? undefined
    : string(hostRuntimeValue.source, `${label}.hostRuntime.source`, 64)
  if (hostRuntimeSource !== undefined && hostRuntimeSource !== 'dsh-profile-fallback' && hostRuntimeSource !== 'dsh-process') {
    throw new Error(`${label}.hostRuntime.source has an unsupported value`)
  }
  const resolvedNodes = hostRuntimeValue === undefined
    ? undefined
    : hostRuntimeValue.resolvedNodes
  if (resolvedNodes !== undefined && (!Number.isSafeInteger(resolvedNodes) || (resolvedNodes as number) < 0 || (resolvedNodes as number) > MAX_NODES_PER_GRAPH)) {
    throw new Error(`${label}.hostRuntime.resolvedNodes must be a non-negative bounded integer`)
  }
  const unresolvedValue = source.unresolved
  if (unresolvedValue !== undefined && (!Array.isArray(unresolvedValue) || unresolvedValue.length > MAX_EDGES_PER_GRAPH)) {
    throw new Error(`${label}.unresolved must contain at most ${MAX_EDGES_PER_GRAPH} entries`)
  }
  const unresolved = unresolvedValue === undefined ? undefined : unresolvedValue.map((rawItem, index) => {
    const item = record(rawItem, `${label}.unresolved[${index}]`)
    const from = string(item.from, `${label}.unresolved[${index}].from`, 4_096)
    if (!ids.has(from)) throw new Error(`${label}.unresolved[${index}] references a missing node`)
    const kind = string(item.kind, `${label}.unresolved[${index}].kind`, 32) as DependencyKind
    if (!kinds.has(kind)) throw new Error(`${label}.unresolved[${index}] has an invalid dependency kind`)
    return {
      from,
      name: string(item.name, `${label}.unresolved[${index}].name`, 512),
      kind,
      spec: string(item.spec, `${label}.unresolved[${index}].spec`, 2_048),
    }
  })
  const digest = optionalString(source.digest, `${label}.digest`, 512)
  return {
    schema: DEPENDENCY_GRAPH_SCHEMA,
    rootNodeId,
    nodes,
    edges,
    ...(graphSource === undefined ? {} : { source: graphSource }),
    ...(hostRuntimeSource === undefined || resolvedNodes === undefined ? {} : {
      hostRuntime: {
        source: hostRuntimeSource,
        resolvedNodes: resolvedNodes as number,
      },
    }),
    ...(digest === undefined ? {} : { digest }),
    ...(unresolved === undefined || unresolved.length === 0 ? {} : { unresolved }),
  }
}

function plugin(value: unknown, label: string): PluginInstallation {
  const source = record(value, label)
  const packageValue = coordinate(source.package, `${label}.package`)
  const graphValue = graph(source.graph, `${label}.graph`)
  const root = graphValue.nodes.find(node => node.id === graphValue.rootNodeId)
  if (root?.name !== packageValue.name || root.version !== packageValue.version) {
    throw new Error(`${label} installed package does not match graph root`)
  }
  const manifestValue = manifest(source.manifest, `${label}.manifest`)
  if (manifestValue !== undefined
    && (manifestValue.name !== packageValue.name || manifestValue.version !== packageValue.version)) {
    throw new Error(`${label} installed package does not match manifest`)
  }
  return {
    package: packageValue,
    graph: graphValue,
    ...(manifestValue === undefined ? {} : { manifest: manifestValue }),
  }
}

function project(value: unknown, index: number): ProjectInventory {
  const label = `projects[${index}]`
  const source = record(value, label)
  if (source.schema !== INVENTORY_SCHEMA) throw new Error(`${label} has an unsupported schema`)
  const projectSource = record(source.project, `${label}.project`)
  if (!Array.isArray(source.plugins) || source.plugins.length === 0 || source.plugins.length > MAX_PLUGINS_PER_PROJECT) {
    throw new Error(`${label}.plugins must contain between 1 and ${MAX_PLUGINS_PER_PROJECT} entries`)
  }
  const repository = optionalString(projectSource.repository, `${label}.project.repository`)
  const workspace = optionalString(projectSource.workspace, `${label}.project.workspace`)
  const owner = optionalString(projectSource.owner, `${label}.project.owner`, 1_024)
  const channels = stringArray(projectSource.channels, `${label}.project.channels`)
  const environmentSource = source.environment === undefined ? undefined : record(source.environment, `${label}.environment`)
  const nodeVersion = optionalString(environmentSource?.nodeVersion, `${label}.environment.nodeVersion`, 128)
  const notificationPolicyValue = notificationPolicy(source.notificationPolicy, `${label}.notificationPolicy`)
  return {
    schema: INVENTORY_SCHEMA,
    project: {
      id: string(projectSource.id, `${label}.project.id`, 512),
      name: string(projectSource.name, `${label}.project.name`, 1_024),
      ...(repository === undefined ? {} : { repository }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(owner === undefined ? {} : { owner }),
      ...(channels === undefined ? {} : { channels }),
    },
    ...(environmentSource === undefined ? {} : { environment: nodeVersion === undefined ? {} : { nodeVersion } }),
    ...(notificationPolicyValue === undefined ? {} : { notificationPolicy: notificationPolicyValue }),
    plugins: source.plugins.map((item, pluginIndex) => plugin(item, `${label}.plugins[${pluginIndex}]`)),
  }
}

export function parseRadarConfig(value: unknown): RadarConfig {
  const source = record(value, 'radar config')
  if (source.schema !== RADAR_CONFIG_SCHEMA) throw new Error('radar config has an unsupported schema')
  if (!Array.isArray(source.projects) || source.projects.length === 0 || source.projects.length > MAX_PROJECTS) {
    throw new Error(`radar config projects must contain between 1 and ${MAX_PROJECTS} entries`)
  }
  const projects = source.projects.map(project)
  const ids = new Set(projects.map(item => item.project.id))
  if (ids.size !== projects.length) throw new Error('radar config contains duplicate project ids')
  const dshProfileSource = source.dshProfile === undefined ? undefined : record(source.dshProfile, 'radar config dshProfile')
  const dshProfileName = dshProfileSource === undefined
    ? undefined
    : string(dshProfileSource.name, 'radar config dshProfile.name', 128)
  if (dshProfileName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dshProfileName)) {
    throw new Error('radar config dshProfile.name must be a simple DSH profile name')
  }
  return {
    schema: RADAR_CONFIG_SCHEMA,
    ...(dshProfileName === undefined ? {} : { dshProfile: { name: dshProfileName } }),
    projects,
  }
}
