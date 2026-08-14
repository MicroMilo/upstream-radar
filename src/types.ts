export const REPORT_SCHEMA = 'plugin-notary.scan/v1alpha1' as const

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
    graphDigest?: string
    invalidSignatures: string[]
    missingSignatures: string[]
    vulnerabilities: VulnerabilitySummary | null
    error?: string
  }
}

export interface ScanReport {
  schema: typeof REPORT_SCHEMA
  tool: {
    name: 'plugin-notary'
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
    npm?: NpmEvidence
  }
  coverage: Coverage
  findings: Finding[]
  riskVerdict: Verdict
  coverageVerdict: CoverageVerdict
  verdict: Verdict
}
