import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { extractPnpmRequiredDependencyBuilds } from './dsh-install-observation.js'
import { parseNpmSpec } from './npm.js'
import { parseNpmTarball } from './tar.js'
import { TOOL_VERSION } from './version.js'

export const DSH_SURFACE_OBSERVATION_SCHEMA = 'upstream-radar.dsh-surface-observation/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const BARE_SHA256 = /^[a-f0-9]{64}$/
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_ARTIFACT_UNPACKED_BYTES = 192 * 1024 * 1024
const MAX_SURFACE_ERRORS = 32
const MAX_ALLOWED_BUILDS = 32
const MAX_EVIDENCE_TEXT = 2_048
const MAX_TUI_BYTES = 256 * 1024
const WEB_PORT = 30_880

export type DshExecutionPlane = 'web' | 'tui'
export type DshSurfaceObservationResult = 'compatible' | 'surface-incompatible' | 'environment-unsupported' | 'unknown'
export type DshSurfaceFailedStage = 'host' | 'surface' | 'interaction' | 'shutdown'
export type DshSurfaceIsolationProvider = 'github-actions-hosted-runner' | 'firecracker' | 'other'

export interface DshSurfaceStage {
  status: 'passed' | 'failed' | 'skipped'
  code?: number | null
  detail?: string
  timedOut?: boolean
  outputExceeded?: boolean
}

export interface DshWebSurfaceEvidence {
  plane: 'web'
  url: string
  httpStatus?: number
  title?: string
  rootMounted: boolean
  bootManifestPresent: boolean
  /** Bounded module ids exposed by DSH, retained to make id mismatches diagnosable. */
  bootEntryIds?: string[]
  pluginEntryPresent: boolean
  pluginBundleUrl?: string
  pluginBundleStatus?: number
  /** The framework-free DSH boot page handed the root to the assembled app. */
  applicationMounted: boolean
  /** Inferred from DSH's guarantee that hand-off follows activation of every graph entry. */
  pluginMaterialized: boolean
  bootFailureText?: string
  consoleErrors: string[]
  pageErrors: string[]
  failedRequests: string[]
  blockedExternalRequests?: string[]
  screenshot?: string
  trace?: string
  hostLog?: string
}

export interface DshTuiSurfaceEvidence {
  plane: 'tui'
  terminal: 'xterm-256color'
  columns: number
  rows: number
  frameObserved: boolean
  inputSent: boolean
  exitedAfterShutdown: boolean
  exitCode?: number
  signal?: number
  transcript?: string
  normalizedFrame: string
  capturedBytes: number
  truncated: boolean
}

export interface DshSurfaceObservationReport {
  schema: typeof DSH_SURFACE_OBSERVATION_SCHEMA
  tool: { name: 'upstream-radar'; version: string }
  probe: 'dsh-surface'
  scope: 'surface-runtime-behavior'
  startedAt: string
  completedAt: string
  caseId: string
  sourceCaseId: string
  sourceFingerprint: string
  contractFingerprint: string
  plugin: string
  dshVersion: string
  plane: DshExecutionPlane
  profile: string
  runtimeId: string
  runtime: {
    nodeMajor: number
    nodeVersion: string
    platform: string
    architecture: string
    pnpmVersion?: string
  }
  artifact: {
    sha256?: string
    bytes?: number
    integrity?: string
  }
  stages: {
    runtime: DshSurfaceStage
    artifact: DshSurfaceStage
    profile: DshSurfaceStage
    install: DshSurfaceStage
    registration: DshSurfaceStage
    host: DshSurfaceStage
    surface: DshSurfaceStage
    interaction: DshSurfaceStage
    shutdown: DshSurfaceStage
  }
  evidence: DshWebSurfaceEvidence | DshTuiSurfaceEvidence
  result: DshSurfaceObservationResult
  reason: string
  boundary: {
    isolationProviderClaim: DshSurfaceIsolationProvider
    isolationVerifiedByRadar: false
    disposableEnvironmentRequired: true
    inheritedHostSecrets: false
    externalBrowserRequestsBlocked: boolean
    approvedDependencyBuilds: string[]
    note: string
  }
}

export interface DshWebEvaluationInput {
  driverAvailable: boolean
  hostStarted: boolean
  httpStatus?: number
  rootMounted: boolean
  bootManifestPresent: boolean
  pluginEntryPresent: boolean
  pluginBundleStatus?: number
  applicationMounted: boolean
  pluginMaterialized: boolean
  bootFailureText?: string
  consoleErrors: readonly string[]
  pageErrors: readonly string[]
  failedRequests: readonly string[]
}

export interface DshTuiEvaluationInput {
  driverAvailable: boolean
  frameObserved: boolean
  inputSent: boolean
  exitedAfterShutdown: boolean
  exitCode?: number
}

export interface DshSurfaceEvaluation {
  result: DshSurfaceObservationResult
  failedStage: DshSurfaceFailedStage | undefined
  reason: string
}

export interface DshSurfaceObservationOptions {
  packageSpec: string
  dshVersion: string
  caseId: string
  sourceCaseId: string
  sourceFingerprint: string
  contractFingerprint: string
  plane: DshExecutionPlane
  profile: string
  runtimeId: string
  expectedArtifactSha256: string
  allowedBuilds?: readonly string[]
  allowExecution: boolean
  isolationProvider: DshSurfaceIsolationProvider
  timeoutMs?: number
  artifactsDirectory?: string
  hostEnvironment?: NodeJS.ProcessEnv
  driverRoot?: string
  chromiumExecutable?: string
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
  launchError?: string
}

interface PackedArtifact {
  path: string
  filename: string
  sha256: string
  bytes: number
  integrity?: string
}

interface BrowserRoute {
  request(): { url(): string }
  continue(): Promise<void>
  abort(errorCode?: string): Promise<void>
}

