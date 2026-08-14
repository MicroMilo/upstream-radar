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
