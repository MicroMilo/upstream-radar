export { decideVerdict, stricterVerdict, verdictAtLeast } from './policy.js'
export {
  inspectNpmPackage,
  parseNpmSpec,
  resolveNpmDependencyGraph,
  verifyIntegrity,
  verifyRegistrySignatures,
  type InspectNpmOptions,
  type IntegrityResult,
  type NpmDependencyGraphOptions,
  type ParsedNpmSpec,
} from './npm.js'
export { renderTextReport } from './render.js'
export { dependencyGraphDigest, findDependencyPaths, parseNpmLockGraph } from './graph.js'
export { parseInstalledNodeModulesGraph } from './installed-graph.js'
export { discoverDshRuntimeNodeModulesDirectory } from './dsh-runtime.js'
export { OsvClient, packageKey, type OsvClientOptions } from './osv.js'
export { NpmReleaseClient, type NpmReleaseCandidateStatus, type NpmReleaseClientOptions, type NpmReleaseObservation } from './npm-release.js'
export { MAX_CANDIDATE_GRAPHS, NpmCandidateGraphClient, type NpmCandidateGraphClientOptions } from './npm-candidate.js'
export { GitHubReleaseClient, type GitHubReleaseClientOptions, type ReleaseNotes, type ReleaseNotesSource } from './github-release.js'
export {
  emptyRadarState,
  pollRadar,
  type AdvisorySource,
  type CandidateDependencySource,
  type RadarPollResult,
  type ReleaseSource,
} from './radar.js'
export { assessCompatibilityChange, assessCompatibilityChanges, type CompatibilityChangeInput } from './compatibility.js'
export {
  DSH_LOAD_MATRIX_SCHEMA,
  DSH_LOAD_PROBE_SCHEMA,
  inspectDshLoadArtifact,
  probeDshLoad,
  probeDshLoadMatrix,
  renderDshLoadProbe,
  renderDshLoadMatrix,
  summarizeDshLoadResults,
  type DshLoadProbeArtifact,
  type DshLoadMatrixOptions,
  type DshLoadMatrixReport,
  type DshLoadMatrixSummary,
  type DshLoadProbeOptions,
  type DshLoadProbeReport,
  type DshLoadProbeResult,
  type DshProbeStage,
} from './dsh-probe.js'
export {
  COMPATIBILITY_BENCHMARK_SCHEMA,
  renderCompatibilityBenchmark,
  runCompatibilityBenchmark,
  type CompatibilityBenchmarkCaseResult,
  type CompatibilityBenchmarkReport,
} from './compatibility-benchmark.js'
export { createAnalysisTask, renderAgentAnalysisGroupPrompt, renderAgentAnalysisPrompt, renderDshAnalysisPrompt } from './dsh-analysis.js'
export {
  extractAnalysisTaskIds,
  parseAgentAnalysisResult,
  renderAnalysisTaskMarker,
} from './dsh-analysis-result.js'
export { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
export {
  createRadarConfigFromDshProfile,
  discoverDshProfiles,
  refreshRadarConfigFromConfiguredProfile,
  refreshRadarConfigFromDshProfile,
  resolveDshProfileDirectory,
  writeDshPatch,
  writeRadarConfig,
  type DshInitOptions,
  type InitInspector,
  type WriteDshPatchOptions,
  type WriteRadarConfigOptions,
} from './init.js'
export { loadRadarState, parseRadarState, saveRadarState } from './radar-state.js'
export {
  evaluateRadarPolicy,
  renderRadarPolicy,
  RADAR_FAIL_THRESHOLDS,
  type RadarFailThreshold,
  type RadarPolicyMatch,
  type RadarPolicyResult,
} from './radar-policy.js'
export {
  createRadarStatus,
  renderRadarStatus,
  RADAR_STATUS_SCHEMA,
  type CreateRadarStatusOptions,
  type RadarMonitoringStatus,
  type RadarCoverageStatus,
  type RadarStatusIncident,
  type RadarSourceStatus,
  type RadarStatusReport,
  type RadarStatusSource,
} from './radar-status.js'
export { renderRadarEvent, renderRadarEvents } from './radar-render.js'
export {
  createDoctorReport,
  renderDoctorReport,
  DOCTOR_SCHEMA,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorOverallStatus,
  type DoctorReport,
} from './doctor.js'
export { compareSemverValues, crossesBreakingVersionBoundary, parseSemver, satisfiesSemverRange } from './semver.js'
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
  ANALYSIS_DELIVERY_SCHEMA,
  ANALYSIS_RESULT_SCHEMA,
  DEPENDENCY_GRAPH_SCHEMA,
  INVENTORY_SCHEMA,
  RADAR_EVENT_SCHEMA,
  RADAR_CONFIG_SCHEMA,
  RADAR_STATE_SCHEMA,
  type AdvisoryMatch,
  type AnalysisTask,
  type AgentAnalysisResult,
  type AnalysisDelivery,
  type AnalysisDeliveryTaskReference,
  type CandidateDependencyGraphObservation,
  type CandidateDependencyGraphStatus,
  type CompatibilityDependencyCheck,
  type CompatibilityDependencyFinding,
  type CompatibilityDependencyStatus,
  type CompatibilityEvent,
  type CompatibilityUpgradeCandidate,
  type CompatibilityUpgradePath,
  type CompatibilityVulnerabilityStatus,
  type CompatibilitySignal,
  type DependencyEdge,
  type DependencyHostRuntimeSource,
  type DependencyGraph,
  type DependencyKind,
  type DependencyNode,
  type DependencySource,
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
  type StoredAnalysisResult,
  type SourceHealthEvent,
  type SourceHealthStatus,
  type StoredSourceHealthMatch,
  type VulnerabilityAdvisory,
  type VulnerabilityEvent,
} from './radar-types.js'