interface BrowserPage {
  on(event: 'console', listener: (message: { type(): string; text(): string }) => void): void
  on(event: 'pageerror', listener: (error: Error) => void): void
  on(event: 'requestfailed', listener: (request: { url(): string; failure(): { errorText?: string } | null }) => void): void
  route(pattern: string, listener: (route: BrowserRoute) => Promise<void>): Promise<void>
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>
  title(): Promise<string>
  evaluate<Result, Argument>(pageFunction: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result>
  waitForFunction<Argument>(pageFunction: (argument: Argument) => unknown, argument: Argument, options: { timeout: number }): Promise<unknown>
  screenshot(options: { path: string; fullPage: boolean }): Promise<void>
}

interface BrowserContext {
  newPage(): Promise<BrowserPage>
  tracing: {
    start(options: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>
    stop(options: { path: string }): Promise<void>
  }
  close(): Promise<void>
}

interface Browser {
  newContext(options: { serviceWorkers: 'block' }): Promise<BrowserContext>
  close(): Promise<void>
}

interface PlaywrightDriver {
  chromium: {
    launch(options: { headless: boolean; executablePath?: string; args: string[]; env: Record<string, string> }): Promise<Browser>
  }
}

interface PtyProcess {
  write(data: string): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

interface PtyDriver {
  spawn(file: string, args: string[], options: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  }): PtyProcess
}

function bounded(value: string, maximum = MAX_EVIDENCE_TEXT): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  )).slice(0, maximum)
}

function boundedList(values: readonly string[]): string[] {
  return values.slice(0, MAX_SURFACE_ERRORS).map(value => bounded(value, 512))
}

export function evaluateDshWebEvidence(input: DshWebEvaluationInput): DshSurfaceEvaluation {
  if (!input.driverAvailable) {
    return { result: 'environment-unsupported', failedStage: 'surface', reason: 'the isolated runner has no usable Chromium/Playwright driver' }
  }
  if (!input.hostStarted) {
    return { result: 'surface-incompatible', failedStage: 'host', reason: 'the exact DSH Web profile exited before exposing an HTTP surface' }
  }
  if (input.httpStatus === undefined || input.httpStatus < 200 || input.httpStatus >= 400) {
    return { result: 'surface-incompatible', failedStage: 'host', reason: `the DSH Web endpoint returned HTTP ${input.httpStatus ?? 'unknown'}` }
  }
  if (!input.rootMounted) {
    return { result: 'surface-incompatible', failedStage: 'surface', reason: 'the Web document loaded but the DSH root did not mount' }
  }
  if (!input.bootManifestPresent) {
    return { result: 'surface-incompatible', failedStage: 'surface', reason: 'the Web document did not expose a valid DSH boot manifest' }
  }
  if (!input.pluginEntryPresent) {
    return { result: 'surface-incompatible', failedStage: 'surface', reason: 'the declared plugin client entry is absent from the DSH boot manifest' }
  }
  if (input.pluginBundleStatus === undefined || input.pluginBundleStatus < 200 || input.pluginBundleStatus >= 400) {
    return { result: 'surface-incompatible', failedStage: 'surface', reason: `the declared plugin client bundle returned HTTP ${input.pluginBundleStatus ?? 'unknown'}` }
  }
  if (!input.applicationMounted) {
    const detail = input.bootFailureText === undefined ? '' : `: ${bounded(input.bootFailureText, 512)}`
    return { result: 'surface-incompatible', failedStage: 'surface', reason: `DSH Web did not hand off from its boot page to the assembled application${detail}` }
  }
  if (!input.pluginMaterialized) {
    return { result: 'surface-incompatible', failedStage: 'surface', reason: 'DSH mounted the application but could not establish activation of the declared plugin client entry' }
  }
  if (input.pageErrors.length > 0) {
    return { result: 'surface-incompatible', failedStage: 'interaction', reason: `the browser observed ${input.pageErrors.length} uncaught page error(s) after plugin materialization` }
  }
  return {
    result: 'compatible',
    failedStage: undefined,
    reason: 'the Web host mounted and the declared plugin client entry was published, fetched, and materialized',
  }
}

export function evaluateDshTuiEvidence(input: DshTuiEvaluationInput): DshSurfaceEvaluation {
  if (!input.driverAvailable) {
    return { result: 'environment-unsupported', failedStage: 'surface', reason: 'the isolated runner has no usable pseudo-terminal driver' }
  }
  if (!input.frameObserved) {
    return { result: 'surface-incompatible', failedStage: 'surface', reason: 'the DSH TUI exited or timed out before producing a terminal frame' }
  }
  if (!input.inputSent) {
    return { result: 'unknown', failedStage: 'interaction', reason: 'a TUI frame was visible but the observer could not send bounded terminal input' }
  }
  if (!input.exitedAfterShutdown) {
    return { result: 'surface-incompatible', failedStage: 'shutdown', reason: 'the TUI produced a frame but did not stop after the bounded shutdown input' }
  }
  return {
    result: 'compatible',
    failedStage: undefined,
    reason: 'the TUI produced a real PTY frame, accepted input, and completed controlled shutdown',
  }
}

export function dshSurfaceProfileStrategy(plane: DshExecutionPlane): 'initialize-stock-profile' | 'create-with-plugin-add' {
  return plane === 'web' ? 'initialize-stock-profile' : 'create-with-plugin-add'
}

function skippedStages(): DshSurfaceObservationReport['stages'] {
  return {
    runtime: { status: 'skipped' },
    artifact: { status: 'skipped' },
    profile: { status: 'skipped' },
    install: { status: 'skipped' },
    registration: { status: 'skipped' },
    host: { status: 'skipped' },
    surface: { status: 'skipped' },
    interaction: { status: 'skipped' },
    shutdown: { status: 'skipped' },
  }
}

function emptyEvidence(plane: DshExecutionPlane): DshWebSurfaceEvidence | DshTuiSurfaceEvidence {
  return plane === 'web'
    ? {
        plane: 'web',
        url: `http://127.0.0.1:${WEB_PORT}/`,
        rootMounted: false,
        bootManifestPresent: false,
        bootEntryIds: [],
        pluginEntryPresent: false,
        applicationMounted: false,
        pluginMaterialized: false,
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
      }
    : {
        plane: 'tui',
        terminal: 'xterm-256color',
        columns: 100,
        rows: 32,
        frameObserved: false,
        inputSent: false,
        exitedAfterShutdown: false,
        normalizedFrame: '',
        capturedBytes: 0,
        truncated: false,
      }
}

