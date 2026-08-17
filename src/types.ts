import type { DependencyGraph } from './radar-types.js'

export const REPORT_SCHEMA = 'upstream-radar.scan/v1alpha1' as const

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export type Verdict = 'allow' | 'warn' | 'review' | 'block'

export type CoverageVerdict = 'complete' | 'incomplete'

export type CheckStatus = 'verified' | 'missing' | 'invalid' | 'failed' | 'not-checked' | 'present-unverified'

export interface Finding {
  code: string
  severity: Severity
  summary: string
  detail: string
  evidence?: Record<string, boolean | number | string | string[]>
  remediation?: string
}

export interface DependencyEvidence {
  name: string
  scope: 'dependency' | 'devDependency' | 'optionalDependency' | 'peerDependency'
  spec: string
}

export interface LifecycleScriptEvidence {
  name: string
  command: string
}

export interface NpmInstallScriptPackage {
  package: string
  scripts: LifecycleScriptEvidence[]
}

export interface DshEvidence {
  isBundle: boolean
  patch?: string
}

export interface Coverage {
  staticSource: 'complete' | 'incomplete'
  artifactIntegrity: 'locally-hashed' | 'verified' | 'invalid' | 'not-checked'
  registrySignature: CheckStatus
  dependencyResolution: 'manifest-only' | 'resolved'
  provenance: CheckStatus
  sourceArtifactMatch: 'not-checked' | 'matched' | 'mismatch'
  sandboxDetonation: 'not-run'
}

export interface VulnerabilitySummary {
  info: number
  low: number
  moderate: number
  high: number
  critical: number
  total: number
}

export interface NpmProvenanceEvidence {
  status: CheckStatus
  predicateType?: string
  sourceRepository?: string
  sourceRef?: string
  sourceCommit?: string
  workflow?: string
  builder?: string
}

export type NpmDependencyResolutionMode = 'strict' | 'legacy-peer-deps'

export interface NpmEvidence {
  registry: string
  tarball: string
  compressedBytes: number
  unpackedBytes: number
  integrity: {
    status: 'verified' | 'invalid'
    algorithm: string
    expected: string
    actual: string
  }
  registrySignature: {
    status: CheckStatus
    keyIds: string[]
  }
  provenance: NpmProvenanceEvidence
  dependencyAudit: {
    status: 'not-run' | 'verified' | 'findings' | 'failed'
    packages: number | null
    resolutionMode?: NpmDependencyResolutionMode
    graphDigest?: string
    graph?: DependencyGraph
    /** Exact reachable packages whose npm lock entry declares an install-time script. */
    installScriptPackages?: string[]
    /** The exact lifecycle names and commands read from those package manifests. */
    installScriptDetails?: NpmInstallScriptPackage[]
    invalidSignatures: string[]
    missingSignatures: string[]
    vulnerabilities: VulnerabilitySummary | null
    error?: string
  }
}

export interface ScanReport {
  schema: typeof REPORT_SCHEMA
  tool: {
    name: 'upstream-radar'
    version: string
  }
  target: {
    kind: 'directory' | 'npm'
    name: string
    version: string | null
    artifactDigest: string
    treeDigest?: string
    spec?: string
  }
  dsh: DshEvidence
  evidence: {
    filesScanned: number
    bytesHashed: number
    lockfiles: string[]
    packageManager: string | null
    lifecycleScripts: LifecycleScriptEvidence[]
    dependencies: DependencyEvidence[]
    dependencyGraph?: DependencyGraph
    dependencyGraphError?: string
    npm?: NpmEvidence
  }
  coverage: Coverage
  findings: Finding[]
  riskVerdict: Verdict
  coverageVerdict: CoverageVerdict
  verdict: Verdict
}
