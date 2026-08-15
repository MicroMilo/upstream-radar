import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { parsePackageManifestSnapshot } from './inventory.js'
import { parseNpmTarball } from './tar.js'

export const DSH_LOAD_PROBE_SCHEMA = 'upstream-radar.dsh-load-probe/v1alpha1' as const

const DEFAULT_DSH_VERSION = '0.1.0-rc.6'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

export type DshLoadProbeResult = 'compatible' | 'incompatible' | 'unknown'
export type DshProbeStageStatus = 'passed' | 'failed' | 'skipped'

export interface DshProbeStage {
  status: DshProbeStageStatus
  code?: number | null
  detail?: string
  output?: string
}

export interface DshLoadProbeReport {
  schema: typeof DSH_LOAD_PROBE_SCHEMA
  probe: 'dsh-load'
  scope: 'bundle-load-only'
  dshVersion: string
  artifact: {
    path: string
    sha256?: string
    name?: string
    version?: string
    bundlePatch?: string
    findings?: string[]
  }
  stages: {
    artifact: DshProbeStage
    profile: DshProbeStage
    install: DshProbeStage
    registration: DshProbeStage
    load: DshProbeStage
  }
  result: DshLoadProbeResult
  reason: string
  profileDirectory?: string
  boundary: string
}

export interface DshLoadProbeOptions {
  packagePath: string
  dshVersion?: string
  timeoutMs?: number
  keepProfile?: boolean
}

