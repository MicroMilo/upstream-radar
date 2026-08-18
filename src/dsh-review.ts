import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { inspectNpmPackage, parseNpmSpec, type InspectNpmOptions } from './npm.js'
import {
  probeDshLoadMatrix,
  type DshLoadMatrixOptions,
  type DshLoadMatrixReport,
} from './dsh-probe.js'
import type { ScanReport } from './types.js'

export const DSH_PLUGIN_REVIEW_SCHEMA = 'upstream-radar.dsh-plugin-review/v1alpha1' as const

export type DshPluginReviewStatus = 'allow' | 'warn' | 'review' | 'block' | 'incompatible' | 'unknown'

export interface DshPluginReviewArtifact {
  path: string
  cleanup?: () => Promise<void>
}

export interface DshPluginReviewOptions {
  dshVersions: readonly string[]
  registry?: string
  timeoutMs?: number
  inspect?: (input: string, options?: InspectNpmOptions) => Promise<ScanReport>
  pack?: (input: string, options: { registry?: string; timeoutMs: number }) => Promise<DshPluginReviewArtifact>
  probe?: (options: DshLoadMatrixOptions) => Promise<DshLoadMatrixReport>
}

export interface DshPluginReviewReport {
  schema: typeof DSH_PLUGIN_REVIEW_SCHEMA
  target: {
    name: string
    version: string
    spec: string
  }
  inspection: ScanReport
  compatibility: DshLoadMatrixReport
  artifact: {
    inspectionDigest: string
    probeSha256: string
    matched: boolean
  }
  status: DshPluginReviewStatus
  nextStep: string
  execution: {
    npmPackLifecycleScripts: false
    pluginCode: false
    dshBusinessActions: false
    llm: false
  }
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const MAX_PACK_OUTPUT_BYTES = 256 * 1024

function bounded(value: string, maxLength = 2_048): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    const collect = (target: Buffer[], chunk: Buffer, current: number, assign: (value: number) => void): void => {
      if (current >= MAX_PACK_OUTPUT_BYTES) return
      const remaining = MAX_PACK_OUTPUT_BYTES - current
      target.push(chunk.subarray(0, remaining))
      assign(current + Math.min(chunk.length, remaining))
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', chunk => collect(stdout, Buffer.from(chunk), stdoutBytes, value => { stdoutBytes = value }))
    child.stderr.on('data', chunk => collect(stderr, Buffer.from(chunk), stderrBytes, value => { stderrBytes = value }))
    child.on('error', () => {
      clearTimeout(timer)
      resolveResult({ code: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolveResult({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut })
    })
  })
}

async function packNpmArtifact(
  input: string,
  options: { registry?: string; timeoutMs: number },
): Promise<DshPluginReviewArtifact> {
  const directory = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-review-'))
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', directory, input]
  if (options.registry !== undefined) args.push('--registry', options.registry)
  const result = await runCommand(command, args, options.timeoutMs)
  if (result.code !== 0 || result.timedOut) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    const detail = result.timedOut ? 'npm pack timed out' : `npm pack exited with ${result.code}`
    throw new Error(`${detail}: ${bounded([result.stdout, result.stderr].filter(Boolean).join('\n'))}`)
  }
  const files = (await readdir(directory)).filter(file => file.endsWith('.tgz'))
  if (files.length !== 1) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`npm pack produced ${files.length} tarballs; expected exactly one`)
  }
  const path = resolve(directory, files[0] as string)
  if (!path.startsWith(`${resolve(directory)}${sep}`)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw new Error('npm pack returned an artifact outside its temporary directory')
  }
  return {
    path,
    cleanup: async () => rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined),
  }
}

function statusFromReports(
  inspection: ScanReport,
  compatibility: DshLoadMatrixReport,
  artifactMatched: boolean,
): DshPluginReviewStatus {
  if (!artifactMatched) return 'unknown'
  if (compatibility.result === 'incompatible') return 'incompatible'
  if (compatibility.result === 'unknown') return 'unknown'
  return inspection.verdict
}

function nextStepFor(
  status: DshPluginReviewStatus,
  inspection: ScanReport,
  compatibility: DshLoadMatrixReport,
  artifactMatched: boolean,
): string {
  if (!artifactMatched) return 'The inspected and probed bytes differ; stop and repeat the review against one exact artifact.'
  if (status === 'incompatible') return 'Do not admit this bundle to the affected DSH release; inspect the failed matrix stage and compare the plugin patch with the DSH release.'
  if (status === 'unknown') return 'Resolve the incomplete artifact, dependency, or DSH load evidence before treating this plugin as compatible.'
  if (status === 'block') return 'Do not install this artifact until the blocking finding is resolved.'
  if (inspection.coverageVerdict === 'incomplete' && inspection.findings.length === 0) {
    const unresolved = inspection.evidence.npm?.dependencyAudit.graph?.unresolved ?? []
    const provenance = inspection.evidence.npm?.provenance.status
    const gaps = [
      ...(unresolved.length === 0 ? [] : [`${unresolved.length} unresolved dependency edge(s)`]),
      ...(provenance !== undefined && provenance !== 'verified' ? [`npm provenance ${provenance}`] : []),
    ]
    return gaps.length === 0
      ? 'No implemented risk finding was reported, but coverage is incomplete; inspect the raw evidence before treating the result as a clean approval.'
      : `No implemented risk finding was reported; complete ${gaps.join(' and ')} before treating the result as a clean approval.`
  }
  if (inspection.coverageVerdict === 'incomplete') return 'Review the findings and complete the missing dependency or provenance evidence before treating the result as a clean approval.'
  if (status === 'review' || status === 'warn') return 'Review the listed findings before admitting the plugin; the DSH load matrix alone is not a security approval.'
  return `The bundle loaded on all ${compatibility.summary.total} requested DSH versions; continue with normal dependency monitoring before upgrading production.`
}

