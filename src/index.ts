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
export { dependencyGraphDigest, findDependencyPaths, parseNpmLockGraph, parsePnpmLockGraph } from './graph.js'
export { parseInstalledNodeModulesGraph } from './installed-graph.js'
export {
  discoverDshRuntimeNodeModulesDirectory,
  discoverDshRuntimePackage,
  discoverDshRuntimePackageDirectory,
  discoverDshRuntimePackageFromNodeModulesDirectory,
} from './dsh-runtime.js'
export { OsvClient, packageKey, type OsvClientOptions } from './osv.js'
export { NpmReleaseClient, type NpmReleaseCandidateStatus, type NpmReleaseClientOptions, type NpmReleaseObservation } from './npm-release.js'
export { MAX_CANDIDATE_GRAPHS, NpmCandidateGraphClient, type NpmCandidateGraphClientOptions } from './npm-candidate.js'
export { GitHubReleaseClient, type GitHubReleaseClientOptions, type ReleaseNotes, type ReleaseNotesSource } from './github-release.js'
export { GitHubAdvisoryClient, type GitHubAdvisoryClientOptions } from './github-advisory.js'
export {
  CisaKevClient,
  EpssClient,
  THREAT_INTEL_REFERENCES,
  type CisaKevClientOptions,
  type EpssClientOptions,
  type ThreatIntelSource,
  type ThreatIntelSourceBinding,
} from './threat-intel.js'
export {
  emptyRadarState,
  pollRadar,
  type AdvisorySource,
  type AdvisorySourceBinding,
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
export { DEMO_SCHEMA, createDemoEvent, createDemoReport, renderDemo, type DemoReport } from './demo.js'
export {
  QUICKSTART_SCHEMA,
  createQuickstartReport,
  renderQuickstartReport,
  type QuickstartEffect,
  type QuickstartMode,
  type QuickstartOptions,
  type QuickstartReport,
  type QuickstartStep,
} from './quickstart.js'
export {
  extractAnalysisTaskIds,
  parseAgentAnalysisResult,
  renderAnalysisTaskMarker,
} from './dsh-analysis-result.js'
export { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
export {
  countPolicyHeldAnalysisTasks,
  createNotificationPolicyMap,
  decideProjectRadarNotification,
  decideRadarNotification,
  filterNotifiableRadarEvents,
  type NotificationDecision,
  type NotificationSuppressionReason,
} from './notification-policy.js'
export {
  createRadarConfigFromDshProfile,
  createRadarConfigFromNpmLock,
  createRadarConfigFromPnpmLock,
  discoverDshProfiles,
  refreshRadarConfigFromConfiguredProfile,
  refreshRadarConfigFromDshProfile,
  resolveDshProfileDirectory,
  writeDshPatch,
  writeRadarConfig,
  type DshInitOptions,
  type NpmLockInitOptions,
  type PnpmLockInitOptions,
  type InitInspector,
  type WriteDshPatchOptions,
  type WriteRadarConfigOptions,
} from './init.js'
export { loadRadarState, parseRadarState, saveRadarState } from './radar-state.js'
export {
  RADAR_WEBHOOK_SCHEMA,
  buildRadarWebhookPayload,
  buildFeishuWebhookPayload,
  isFeishuV2WebhookUrl,
  markRadarWebhookEventsDelivered,
  normalizeRadarWebhookUrl,
  queueRadarWebhookEvents,
  radarWebhookEndpointHash,
  sendRadarWebhook,
  toRadarWebhookEventNotice,
  undeliveredRadarWebhookEvents,
  type RadarWebhookEventNotice,
  type RadarWebhookPayload,
  type FeishuWebhookPayload,
  type SendRadarWebhookOptions,
} from './webhook.js'
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
  type RadarStatusTriage,
  type RadarSourceStatus,
  type RadarStatusReport,
  type RadarStatusSource,
} from './radar-status.js'
export {
  createRadarHistory,
  renderRadarHistory,
  RADAR_HISTORY_REPORT_SCHEMA,
  type CreateRadarHistoryOptions,
  type RadarHistoryReport,
} from './radar-history.js'
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
  MAX_RADAR_HISTORY_EVENTS,
  RADAR_EVENT_SCHEMA,
  RADAR_CONFIG_SCHEMA,
  RADAR_HISTORY_SCHEMA,
  RADAR_STATE_SCHEMA,
  WEBHOOK_DELIVERY_SCHEMA,
  type AdvisoryConflict,
  type AdvisoryConflictClaim,
  type AdvisoryConflictField,
  type AdvisoryMatch,
  type AdvisorySourceName,
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
  type CompatibilityRemediationCoverage,
  type CompatibilityUpgradeCandidate,
  type CompatibilityUpgradePath,
  type CompatibilityVulnerabilityRemediation,
  type CompatibilityVulnerabilityRemediationStatus,
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
  type RadarNotificationPolicy,
  type RadarSource,
  type RadarSeverity,
  type RadarState,
  type StoredAnalysisResult,
  type SourceHealthEvent,
  type SourceHealthStatus,
  type StoredSourceHealthMatch,
  type VulnerabilityAdvisory,
  type VulnerabilityEvent,
  type WebhookDeliveryState,
} from './radar-types.js'
