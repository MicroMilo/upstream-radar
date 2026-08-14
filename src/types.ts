export const REPORT_SCHEMA = 'plugin-notary.scan/v1alpha1' as const

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export type Verdict = 'allow' | 'warn' | 'review' | 'block'

export type CoverageVerdict = 'complete' | 'incomplete'

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
  dependencyResolution: 'manifest-only'
  provenance: 'not-checked'
  sourceArtifactMatch: 'not-checked'
  sandboxDetonation: 'not-run'
}

export interface ScanReport {
  schema: typeof REPORT_SCHEMA
  tool: {
    name: 'plugin-notary'
    version: string
  }
  target: {
    kind: 'directory'
    name: string
    version: string | null
    artifactDigest: string
  }
  dsh: DshEvidence
  evidence: {
    filesScanned: number
    bytesHashed: number
    lockfiles: string[]
    packageManager: string | null
    lifecycleScripts: LifecycleScriptEvidence[]
    dependencies: DependencyEvidence[]
  }
  coverage: Coverage
  findings: Finding[]
  riskVerdict: Verdict
  coverageVerdict: CoverageVerdict
  verdict: Verdict
}