function renderDependencyCoverage(lines: string[], inspection: ScanReport): void {
  const npm = inspection.evidence.npm
  const audit = npm?.dependencyAudit
  if (audit === undefined) return
  lines.push(
    `Dependency graph: ${audit.packages ?? 'not resolved'} packages`,
    `Unresolved dependency edges: ${audit.graph?.unresolved?.length ?? 0}`,
    `npm registry signature: ${npm?.registrySignature.status ?? 'not-checked'}`,
    `npm provenance: ${npm?.provenance.status ?? 'not-checked'}`,
  )
  const unresolved = audit.graph?.unresolved ?? []
  if (unresolved.length === 0) return
  const nodes = new Map((audit.graph?.nodes ?? []).map(node => [node.id, node]))
  for (const edge of unresolved.slice(0, 3)) {
    const parent = nodes.get(edge.from)
    const parentLabel = parent === undefined ? edge.from : `${parent.name}@${parent.version}`
    lines.push(`  Unresolved: ${display(parentLabel, 512)} -> ${display(`${edge.name}@${edge.spec}`, 512)} [${display(edge.kind, 32)}]`)
  }
  if (unresolved.length > 3) lines.push(`  ... ${unresolved.length - 3} more unresolved edge(s)`)
}

export async function reviewDshPlugin(input: string, options: DshPluginReviewOptions): Promise<DshPluginReviewReport> {
  const spec = parseNpmSpec(input)
  const timeoutMs = options.timeoutMs ?? 120_000
  const inspect = options.inspect ?? inspectNpmPackage
  const pack = options.pack ?? packNpmArtifact
  const probe = options.probe ?? probeDshLoadMatrix
  const inspection = await inspect(spec.canonical, {
    deep: true,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    timeoutMs,
  })
  const artifact = await pack(spec.canonical, {
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    timeoutMs,
  })
  try {
    const compatibility = await probe({
      packagePath: artifact.path,
      dshVersions: options.dshVersions,
      timeoutMs,
    })
    const inspectionDigest = inspection.target.artifactDigest
    const probeSha256 = compatibility.artifact.sha256
    const artifactMatched = typeof probeSha256 === 'string'
      && inspectionDigest === `sha256:${probeSha256}`
    const status = statusFromReports(inspection, compatibility, artifactMatched)
    return {
      schema: DSH_PLUGIN_REVIEW_SCHEMA,
      target: { name: spec.name, version: spec.version, spec: spec.canonical },
      inspection,
      compatibility,
      artifact: { inspectionDigest, probeSha256: probeSha256 ?? 'unknown', matched: artifactMatched },
      status,
      nextStep: nextStepFor(status, inspection, compatibility, artifactMatched),
      execution: {
        npmPackLifecycleScripts: false,
        pluginCode: false,
        dshBusinessActions: false,
        llm: false,
      },
    }
  } finally {
    await artifact.cleanup?.()
  }
}

function display(value: string, maxLength = 1_024): string {
  return bounded(value, maxLength)
}

export function renderDshPluginReview(report: DshPluginReviewReport): string {
  const vulnerabilities = report.inspection.evidence.npm?.dependencyAudit.vulnerabilities
  const installScriptPackages = report.inspection.evidence.npm?.dependencyAudit.installScriptPackages
  const installScriptDetails = report.inspection.evidence.npm?.dependencyAudit.installScriptDetails
  const lines = [
    'Upstream Radar — DSH plugin review',
    `Plugin: ${display(`${report.target.name}@${report.target.version}`)}`,
    `Overall: ${report.status.toUpperCase()}`,
    `Exact artifact: ${report.artifact.matched ? 'same bytes for inspection and DSH probe' : 'MISMATCH'}`,
    `Dependency review: ${report.inspection.verdict.toUpperCase()} (coverage ${report.inspection.coverageVerdict})`,
    `Known vulnerabilities: ${vulnerabilities === null || vulnerabilities === undefined ? 'not checked' : vulnerabilities.total}`,
    `Install-time dependency scripts: ${installScriptPackages === undefined ? 'not checked' : installScriptPackages.length === 0 ? '0' : installScriptPackages.join(', ')}`,
    `DSH load matrix: ${report.compatibility.result.toUpperCase()} (${report.compatibility.summary.compatible}/${report.compatibility.summary.total} versions loaded)`,
  ]
  renderDependencyCoverage(lines, report.inspection)
  for (const item of report.compatibility.reports) {
    lines.push(`  DSH ${display(item.dshVersion, 128)}: ${item.result.toUpperCase()} — ${display(item.reason, 1_024)}`)
  }
  for (const detail of installScriptDetails ?? []) {
    for (const script of detail.scripts) lines.push(`  ${display(`${detail.package} ${script.name}: ${script.command}`, 2_048)}`)
  }
  if (report.inspection.findings.length === 0) {
    lines.push('Findings: none in the implemented static checks')
  } else {
    lines.push(`Findings: ${report.inspection.findings.length}`)
    for (const finding of report.inspection.findings.slice(0, 8)) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${display(finding.code)}: ${display(finding.summary)}`)
      if (finding.remediation !== undefined) lines.push(`  Fix: ${display(finding.remediation, 2_048)}`)
    }
  }
  lines.push(
    `Next: ${display(report.nextStep, 2_048)}`,
    'Boundary: lifecycle scripts disabled; plugin code and business actions not executed; no LLM called.',
  )
  return `${lines.join('\n')}\n`
}
