export const DEPENDENCY_GRAPH_SCHEMA = 'upstream-radar.dependency-graph/v1alpha1' as const
export const INVENTORY_SCHEMA = 'upstream-radar.inventory/v1alpha1' as const
export const RADAR_EVENT_SCHEMA = 'upstream-radar.event/v1alpha1' as const
export const RADAR_STATE_SCHEMA = 'upstream-radar.radar-state/v1alpha1' as const
export const ANALYSIS_TASK_SCHEMA = 'upstream-radar.analysis-task/v1alpha1' as const
export const RADAR_CONFIG_SCHEMA = 'upstream-radar.radar-config/v1alpha1' as const

export type PackageEcosystem = 'npm'

export interface PackageCoordinate {
  ecosystem: PackageEcosystem
  name: string
  version: string
}

export type DependencyKind = 'runtime' | 'development' | 'optional' | 'peer'

/** One physical package location. Duplicate name/version pairs remain distinct nodes. */
export interface DependencyNode {
  id: string
  name: string
  version: string
  /** Where an installed graph found this physical package. */
  source?: 'profile' | 'dsh-host'
}

export interface DependencyEdge {
  from: string
  to: string
  kind: DependencyKind
}

export interface DependencyGraph {
  schema: typeof DEPENDENCY_GRAPH_SCHEMA
  rootNodeId: string
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  /** How the physical graph was obtained. Older configs may omit this field. */
  source?: 'npm-lock' | 'installed-node-modules'
  /** Evidence that DSH's shared host dependency plane was included. */
  hostRuntime?: {
    source: 'dsh-profile-fallback'
    resolvedNodes: number
  }
  digest?: string
  unresolved?: Array<{
    from: string
    name: string
    kind: DependencyKind
    spec: string
  }>
}

export interface PackageManifestSnapshot {
  name: string
  version: string
  type?: string
  main?: string
  exports?: unknown
  engines?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: unknown
}

export interface PluginInstallation {
  package: PackageCoordinate
  graph: DependencyGraph
  manifest?: PackageManifestSnapshot
}

export interface ProjectReference {
  id: string
  name: string
  repository?: string
  workspace?: string
  owner?: string
  channels?: string[]
}

export interface ProjectInventory {
  schema: typeof INVENTORY_SCHEMA
  project: ProjectReference
  environment?: {
    nodeVersion?: string
  }
  plugins: PluginInstallation[]
}

export interface RadarConfig {
  schema: typeof RADAR_CONFIG_SCHEMA
  projects: ProjectInventory[]
}

export type RadarSeverity = 'unknown' | 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface VulnerabilityAdvisory {
  id: string
  aliases: string[]
  summary: string
  details: string
  severity: RadarSeverity
  published?: string
  modified: string
  withdrawn?: string
  fixedVersions: string[]
  references: string[]
}

export interface AdvisoryMatch {
  package: PackageCoordinate
  advisory: VulnerabilityAdvisory
}

export interface EventRoute {
  owner?: string
  channels: string[]
}

interface RadarEventBase {
  schema: typeof RADAR_EVENT_SCHEMA
  id: string
  /** Stable across new/updated/resolved transitions for one project-specific problem. */
  incidentId: string
  change: 'new' | 'updated' | 'resolved'
  detectedAt: string
  project: ProjectReference
  route: EventRoute
  plugin?: PackageCoordinate
}

export interface VulnerabilityEvent extends RadarEventBase {
  kind: 'vulnerability' | 'malware'
  plugin: PackageCoordinate
  affected: PackageCoordinate
  paths: PackageCoordinate[][]
  advisory: VulnerabilityAdvisory
}

export type CompatibilitySignalConfidence = 'confirmed' | 'strong' | 'needs-analysis'

export interface CompatibilitySignal {
  code: string
  confidence: CompatibilitySignalConfidence
  summary: string
  before?: string
  after?: string
}

export interface CompatibilityEvent extends RadarEventBase {
  kind: 'compatibility'
  plugin: PackageCoordinate
  installed: PackageCoordinate
  candidate: PackageCoordinate
  signals: CompatibilitySignal[]
  releaseNotes?: string
  releaseNotesUrl?: string
}

export type RadarSource = 'osv' | 'npm-releases' | 'github-releases'

export interface SourceHealthStatus {
  lastAttemptedAt: string
  lastSucceededAt?: string
  consecutiveFailures: number
  lastError?: string
}

export interface SourceHealthEvent extends RadarEventBase {
  kind: 'source-health'
  source: RadarSource
  status: 'degraded' | 'healthy'
  failureCount: number
  lastAttemptedAt: string
  lastSucceededAt?: string
  error?: string
}

export type RadarEvent = VulnerabilityEvent | CompatibilityEvent | SourceHealthEvent

export interface StoredVulnerabilityMatch {
  key: string
  event: VulnerabilityEvent
}

export interface StoredCompatibilityMatch {
  key: string
  event: CompatibilityEvent
}

export interface StoredSourceHealthMatch {
  key: string
  event: SourceHealthEvent
}

export interface RadarState {
  schema: typeof RADAR_STATE_SCHEMA
  activeVulnerabilities: Record<string, StoredVulnerabilityMatch>
  activeCompatibility: Record<string, StoredCompatibilityMatch>
  pendingAnalysisTasks: AnalysisTask[]
  sourceHealth?: Record<string, SourceHealthStatus>
  activeSourceHealth?: Record<string, StoredSourceHealthMatch>
}

export interface AnalysisTask {
  schema: typeof ANALYSIS_TASK_SCHEMA
  id: string
  createdAt: string
  event: RadarEvent
  constraints: {
    sourceMaterialIsUntrusted: true
    readOnly: true
    requireProjectEvidence: true
  }
  expectedOutput: {
    project_exposure: 'exposed | likely_exposed | not_exposed | unknown'
    confidence: 'high | medium | low'
    evidence: 'array of repository paths, symbols, configuration, or runtime facts'
    recommended_action: 'project-specific next action'
    urgency: 'immediate | within_24_hours | planned | monitor'
    reasoning_summary: 'short explanation separating deterministic facts from model analysis'
  }
}
