export const DEPENDENCY_GRAPH_SCHEMA = 'upstream-radar.dependency-graph/v1alpha1' as const
export const INVENTORY_SCHEMA = 'upstream-radar.inventory/v1alpha1' as const
export const RADAR_EVENT_SCHEMA = 'upstream-radar.event/v1alpha1' as const
export const RADAR_STATE_SCHEMA = 'upstream-radar.radar-state/v1alpha1' as const
export const ANALYSIS_TASK_SCHEMA = 'upstream-radar.analysis-task/v1alpha1' as const
export const ANALYSIS_DELIVERY_SCHEMA = 'upstream-radar.analysis-delivery/v1alpha1' as const
export const ANALYSIS_RESULT_SCHEMA = 'upstream-radar.analysis-result/v1alpha1' as const
export const RADAR_CONFIG_SCHEMA = 'upstream-radar.radar-config/v1alpha1' as const
export const WEBHOOK_DELIVERY_SCHEMA = 'upstream-radar.webhook-delivery/v1alpha1' as const
export const RADAR_HISTORY_SCHEMA = 'upstream-radar.radar-history/v1alpha1' as const

/** The state file is a durable monitor, not an unbounded event database. */
export const MAX_RADAR_HISTORY_EVENTS = 1_000

export type PackageEcosystem = 'npm'

export interface PackageCoordinate {
  ecosystem: PackageEcosystem
  name: string
  version: string
}

export type DependencyKind = 'runtime' | 'development' | 'optional' | 'peer'
export type DependencySource = 'profile' | 'dsh-host'
export type DependencyHostRuntimeSource = 'dsh-profile-fallback' | 'dsh-process'

/** One physical package location. Duplicate name/version pairs remain distinct nodes. */
export interface DependencyNode {
  id: string
  name: string
  version: string
  /** Where an installed graph found this physical package. */
  source?: DependencySource
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
  source?: 'npm-lock' | 'pnpm-lock' | 'installed-node-modules'
  /** Evidence that DSH's shared host dependency plane was included. */
  hostRuntime?: {
    source: DependencyHostRuntimeSource
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
  /** npm's declaration that a peer can be absent without making the package unusable. */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
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
  /** Present on CLI-generated configs so the native DSH adapter can refresh the installed graph. */
  dshProfile?: {
    name: string
  }
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

export type CandidateDependencyGraphStatus = 'checked' | 'incomplete' | 'unavailable'

/** Result of resolving one exact upgrade candidate without loading or executing its package code. */
export interface CandidateDependencyGraphObservation {
  candidate: PackageCoordinate
  status: CandidateDependencyGraphStatus
  graph?: DependencyGraph
  error?: string
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
  /** Physical origins of the affected package; absent for legacy/npm-lock graphs. */
  affectedSources?: DependencySource[]
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

export interface CompatibilityDependencyFinding {
  package: PackageCoordinate
  advisory: VulnerabilityAdvisory
  paths: PackageCoordinate[][]
}

export interface CompatibilityDependencyCheck {
  status: CandidateDependencyGraphStatus
  nodeCount: number
  unresolvedCount: number
  findings: CompatibilityDependencyFinding[]
  error?: string
}

export interface CompatibilityUpgradeCandidate {
  candidate: PackageCoordinate
  signals: CompatibilitySignal[]
  dependencyCheck?: CompatibilityDependencyCheck
}

export type CompatibilityVulnerabilityStatus = 'checked' | 'unavailable' | 'not-requested'
export type CompatibilityDependencyStatus = 'checked' | 'partial' | 'unavailable' | 'not-requested'

/** A bounded explanation of which intermediate release is worth analyzing first. */
export interface CompatibilityUpgradePath {
  /** Number of newer manifests considered from the npm packument. */
  evaluated: number
  /** Number of considered candidates with a confirmed or strong blocker. */
  blockedCount: number
  /** Whether exact candidate versions were checked against the configured OSV source. */
  vulnerabilityStatus: CompatibilityVulnerabilityStatus
  /** Whether the candidate dependency graphs were checked; partial means only the earliest bounded prefix was resolved. */
  dependencyStatus?: CompatibilityDependencyStatus
  /** Number of candidate versions without a complete dependency check. */
  uncheckedCount?: number
  /** The first candidate without a deterministic blocker; this is not a safety verdict. */
  firstCandidate?: CompatibilityUpgradeCandidate
  /** A small sample of blocked candidates, kept for an actionable alert. */
  blocked: CompatibilityUpgradeCandidate[]
}

export interface CompatibilityEvent extends RadarEventBase {
  kind: 'compatibility'
  plugin: PackageCoordinate
  installed: PackageCoordinate
  candidate: PackageCoordinate
  signals: CompatibilitySignal[]
  upgradePath?: CompatibilityUpgradePath
  releaseNotes?: string
  releaseNotesUrl?: string
}

export type RadarSource = 'osv' | 'npm-releases' | 'npm-candidate-graphs' | 'github-releases'

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

export type AnalysisExposure = 'exposed' | 'likely_exposed' | 'not_exposed' | 'unknown'
export type AnalysisConfidence = 'high' | 'medium' | 'low'
export type AnalysisUrgency = 'immediate' | 'within_24_hours' | 'planned' | 'monitor'

/** The only conclusion shape that can be written back from a DSH model response. */
export interface AgentAnalysisResult {
  project_exposure: AnalysisExposure
  confidence: AnalysisConfidence
  evidence: string[]
  recommended_action: string
  urgency: AnalysisUrgency
  reasoning_summary: string
}

export interface AnalysisDeliveryTaskReference {
  taskId: string
  incidentId: string
  eventId: string
}

/** Durable proof that one exact Radar message was admitted to one DSH session. */
export interface AnalysisDelivery {
  schema: typeof ANALYSIS_DELIVERY_SCHEMA
  id: string
  messageId: string
  taskRefs: AnalysisDeliveryTaskReference[]
  projectId: string
  deliveredAt: string
  agentId?: string
  sessionId?: string
  userMessageId?: string
  userMessageSeq?: number
}

/** A verified model conclusion, attached to the exact event it analyzed. */
export interface StoredAnalysisResult extends AgentAnalysisResult {
  schema: typeof ANALYSIS_RESULT_SCHEMA
  taskId: string
  incidentId: string
  eventId: string
  deliveryId: string
  receivedAt: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string
}

export interface RadarState {
  schema: typeof RADAR_STATE_SCHEMA
  activeVulnerabilities: Record<string, StoredVulnerabilityMatch>
  activeCompatibility: Record<string, StoredCompatibilityMatch>
  pendingAnalysisTasks: AnalysisTask[]
  /** Optional for states written before model-result writeback was introduced. */
  analysisDeliveries?: Record<string, AnalysisDelivery>
  /** Optional for states written before model-result writeback was introduced. */
  analysisResults?: Record<string, StoredAnalysisResult>
  sourceHealth?: Record<string, SourceHealthStatus>
  activeSourceHealth?: Record<string, StoredSourceHealthMatch>
  /** Most recent state transitions, retained for local audit and diagnosis. */
  history?: RadarEvent[]
  /** Event ids successfully delivered to the currently configured webhook endpoint. */
  webhook?: WebhookDeliveryState
}

export interface WebhookDeliveryState {
  schema: typeof WEBHOOK_DELIVERY_SCHEMA
  /** SHA-256 of the normalized endpoint; the secret URL is never persisted. */
  endpointHash: string
  deliveredEventIds: Record<string, string>
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