function finish(report: DshSurfaceObservationReport, result: DshSurfaceObservationResult, reason: string): DshSurfaceObservationReport {
  report.completedAt = new Date().toISOString()
  report.result = result
  report.reason = bounded(reason)
  return report
}

function commandStage(result: CommandResult): DshSurfaceStage {
  if (result.code === 0 && !result.timedOut && !result.outputExceeded && result.launchError === undefined) {
    return { status: 'passed', code: 0 }
  }
  const detail = [result.launchError, result.stderr, result.stdout].filter(value => value !== undefined && value !== '').join('\n').trim()
  const summary = result.timedOut
    ? 'command timed out'
    : result.outputExceeded
      ? 'command exceeded the output budget'
      : result.launchError !== undefined
        ? 'command could not start'
        : `command exited with ${result.code}`
  return {
    status: 'failed',
    code: result.code,
    detail: bounded(detail === '' ? summary : `${summary}: ${detail}`),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.outputExceeded ? { outputExceeded: true } : {}),
  }
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let outputExceeded = false
    let timedOut = false
    let settled = false
    let launchError: string | undefined
    const terminate = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const finishResult = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputExceeded,
        ...(launchError === undefined ? {} : { launchError }),
      })
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (bytes + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true
        terminate()
        return
      }
      bytes += chunk.length
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', error => {
      launchError = bounded(error.message)
      finishResult(null)
    })
    child.once('close', code => finishResult(code))
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
  })
}

function controlledEnvironment(root: string, host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (host[key] !== undefined) env[key] = host[key]
  }
  env.HOME = join(root, 'home')
  env.DSH_HOME = join(root, 'dsh-home')
  env.TMPDIR = join(root, 'tmp')
  env.XDG_CACHE_HOME = join(root, 'cache')
  env.XDG_CONFIG_HOME = join(root, 'config')
  env.XDG_DATA_HOME = join(root, 'data')
  env.NPM_CONFIG_CACHE = join(root, 'npm-cache')
  env.NPM_CONFIG_USERCONFIG = join(root, 'controlled.npmrc')
  env.NPM_CONFIG_GLOBALCONFIG = join(root, 'controlled-global.npmrc')
  env.NPM_CONFIG_AUDIT = 'false'
  env.NPM_CONFIG_FUND = 'false'
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  env.PNPM_HOME = join(root, 'pnpm-home')
  env.COREPACK_HOME = join(root, 'corepack-home')
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = join(root, 'controlled.gitconfig')
  env.GIT_TERMINAL_PROMPT = '0'
  env.DSH_PERMISSION_MODE = 'read-only'
  env.DSH_TELEMETRY_MODE = 'DISABLED'
  env.CI = 'true'
  env.NO_COLOR = '1'
  return env
}

function scriptPolicy(environment: NodeJS.ProcessEnv, enabled: boolean): NodeJS.ProcessEnv {
  const value = enabled ? 'false' : 'true'
  return {
    ...environment,
    NPM_CONFIG_IGNORE_SCRIPTS: value,
    npm_config_ignore_scripts: value,
    PNPM_CONFIG_IGNORE_SCRIPTS: value,
  }
}

function normalizeAllowedBuilds(values: readonly string[] | undefined): string[] {
  if (values === undefined) return []
  if (values.length > MAX_ALLOWED_BUILDS) throw new Error(`DSH surface observation accepts at most ${MAX_ALLOWED_BUILDS} approved dependency builds`)
  const names = new Set<string>()
  for (const value of values) {
    if (value.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)) {
      throw new Error(`invalid approved dependency build package name: ${JSON.stringify(value)}`)
    }
    names.add(value)
  }
  return [...names].sort()
}

function pnpmSurfaceBuildApproval(
  approvedPackage: string,
  artifact: PackedArtifact,
  artifactName: string,
  profileDirectory: string,
): string {
  if (approvedPackage !== artifactName) return approvedPackage
  const artifactPath = relative(profileDirectory, artifact.path).split(sep).join('/')
  return `${artifactName}@file:${artifactPath}`
}

function dshArgs(dshVersion: string, args: readonly string[]): string[] {
  return ['dlx', `--package=@deepseek-ai/dsh@${dshVersion}`, 'dsh', ...args]
}