interface CommandResult {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export interface DshLoadProbeArtifact {
  path: string
  sha256: string
  name: string
  version: string
  bundlePatch: string
  findings: string[]
}

function bounded(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return normalized.length <= MAX_OUTPUT_BYTES ? normalized : `${normalized.slice(0, MAX_OUTPUT_BYTES - 1)}…`
}

function commandDetail(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  if (result.timedOut) return 'command timed out' + (output === '' ? '' : `: ${bounded(output)}`)
  return output === '' ? `command exited with ${result.code}` : bounded(output)
}

function stageFromCommand(result: CommandResult): DshProbeStage {
  return result.code === 0 && !result.timedOut
    ? { status: 'passed', code: result.code }
    : { status: 'failed', code: result.code, detail: commandDetail(result) }
}

function manifestValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function relativeBundlePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new Error('dsh.bundle.patch must be a relative package path')
  }
  if (isAbsolute(value) || value.includes('\\')) throw new Error('dsh.bundle.patch must stay inside the package')
  const normalized = posix.normalize(value.replace(/^\.\//, ''))
  if (normalized === '.' || normalized === '' || normalized.split('/').some(part => part === '..')) {
    throw new Error('dsh.bundle.patch must stay inside the package')
  }
  return normalized
}

export async function inspectDshLoadArtifact(packagePath: string): Promise<DshLoadProbeArtifact> {
  const path = resolve(packagePath)
  if (!path.endsWith('.tgz')) throw new Error('probe target must be a .tgz file')
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error('probe target must be a regular .tgz file')
  if (metadata.size > MAX_ARTIFACT_BYTES) throw new Error(`probe artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  const compressed = await readFile(path)
  const sha256 = createHash('sha256').update(compressed).digest('hex')
  const parsed = parseNpmTarball(compressed)
  const manifestEntry = parsed.entries.find(entry => entry.path === 'package.json' && entry.type === 'file')
  if (manifestEntry?.contents === undefined) throw new Error('probe artifact has no package.json')
  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(manifestEntry.contents.toString('utf8')) as unknown
  } catch {
    throw new Error('probe package.json is not valid JSON')
  }
  const manifest = parsePackageManifestSnapshot(rawManifest)
  const raw = manifestValue(rawManifest, 'package.json')
  const scripts = manifestValue(raw.scripts ?? {}, 'package.json scripts')
  const lifecycleScripts = LIFECYCLE_SCRIPTS.filter(name => typeof scripts[name] === 'string')
  if (lifecycleScripts.length > 0) {
    throw new Error(`probe refuses lifecycle scripts: ${lifecycleScripts.join(', ')}`)
  }
  const dsh = manifestValue(raw.dsh ?? {}, 'package.json dsh')
  const bundle = manifestValue(dsh.bundle ?? {}, 'package.json dsh.bundle')
  const bundlePatch = relativeBundlePath(bundle.patch)
  const patchEntry = parsed.entries.find(entry => entry.path === bundlePatch)
  if (patchEntry?.type !== 'file') throw new Error(`DSH bundle patch is missing: ${bundlePatch}`)
  return {
    path,
    sha256,
    name: manifest.name,
    version: manifest.version,
    bundlePatch,
    findings: parsed.findings.map(item => item.code).slice(0, 32),
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise(resolveResult => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    const collect = (target: Buffer[], chunk: Buffer, current: number, assign: (value: number) => void): void => {
      if (current >= MAX_OUTPUT_BYTES) return
      const remaining = MAX_OUTPUT_BYTES - current
      target.push(chunk.subarray(0, remaining))
      assign(current + Math.min(chunk.length, remaining))
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, options.timeoutMs)
    child.stdout.on('data', chunk => collect(stdout, Buffer.from(chunk), stdoutBytes, value => { stdoutBytes = value }))
    child.stderr.on('data', chunk => collect(stderr, Buffer.from(chunk), stderrBytes, value => { stderrBytes = value }))
    child.on('error', () => {
      clearTimeout(timer)
      resolveResult({ code: null, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolveResult({ code, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

function dshArgs(dshVersion: string, args: readonly string[]): string[] {
  return ['dlx', `--package=@deepseek-ai/dsh@${dshVersion}`, 'dsh', ...args]
}

function baseStageDetail(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error))
}

export async function probeDshLoad(options: DshLoadProbeOptions): Promise<DshLoadProbeReport> {
  const dshVersion = options.dshVersion ?? DEFAULT_DSH_VERSION
  if (!EXACT_VERSION.test(dshVersion)) throw new Error('DSH version must be an exact semantic version')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error('DSH probe timeout must be between 30000 and 600000 milliseconds')
  }
  const artifactPath = resolve(options.packagePath)
  const baseReport = {
    schema: DSH_LOAD_PROBE_SCHEMA,
    probe: 'dsh-load' as const,
    scope: 'bundle-load-only' as const,
    dshVersion,
    artifact: { path: artifactPath },
    stages: {
      artifact: { status: 'skipped' as const },
      profile: { status: 'skipped' as const },
      install: { status: 'skipped' as const },
      registration: { status: 'skipped' as const },
      load: { status: 'skipped' as const },
    },
    boundary: 'Compatible means only that the DSH profile registered and loaded the bundle. This probe does not run plugin business actions, test model behavior, or prove package safety.',
  }

  let artifact: DshLoadProbeArtifact
  try {
    artifact = await inspectDshLoadArtifact(artifactPath)
  } catch (error: unknown) {
    return {
      ...baseReport,
      stages: { ...baseReport.stages, artifact: { status: 'failed', detail: baseStageDetail(error) } },
      result: 'unknown',
      reason: 'artifact preflight could not establish a safe, loadable DSH bundle',
    }
  }
  const reportArtifact = {
    path: artifact.path,
    sha256: artifact.sha256,
    name: artifact.name,
    version: artifact.version,
    bundlePatch: artifact.bundlePatch,
    ...(artifact.findings.length === 0 ? {} : { findings: artifact.findings }),
  }
  const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-probe-'))
  const dshHome = join(scratch, 'dsh-home')
  const profile = 'headless'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_MODE: 'DISABLED',
    npm_config_ignore_scripts: 'true',
    PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
  }
  const run = (args: readonly string[]): Promise<CommandResult> => runCommand('pnpm', dshArgs(dshVersion, args), {
    cwd: process.cwd(),
    env,
    timeoutMs,
  })
  let report: DshLoadProbeReport | undefined
  try {
    const profileResult = await run(['--profile', profile, '--help'])
    const profileStage = stageFromCommand(profileResult)
    if (profileStage.status === 'failed') {
      report = {
        ...baseReport,
        artifact: reportArtifact,
        stages: { ...baseReport.stages, artifact: { status: 'passed' }, profile: profileStage },
        result: 'unknown',
        reason: 'the requested DSH runtime could not start the disposable profile',
      }
    } else {
      const installResult = await run(['plugin', '--profile', profile, 'add', artifact.path])
      const installStage = stageFromCommand(installResult)
      if (installStage.status === 'failed') {
        report = {
          ...baseReport,
          artifact: reportArtifact,
          stages: { ...baseReport.stages, artifact: { status: 'passed' }, profile: profileStage, install: installStage },
          result: 'unknown',
          reason: 'the disposable DSH profile could not install the reviewed artifact',
        }
      } else {
        let registered = false
        try {
          const profileManifest = JSON.parse(await readFile(join(dshHome, 'profiles', profile, 'package.json'), 'utf8')) as Record<string, unknown>
          const dsh = manifestValue(profileManifest.dsh, 'DSH profile dsh')
          const profileConfig = manifestValue(dsh.profile, 'DSH profile dsh.profile')
          const bundles = profileConfig.bundles
          registered = Array.isArray(bundles) && bundles.includes(artifact.name)
        } catch {
          registered = false
        }
        const registration: DshProbeStage = registered
          ? { status: 'passed' }
          : { status: 'failed', detail: `profile did not register ${artifact.name}` }
        if (!registered) {
          report = {
            ...baseReport,
            artifact: reportArtifact,
            stages: { ...baseReport.stages, artifact: { status: 'passed' }, profile: profileStage, install: installStage, registration },
            result: 'incompatible',
            reason: 'DSH accepted the install command but did not register the bundle in the profile',
          }
        } else {
          const loadResult = await run(['--profile', profile, '--dump-config'])
          const loadStage = stageFromCommand(loadResult)
          report = {
            ...baseReport,
            artifact: reportArtifact,
            stages: { ...baseReport.stages, artifact: { status: 'passed' }, profile: profileStage, install: installStage, registration, load: loadStage },
            result: loadStage.status === 'passed' ? 'compatible' : loadResult.timedOut ? 'unknown' : 'incompatible',
            reason: loadStage.status === 'passed'
              ? 'bundle registered and profile configuration loaded'
              : loadResult.timedOut
                ? 'profile load timed out before a compatibility result was established'
                : 'DSH profile configuration rejected the installed bundle',
          }
        }
      }
    }
  } finally {
    if (options.keepProfile) {
      if (report !== undefined) report = { ...report, profileDirectory: scratch }
    } else {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  if (report === undefined) throw new Error('DSH probe did not produce a result')
  return report
}

export function renderDshLoadProbe(report: DshLoadProbeReport): string {
  const lines = [
    'DSH load probe (disposable profile; load-only)',
    `Artifact: ${report.artifact.name ?? 'unknown'}@${report.artifact.version ?? 'unknown'}`,
    `DSH: ${report.dshVersion}`,
    '',
    `Result: ${report.result.toUpperCase()} — ${report.reason}`,
  ]
  for (const [name, stage] of Object.entries(report.stages)) {
    lines.push(`  ${name}: ${stage.status}${stage.detail === undefined ? '' : ` (${stage.detail})`}`)
  }
  if (report.profileDirectory !== undefined) lines.push(`Profile: ${report.profileDirectory}`)
  lines.push('', report.boundary)
  return `${lines.join('\n')}\n`
}
