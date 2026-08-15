export { decideVerdict, stricterVerdict, verdictAtLeast } from './policy.js'
export {
  inspectNpmPackage,
  parseNpmSpec,
  verifyIntegrity,
  verifyRegistrySignatures,
  type InspectNpmOptions,
  type IntegrityResult,
  type ParsedNpmSpec,
} from './npm.js'
export { renderTextReport } from './render.js'
export { findDependencyPaths, parseNpmLockGraph } from './graph.js'
export { OsvClient, packageKey, type OsvClientOptions } from './osv.js'
export { NpmReleaseClient, type NpmReleaseClientOptions, type NpmReleaseObservation } from './npm-release.js'
export { GitHubReleaseClient, type GitHubReleaseClientOptions, type ReleaseNotes, type ReleaseNotesSource } from './github-release.js'
export { emptyRadarState, pollRadar, type AdvisorySource, type RadarPollResult, type ReleaseSource } from './radar.js'
export { assessCompatibilityChange, assessCompatibilityChanges, type CompatibilityChangeInput } from './compatibility.js'
export { createAnalysisTask, renderAgentAnalysisPrompt, renderDshAnalysisPrompt } from './dsh-analysis.js'
export { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
export {
  createRadarConfigFromDshProfile,
  resolveDshProfileDirectory,
  writeDshPatch,
  writeRadarConfig,
  type DshInitOptions,
  type InitInspector,
  type WriteDshPatchOptions,
  type WriteRadarConfigOptions,
} from './init.js'
export { loadRadarState, parseRadarState, saveRadarState } from './radar-state.js'
export { renderRadarEvent, renderRadarEvents } from './radar-render.js'
export { crossesBreakingVersionBoundary, parseSemver, satisfiesSemverRange } from './semver.js'
export { scanDirectory, type ScanOptions } from './scan.js'
export { parseNpmTarball, type ParsedNpmTarball, type TarEntry, type TarOptions } from './tar.js'
export { TOOL_VERSION } from './version.js'
export {
  REPORT_SCHEMA,
  type CheckStatus,
  type Coverage,
  type CoverageVerdict,
  type DependencyEvidence,
  type DshEvidence,
  type Finding,
  type LifecycleScriptEvidence,
  type NpmEvidence,
  type NpmProvenanceEvidence,
  type ScanReport,
  type Severity,
  type Verdict,
  type VulnerabilitySummary,
} from './types.js'
export {
  ANALYSIS_TASK_SCHEMA,
  DEPENDENCY_GRAPH_SCHEMA,
  INVENTORY_SCHEMA,
  RADAR_EVENT_SCHEMA,
  RADAR_CONFIG_SCHEMA,
  RADAR_STATE_SCHEMA,
  type AdvisoryMatch,
  type AnalysisTask,
  type CompatibilityEvent,
  type CompatibilitySignal,
  type DependencyEdge,
  type DependencyGraph,
  type DependencyKind,
  type DependencyNode,
  type EventRoute,
  type PackageCoordinate,
  type PackageManifestSnapshot,
  type PluginInstallation,
  type ProjectInventory,
  type ProjectReference,
  type RadarEvent,
  type RadarConfig,
  type RadarSource,
  type RadarSeverity,
  type RadarState,
  type SourceHealthEvent,
  type SourceHealthStatus,
  type StoredSourceHealthMatch,
  type VulnerabilityAdvisory,
  type VulnerabilityEvent,
} from './radar-types.js'