async function readRegularFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${basename(path)} is not a regular file`)
    if (metadata.size > maximum) throw new Error(`${basename(path)} exceeds ${maximum} bytes`)
    const buffer = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < buffer.length) {
      const current = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (current.bytesRead === 0) break
      offset += current.bytesRead
    }
    if (offset !== buffer.length) throw new Error(`${basename(path)} changed while it was read`)
    return buffer
  } finally {
    await handle.close()
  }
}

async function packedArtifact(result: CommandResult, directory: string, expectedName: string, expectedVersion: string): Promise<PackedArtifact> {
  if (commandStage(result).status !== 'passed') throw new Error(commandStage(result).detail ?? 'npm pack failed')
  let output: unknown
  try {
    output = JSON.parse(result.stdout) as unknown
  } catch {
    throw new Error('npm pack did not return valid JSON')
  }
  if (!Array.isArray(output) || output.length !== 1 || typeof output[0] !== 'object' || output[0] === null) {
    throw new Error('npm pack returned an unexpected result')
  }
  const item = output[0] as Record<string, unknown>
  const filename = item.filename
  if (typeof filename !== 'string' || filename !== basename(filename) || !filename.endsWith('.tgz')) {
    throw new Error('npm pack returned an unsafe artifact filename')
  }
  const path = resolve(directory, filename)
  if (!path.startsWith(`${resolve(directory)}${sep}`)) throw new Error('npm pack artifact escaped its directory')
  const bytes = await readRegularFile(path, MAX_ARTIFACT_BYTES)
  const tarball = parseNpmTarball(bytes, { maxFileBytes: MAX_ARTIFACT_BYTES, maxUnpackedBytes: MAX_ARTIFACT_UNPACKED_BYTES })
  const manifestEntry = tarball.entries.find(entry => entry.path === 'package.json' && entry.type === 'file')
  if (manifestEntry?.contents === undefined) throw new Error('packed artifact has no package.json')
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(manifestEntry.contents.toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    manifest = parsed as Record<string, unknown>
  } catch {
    throw new Error('packed artifact package.json is not valid JSON')
  }
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(`packed artifact identity does not match ${expectedName}@${expectedVersion}`)
  }
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null && !Array.isArray(manifest.dsh)
    ? manifest.dsh as Record<string, unknown>
    : undefined
  const bundle = typeof dsh?.bundle === 'object' && dsh.bundle !== null && !Array.isArray(dsh.bundle)
    ? dsh.bundle as Record<string, unknown>
    : undefined
  if (typeof bundle?.patch !== 'string' || bundle.patch.trim() === '') throw new Error('packed artifact does not declare dsh.bundle.patch')
  return {
    path,
    filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    ...(typeof item.integrity === 'string' ? { integrity: bounded(item.integrity, 1_024) } : {}),
  }
}

async function registeredBundle(dshHome: string, profileName: string, packageName: string): Promise<boolean> {
  try {
    const contents = await readRegularFile(join(dshHome, 'profiles', profileName, 'package.json'), 4 * 1024 * 1024)
    const manifest = JSON.parse(contents.toString('utf8')) as Record<string, unknown>
    const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null && !Array.isArray(manifest.dsh)
      ? manifest.dsh as Record<string, unknown>
      : undefined
    const profile = typeof dsh?.profile === 'object' && dsh.profile !== null && !Array.isArray(dsh.profile)
      ? dsh.profile as Record<string, unknown>
      : undefined
    return Array.isArray(profile?.bundles) && profile.bundles.includes(packageName)
  } catch {
    return false
  }
}

function safeArtifactName(caseId: string, suffix: string): string {
  return `${caseId}.${suffix}`
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['data:', 'blob:', 'about:'].includes(url.protocol)
      || ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

interface HostHandle {
  child: ChildProcess
  output(): string
  outputExceeded(): boolean
  exited(): boolean
  code(): number | null
  launchError(): string | undefined
  stop(): Promise<boolean>
}

function startHost(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): HostHandle {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
  const chunks: Buffer[] = []
  let bytes = 0
  let exceeded = false
  let didExit = false
  let exitCode: number | null = null
  let errorMessage: string | undefined
  const collect = (chunk: Buffer): void => {
    if (exceeded) return
    if (bytes + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
      exceeded = true
      return
    }
    bytes += chunk.length
    chunks.push(chunk)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  child.once('error', error => { errorMessage = bounded(error.message) })
  child.once('close', code => {
    didExit = true
    exitCode = code
  })
  return {
    child,
    output: () => Buffer.concat(chunks).toString('utf8'),
    outputExceeded: () => exceeded,
    exited: () => didExit,
    code: () => exitCode,
    launchError: () => errorMessage,
    stop: () => new Promise(resolveStopped => {
      if (didExit) {
        resolveStopped(true)
        return
      }
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        resolveStopped(false)
      }, 5_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolveStopped(true)
      })
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }),
  }
}

async function waitForHttp(url: string, host: HostHandle, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !host.exited() && host.launchError() === undefined && !host.outputExceeded()) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
      return response.status
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
  return undefined
}

function loadDriver<T>(root: string | undefined, packageName: string): T | undefined {
  if (root === undefined) return undefined
  try {
    const require = createRequire(join(resolve(root), 'package.json'))
    return require(packageName) as T
  } catch {
    return undefined
  }
}

async function observeWebSurface(input: {
  report: DshSurfaceObservationReport
  pnpmCommand: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  driverRoot?: string
  chromiumExecutable?: string
  artifactsDirectory: string
}): Promise<DshSurfaceEvaluation> {
  const evidence = input.report.evidence as DshWebSurfaceEvidence
  const playwright = loadDriver<PlaywrightDriver>(input.driverRoot, 'playwright-core')
  if (playwright === undefined) {
    input.report.stages.surface = { status: 'failed', detail: 'playwright-core is unavailable' }
    return evaluateDshWebEvidence({
      driverAvailable: false,
      hostStarted: false,
      rootMounted: false,
      bootManifestPresent: false,
      pluginEntryPresent: false,
      applicationMounted: false,
      pluginMaterialized: false,
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    })
  }

  const host = startHost(input.pnpmCommand, dshArgs(input.report.dshVersion, [
    '--profile', input.report.profile,
    '--host', '127.0.0.1',
    '--port', String(WEB_PORT),
  ]), input.cwd, input.env)
  const hostLogPath = join(input.artifactsDirectory, safeArtifactName(input.report.caseId, 'host.log'))
  evidence.hostLog = basename(hostLogPath)
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let traceStarted = false
  try {
    const httpStatus = await waitForHttp(evidence.url, host, Math.min(input.timeoutMs, 120_000))
    if (httpStatus !== undefined) evidence.httpStatus = httpStatus
    const hostStarted = httpStatus !== undefined
    input.report.stages.host = hostStarted
      ? { status: 'passed' }
      : {
          status: 'failed',
          code: host.code(),
          detail: bounded(host.launchError() ?? (host.output() || 'DSH Web did not expose an HTTP endpoint')),
          ...(host.outputExceeded() ? { outputExceeded: true } : {}),
        }
    if (!hostStarted) {
      return evaluateDshWebEvidence({
        driverAvailable: true,
        hostStarted: false,
        rootMounted: false,
        bootManifestPresent: false,
        pluginEntryPresent: false,
        applicationMounted: false,
        pluginMaterialized: false,
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
      })
    }

    browser = await playwright.chromium.launch({
      headless: true,
      ...(input.chromiumExecutable === undefined ? {} : { executablePath: input.chromiumExecutable }),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-crashpad', '--disable-crash-reporter'],
      env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    })
    context = await browser.newContext({ serviceWorkers: 'block' })
    const tracePath = join(input.artifactsDirectory, safeArtifactName(input.report.caseId, 'trace.zip'))
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    traceStarted = true
    const page = await context.newPage()
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    const failedRequests: string[] = []
    const blockedExternalRequests: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('requestfailed', request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`))
    await page.route('**/*', async route => {
      const url = route.request().url()
      if (isLoopbackUrl(url)) await route.continue()
      else {
        blockedExternalRequests.push(url)
        await route.abort('blockedbyclient')
      }
    })
    const response = await page.goto(evidence.url, { waitUntil: 'domcontentloaded', timeout: Math.min(input.timeoutMs, 90_000) })
    if (response !== null) evidence.httpStatus = response.status()
    evidence.title = bounded(await page.title(), 256)
    const initial = await page.evaluate(runtimeId => {
      const value = globalThis as unknown as {
        document?: { querySelector(selector: string): { childElementCount?: number } | null }
        __DSH_BOOT__?: { entries?: Array<{ id?: string; url?: string }> }
      }
      const entries = Array.isArray(value.__DSH_BOOT__?.entries) ? value.__DSH_BOOT__?.entries ?? [] : []
      const entry = entries.find(item => item.id === runtimeId)
      const ids = entries.map(item => typeof item.id === 'string' ? item.id : '').filter(id => id !== '')
      return {
        rootMounted: (value.document?.querySelector('#root')?.childElementCount ?? 0) > 0,
        bootManifestPresent: entries.length > 0,
        // Put community modules first so the bounded diagnostic list is still
        // useful when DSH contributes dozens of built-in entries.
        bootEntryIds: [...new Set([...ids.filter(id => !id.startsWith('@deepseek-ai/')), ...ids])].slice(0, 32),
        pluginEntryPresent: entry !== undefined,
        pluginBundleUrl: typeof entry?.url === 'string' ? entry.url : undefined,
      }
    }, input.report.runtimeId)
    evidence.rootMounted = initial.rootMounted
    evidence.bootManifestPresent = initial.bootManifestPresent
    evidence.bootEntryIds = boundedList(initial.bootEntryIds)
    evidence.pluginEntryPresent = initial.pluginEntryPresent
    if (initial.pluginBundleUrl !== undefined) {
      evidence.pluginBundleUrl = new URL(initial.pluginBundleUrl, evidence.url).href
      try {
        evidence.pluginBundleStatus = (await fetch(evidence.pluginBundleUrl, { signal: AbortSignal.timeout(10_000) })).status
      } catch {
        evidence.pluginBundleStatus = 0
      }
    }
    if (initial.pluginEntryPresent) {
      try {
        await page.waitForFunction(() => {
          const value = globalThis as unknown as {
            document?: {
              querySelector(selector: string): {
                childElementCount?: number
                querySelector(selector: string): unknown
              } | null
            }
          }
          const root = value.document?.querySelector('#root')
          return (root?.childElementCount ?? 0) > 0
            && root?.querySelector(':scope > [data-dsh-boot]') == null
        }, undefined, { timeout: Math.min(input.timeoutMs, 60_000) })
        evidence.applicationMounted = true
        // DSH's Web boot contract audits every graph entry as ACTIVE before
        // the UI renderer replaces [data-dsh-boot]. This is a public,
        // observable boundary; the old __DSH_MODULES__ page global no longer
        // exists in current DSH releases.
        evidence.pluginMaterialized = true
      } catch {
        evidence.applicationMounted = false
        evidence.pluginMaterialized = false
        evidence.bootFailureText = bounded(await page.evaluate(() => {
          const value = globalThis as unknown as {
            document?: { querySelector(selector: string): { textContent?: string | null } | null }
          }
          return value.document?.querySelector('#root > [data-dsh-boot]')?.textContent ?? ''
        }, undefined), 512)
      }
    }
    evidence.consoleErrors = boundedList(consoleErrors)
    evidence.pageErrors = boundedList(pageErrors)
    evidence.failedRequests = boundedList(failedRequests)
    evidence.blockedExternalRequests = boundedList(blockedExternalRequests)
    const screenshotPath = join(input.artifactsDirectory, safeArtifactName(input.report.caseId, 'png'))
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await chmod(screenshotPath, 0o644)
    evidence.screenshot = basename(screenshotPath)
    await context.tracing.stop({ path: tracePath })
    await chmod(tracePath, 0o644)
    traceStarted = false
    evidence.trace = basename(tracePath)
    const evaluation = evaluateDshWebEvidence({
      driverAvailable: true,
      hostStarted: true,
      ...(evidence.httpStatus === undefined ? {} : { httpStatus: evidence.httpStatus }),
      rootMounted: evidence.rootMounted,
      bootManifestPresent: evidence.bootManifestPresent,
      pluginEntryPresent: evidence.pluginEntryPresent,
      ...(evidence.pluginBundleStatus === undefined ? {} : { pluginBundleStatus: evidence.pluginBundleStatus }),
      applicationMounted: evidence.applicationMounted,
      pluginMaterialized: evidence.pluginMaterialized,
      ...(evidence.bootFailureText === undefined ? {} : { bootFailureText: evidence.bootFailureText }),
      consoleErrors: evidence.consoleErrors,
      pageErrors: evidence.pageErrors,
      failedRequests: evidence.failedRequests,
    })
    input.report.stages.surface = evaluation.failedStage === 'surface'
      ? { status: 'failed', detail: evaluation.reason }
      : { status: 'passed' }
    input.report.stages.interaction = evaluation.failedStage === 'interaction'
      ? { status: 'failed', detail: evaluation.reason }
      : { status: 'passed' }
    return evaluation
  } catch (error: unknown) {
    const reason = `the browser driver failed while observing the Web surface: ${bounded(error instanceof Error ? error.message : String(error))}`
    input.report.stages.surface = { status: 'failed', detail: reason }
    return { result: 'unknown', failedStage: 'surface', reason }
  } finally {
    if (traceStarted && context !== undefined) {
      await context.tracing.stop({ path: join(input.artifactsDirectory, safeArtifactName(input.report.caseId, 'trace.zip')) }).catch(() => undefined)
    }
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    const stopped = await host.stop()
    input.report.stages.shutdown = stopped
      ? { status: 'passed' }
      : { status: 'failed', detail: 'DSH Web required a forced shutdown' }
    await writeFile(hostLogPath, bounded(host.output(), MAX_COMMAND_OUTPUT_BYTES), { mode: 0o644 }).catch(() => undefined)
  }
}

function normalizeTerminalFrame(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-32)
    .join('\n')
    .slice(0, 8_192)
}

async function observeTuiSurface(input: {
  report: DshSurfaceObservationReport
  pnpmCommand: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  driverRoot?: string
  artifactsDirectory: string
}): Promise<DshSurfaceEvaluation> {
  const evidence = input.report.evidence as DshTuiSurfaceEvidence
  const driver = loadDriver<PtyDriver>(input.driverRoot, 'node-pty')
  if (driver === undefined) {
    input.report.stages.surface = { status: 'failed', detail: 'node-pty is unavailable' }
    return evaluateDshTuiEvidence({ driverAvailable: false, frameObserved: false, inputSent: false, exitedAfterShutdown: false })
  }
  input.report.stages.host = { status: 'passed' }
  const terminalEnvironment = Object.fromEntries(Object.entries({
    ...input.env,
    TERM: evidence.terminal,
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CI: 'false',
    NO_COLOR: undefined,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  let terminal: PtyProcess
  try {
    terminal = driver.spawn(input.pnpmCommand, dshArgs(input.report.dshVersion, ['--profile', input.report.profile]), {
      name: evidence.terminal,
      cols: evidence.columns,
      rows: evidence.rows,
      cwd: input.cwd,
      env: terminalEnvironment,
    })
  } catch (error: unknown) {
    input.report.stages.host = { status: 'failed', detail: bounded(error instanceof Error ? error.message : String(error)) }
    return { result: 'unknown', failedStage: 'host', reason: 'the PTY driver could not start the exact DSH profile' }
  }

  let raw = ''
  let capturedBytes = 0
  let truncated = false
  let inputSent = false
  let shutdownRequested = false
  let exitCode: number | undefined
  let signal: number | undefined
  let exited = false
  let forced = false
  const transcriptPath = join(input.artifactsDirectory, safeArtifactName(input.report.caseId, 'ansi'))
  evidence.transcript = basename(transcriptPath)

  await new Promise<void>(resolveObservation => {
    let settled = false
    let shutdownTimer: NodeJS.Timeout | undefined
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
      resolveObservation()
    }
    const requestShutdown = (): void => {
      if (shutdownRequested) return
      shutdownRequested = true
      terminal.write('\u0003')
      // dsh-TUI intentionally requires a double Ctrl-C: the first press clears
      // input/arms exit and the second performs the graceful shutdown. Keep the
      // pair close enough to exercise that public interaction contract.
      setTimeout(() => {
        if (exited) return
        try { terminal.write('\u0003') } catch { /* the PTY exited between taps */ }
      }, 150)
      shutdownTimer = setTimeout(() => {
        forced = true
        try { terminal.kill('SIGKILL') } catch { settle() }
      }, 5_000)
    }
    terminal.onData(data => {
      const dataBytes = Buffer.byteLength(data)
      if (capturedBytes + dataBytes <= MAX_TUI_BYTES) {
        raw += data
        capturedBytes += dataBytes
      } else {
        truncated = true
      }
      const normalized = normalizeTerminalFrame(raw)
      const hasTerminalControl = /\u001b\[[0-?]*[ -/]*[@-~]/.test(raw)
      if (!evidence.frameObserved && hasTerminalControl && normalized.replace(/\s/g, '').length >= 40) {
        evidence.frameObserved = true
        terminal.write('\u000c')
        inputSent = true
        setTimeout(requestShutdown, 750)
      }
    })
    terminal.onExit(event => {
      exited = true
      exitCode = event.exitCode
      signal = event.signal
      settle()
    })
    const deadline = setTimeout(() => {
      requestShutdown()
      setTimeout(settle, 5_250)
    }, Math.min(input.timeoutMs, 120_000))
  })

  evidence.inputSent = inputSent
  evidence.exitedAfterShutdown = exited && shutdownRequested && !forced
  if (exitCode !== undefined) evidence.exitCode = exitCode
  if (signal !== undefined) evidence.signal = signal
  evidence.normalizedFrame = normalizeTerminalFrame(raw)
  evidence.capturedBytes = capturedBytes
  evidence.truncated = truncated
  await writeFile(transcriptPath, raw, { mode: 0o644 })
  const evaluation = evaluateDshTuiEvidence({
    driverAvailable: true,
    frameObserved: evidence.frameObserved,
    inputSent: evidence.inputSent,
    exitedAfterShutdown: evidence.exitedAfterShutdown,
    ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
  })
  input.report.stages.surface = evaluation.failedStage === 'surface'
    ? { status: 'failed', detail: evaluation.reason }
    : { status: 'passed' }
  input.report.stages.interaction = evaluation.failedStage === 'interaction'
    ? { status: 'failed', detail: evaluation.reason }
    : evidence.inputSent ? { status: 'passed' } : { status: 'skipped' }
  input.report.stages.shutdown = evaluation.failedStage === 'shutdown'
    ? { status: 'failed', detail: evaluation.reason }
    : evidence.exitedAfterShutdown ? { status: 'passed' } : { status: 'skipped' }
  return evaluation
}

function validateObservationOptions(options: DshSurfaceObservationOptions): void {
  const plugin = parseNpmSpec(options.packageSpec)
  if (!EXACT_VERSION.test(options.dshVersion)) throw new Error('DSH surface observation requires an exact DSH version')
  if (!CASE_ID.test(options.caseId) || !CASE_ID.test(options.sourceCaseId)) throw new Error('DSH surface observation case ids must be short lowercase labels')
  if (!FINGERPRINT.test(options.sourceFingerprint) || !FINGERPRINT.test(options.contractFingerprint)) throw new Error('DSH surface observation fingerprints must be sha256 digests')
  if (!BARE_SHA256.test(options.expectedArtifactSha256)) throw new Error('DSH surface observation requires the expected artifact SHA-256')
  if (!PROFILE_NAME.test(options.profile)) throw new Error('DSH surface observation profile must be a short safe profile name')
  if (options.runtimeId.trim() === '' || options.runtimeId.length > 214) throw new Error('DSH surface observation runtimeId must be a bounded package id')
  if (options.plane === 'web' && options.profile !== 'web') throw new Error('Web surface observations must use the official web profile')
  if (options.plane === 'web' && options.runtimeId !== plugin.name) {
    throw new Error('Web runtimeId must equal the exact npm package name; Cordis loader row ids are not browser module ids')
  }
  if (options.plane === 'tui' && options.profile === 'web') throw new Error('TUI surface observations cannot use the reserved web profile')
  if (!options.allowExecution) throw new Error('DSH surface observation requires explicit execution consent')
  if (!['github-actions-hosted-runner', 'firecracker', 'other'].includes(options.isolationProvider)) throw new Error('unsupported isolation provider')
}

export async function observeDshPluginSurface(options: DshSurfaceObservationOptions): Promise<DshSurfaceObservationReport> {
  validateObservationOptions(options)
  const allowedBuilds = normalizeAllowedBuilds(options.allowedBuilds)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error('DSH surface observation timeout must be between 30000 and 600000 milliseconds')
  }
  const hostEnvironment = options.hostEnvironment ?? process.env
  if (hostEnvironment.UPSTREAM_RADAR_ISOLATED_RUNNER !== '1') {
    throw new Error('DSH surface observation requires UPSTREAM_RADAR_ISOLATED_RUNNER=1')
  }
  const parsedSpec = parseNpmSpec(options.packageSpec)
  const startedAt = new Date().toISOString()
  const nodeVersion = process.version.replace(/^v/, '')
  const nodeMajor = Number(nodeVersion.split('.')[0])
  const report: DshSurfaceObservationReport = {
    schema: DSH_SURFACE_OBSERVATION_SCHEMA,
    tool: { name: 'upstream-radar', version: TOOL_VERSION },
    probe: 'dsh-surface',
    scope: 'surface-runtime-behavior',
    startedAt,
    completedAt: startedAt,
    caseId: options.caseId,
    sourceCaseId: options.sourceCaseId,
    sourceFingerprint: options.sourceFingerprint,
    contractFingerprint: options.contractFingerprint,
    plugin: `${parsedSpec.name}@${parsedSpec.version}`,
    dshVersion: options.dshVersion,
    plane: options.plane,
    profile: options.profile,
    runtimeId: options.runtimeId,
    runtime: { nodeMajor, nodeVersion, platform: process.platform, architecture: process.arch },
    artifact: {},
    stages: skippedStages(),
    evidence: emptyEvidence(options.plane),
    result: 'unknown',
    reason: 'surface observation did not complete',
    boundary: {
      isolationProviderClaim: options.isolationProvider,
      isolationVerifiedByRadar: false,
      disposableEnvironmentRequired: true,
      inheritedHostSecrets: false,
      externalBrowserRequestsBlocked: options.plane === 'web',
      approvedDependencyBuilds: allowedBuilds,
      note: 'The caller supplies a disposable VM and restricted container. Radar passes no repository or model secrets, binds the run to exact artifact bytes, blocks non-loopback browser requests, and collects bounded smoke evidence. This is compatibility evidence, not a malicious-code safety certificate.',
    },
  }

  const sandboxRoot = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-surface-'))
  const artifactDirectory = join(sandboxRoot, 'artifact')
  const artifactsDirectory = resolve(options.artifactsDirectory ?? join(sandboxRoot, 'evidence'))
  const environment = controlledEnvironment(sandboxRoot, hostEnvironment)
  const noScriptsEnvironment = scriptPolicy(environment, false)
  const scriptsEnvironment = scriptPolicy(environment, true)
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  try {
    await Promise.all([
      mkdir(artifactDirectory, { recursive: true, mode: 0o700 }),
      mkdir(artifactsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(environment.HOME as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.DSH_HOME as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.TMPDIR as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.XDG_CACHE_HOME as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.XDG_CONFIG_HOME as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.XDG_DATA_HOME as string, { recursive: true, mode: 0o700 }),
    ])
    await Promise.all([
      writeFile(join(sandboxRoot, 'controlled.npmrc'), 'registry=https://registry.npmjs.org/\naudit=false\nfund=false\nupdate-notifier=false\n', { mode: 0o600 }),
      writeFile(join(sandboxRoot, 'controlled-global.npmrc'), '', { mode: 0o600 }),
      writeFile(join(sandboxRoot, 'controlled.gitconfig'), '', { mode: 0o600 }),
    ])

    const runtime = await runCommand(pnpmCommand, ['--version'], sandboxRoot, noScriptsEnvironment, timeoutMs)
    report.stages.runtime = commandStage(runtime)
    const pnpmVersion = runtime.stdout.trim()
    if (report.stages.runtime.status !== 'passed' || !EXACT_VERSION.test(pnpmVersion)) {
      report.stages.runtime = { ...report.stages.runtime, status: 'failed', detail: report.stages.runtime.detail ?? 'pnpm did not return an exact version' }
      return finish(report, 'unknown', 'the package-manager runtime could not be established')
    }
    report.runtime.pnpmVersion = pnpmVersion

    const packed = await runCommand(npmCommand, [
      'pack', report.plugin, '--ignore-scripts', '--pack-destination', '.', '--json', '--silent',
    ], artifactDirectory, noScriptsEnvironment, timeoutMs)
    let artifact: PackedArtifact
    try {
      artifact = await packedArtifact(packed, artifactDirectory, parsedSpec.name, parsedSpec.version)
    } catch (error: unknown) {
      report.stages.artifact = { ...commandStage(packed), status: 'failed', detail: bounded(error instanceof Error ? error.message : String(error)) }
      return finish(report, 'unknown', 'the exact npm artifact could not be established')
    }
    report.artifact = {
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      ...(artifact.integrity === undefined ? {} : { integrity: artifact.integrity }),
    }
    report.stages.artifact = { status: 'passed', code: packed.code }
    if (artifact.sha256 !== options.expectedArtifactSha256) {
      report.stages.artifact = { status: 'failed', detail: `artifact sha256:${artifact.sha256} does not match scheduled sha256:${options.expectedArtifactSha256}` }
      return finish(report, 'unknown', 'the downloaded artifact bytes do not match the source observation')
    }

    const profileStrategy = dshSurfaceProfileStrategy(report.plane)
    if (profileStrategy === 'initialize-stock-profile') {
      const profile = await runCommand(pnpmCommand, dshArgs(report.dshVersion, ['--profile', report.profile, '--help']), artifactDirectory, noScriptsEnvironment, timeoutMs)
      report.stages.profile = commandStage(profile)
      if (report.stages.profile.status !== 'passed') return finish(report, 'unknown', 'the exact DSH runtime could not initialize the declared profile')
    } else {
      report.stages.profile = { status: 'skipped', detail: 'the custom TUI profile must be created by dsh plugin add' }
    }

    const install = await runCommand(pnpmCommand, dshArgs(report.dshVersion, [
      'plugin', '--profile', report.profile, 'add', artifact.path,
      ...allowedBuilds.map(name => `--allow-build=${pnpmSurfaceBuildApproval(
        name,
        artifact,
        parsedSpec.name,
        join(environment.DSH_HOME as string, 'profiles', report.profile),
      )}`),
    ]), artifactDirectory, scriptsEnvironment, timeoutMs)
    report.stages.install = commandStage(install)
    if (install.timedOut || install.outputExceeded || install.launchError !== undefined) {
      return finish(report, 'unknown', 'the profile install did not produce a bounded result')
    }
    if (install.code !== 0) {
      const requiredBuilds = extractPnpmRequiredDependencyBuilds(`${install.stderr}\n${install.stdout}`, parsedSpec.name)
      if (requiredBuilds.length > 0) {
        return finish(
          report,
          'environment-unsupported',
          `the declared ${report.plane} environment still requires explicit dependency-build approval: ${requiredBuilds.join(', ')}`,
        )
      }
      return finish(report, 'surface-incompatible', `the exact plugin could not be installed into the declared ${report.plane} profile`)
    }
    if (profileStrategy === 'create-with-plugin-add') {
      report.stages.profile = { status: 'passed', detail: 'dsh plugin add created the custom TUI profile' }
    }

    const registered = await registeredBundle(environment.DSH_HOME as string, report.profile, parsedSpec.name)
    report.stages.registration = registered
      ? { status: 'passed' }
      : { status: 'failed', detail: `the profile did not register ${parsedSpec.name}` }
    if (!registered) return finish(report, 'surface-incompatible', 'DSH accepted the install command but did not register the plugin in the declared profile')

    const evaluation = report.plane === 'web'
      ? await observeWebSurface({
          report,
          pnpmCommand,
          cwd: artifactDirectory,
          env: scriptsEnvironment,
          timeoutMs,
          artifactsDirectory,
          ...(options.driverRoot === undefined ? {} : { driverRoot: options.driverRoot }),
          ...(options.chromiumExecutable === undefined ? {} : { chromiumExecutable: options.chromiumExecutable }),
        })
      : await observeTuiSurface({
          report,
          pnpmCommand,
          cwd: artifactDirectory,
          env: scriptsEnvironment,
          timeoutMs,
          artifactsDirectory,
          ...(options.driverRoot === undefined ? {} : { driverRoot: options.driverRoot }),
        })
    return finish(report, evaluation.result, evaluation.reason)
  } catch (error: unknown) {
    return finish(report, 'unknown', `the bounded surface observer failed: ${bounded(error instanceof Error ? error.message : String(error))}`)
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
}

export function renderDshSurfaceObservation(report: DshSurfaceObservationReport): string {
  const lines = [
    'DSH execution-plane observation',
    `Case: ${report.caseId}`,
    `Plugin: ${report.plugin}`,
    `DSH: ${report.dshVersion}`,
    `Plane: ${report.plane} (profile ${report.profile}, runtime id ${report.runtimeId})`,
    `Artifact: ${report.artifact.sha256 === undefined ? 'not established' : `sha256:${report.artifact.sha256}`}`,
    `Result: ${report.result.toUpperCase()} — ${report.reason}`,
    '',
  ]
  for (const [name, stage] of Object.entries(report.stages)) {
    lines.push(`  ${name}: ${stage.status}${stage.detail === undefined ? '' : ` (${stage.detail})`}`)
  }
  if (report.evidence.plane === 'web') {
    lines.push(
      '',
      `Web: HTTP ${report.evidence.httpStatus ?? 'unknown'}, root ${report.evidence.rootMounted ? 'mounted' : 'missing'}, entry ${report.evidence.pluginEntryPresent ? 'present' : 'missing'}, app ${report.evidence.applicationMounted ? 'mounted' : 'still booting'}, module ${report.evidence.pluginMaterialized ? 'activated' : 'not activated'}`,
      `Browser errors: ${report.evidence.pageErrors.length} page, ${report.evidence.consoleErrors.length} console, ${report.evidence.failedRequests.length} failed request(s)`,
    )
  } else {
    lines.push(
      '',
      `TUI: frame ${report.evidence.frameObserved ? 'observed' : 'missing'}, input ${report.evidence.inputSent ? 'sent' : 'not sent'}, shutdown ${report.evidence.exitedAfterShutdown ? 'controlled' : 'not controlled'}`,
      `Captured: ${report.evidence.capturedBytes} byte(s)${report.evidence.truncated ? ' (truncated)' : ''}`,
    )
  }
  lines.push('', report.boundary.note)
  return `${lines.join('\n')}\n`
}
