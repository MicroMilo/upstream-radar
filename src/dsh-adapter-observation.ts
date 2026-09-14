import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNpmSpec } from './npm.js'
import { parseInstalledProfileGraph, type InstalledProfileGraph } from './installed-graph.js'
import { observationNetworkEnvironment } from './dsh-observation-network.js'
import { parseDshProfileEnvironment, type DshProfileEnvironment } from './dsh-profile-environment.js'
import {
  createDshIsolatedEnvironment, readDshPackedArtifact, runDshIsolatedCommand,
  type InstallObservationCommandResult, type InstallObservationPhase, type InstallObservationRunner,
} from './dsh-install-observation.js'

export const DSH_ADAPTER_EXECUTION_CONTRACT = 'dsh-author-adapter/v1alpha2' as const
export interface DshAdapterObservationReport {
  schema: 'upstream-radar.dsh-adapter-observation/v1alpha1'
  executionContract: typeof DSH_ADAPTER_EXECUTION_CONTRACT
  recipe: 'feishu-0.19.16-doctor-initialize'
  plugin: string; dshVersion: string; adapter: 'sdk' | 'acp'; profile: string
  startedAt: string; completedAt: string
  runtime: { nodeVersion: string; platform: string; architecture: string; pnpmVersion?: string }
  profileEnvironment: DshProfileEnvironment
  artifact?: { sha256: string; bytes: number }
  stages: Record<'runtime' | 'artifact' | 'install' | 'initialize' | 'profileGraph', 'passed' | 'failed' | 'skipped'>
  applicationGraph?: InstalledProfileGraph
  profileGraph?: InstalledProfileGraph
  commands: Array<InstallObservationCommandResult & { phase: InstallObservationPhase; command: string; args: string[] }>
  fixtureRequests: number
  result: 'initialize-compatible' | 'initialize-failed' | 'unknown'
  reason: string
  coverageGaps: string[]
  boundary: { lifecycleScripts: 'disabled'; inheritedHostSecrets: false; note: string }
}

function graphComplete(graph: InstalledProfileGraph): boolean {
  return graph.gaps.length === 0 && graph.roots.length > 0 && graph.roots.every(root => (
    (root.versionStatus === 'satisfied' || root.versionStatus === 'linked') && (root.graph.unresolved ?? []).every(gap => gap.kind === 'optional')
    && (root.graph.rootPeerContracts ?? []).every(peer => peer.status === 'satisfied')
  ))
}

export function dshAdapterHasIndependentRuntimeEvidence(report: DshAdapterObservationReport): boolean {
  const service = report.adapter === 'sdk' ? '@deepseek-ai/dsh-sdk-jsonrpc-server' : '@deepseek-ai/dsh-acp'
  const { name, version } = parseNpmSpec(report.plugin)
  const roots = report.profileGraph?.roots ?? [], application = report.applicationGraph
  return report.profileGraph !== undefined && graphComplete(report.profileGraph)
    && roots.some(item => item.name === service && item.requested === '0.1.0-rc.8' && item.version === '0.1.0-rc.8' && item.versionStatus === 'satisfied')
    && roots.some(item => item.name === name && item.version === version && item.versionStatus === 'linked')
    && roots.some(item => item.name === '@deepseek-ai/dsh-base' && item.version === report.dshVersion && item.versionStatus === 'satisfied')
    && application !== undefined && application.gaps.length === 0
    && application.roots.some(item => item.name === name && item.version === version && item.requested.startsWith('file:'))
    && ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base'].every(packageName => application.roots.some(item => (
      item.name === packageName && item.version === report.dshVersion && item.versionStatus === 'satisfied'
    )))
    && application.roots.every(item => (item.graph.unresolved ?? []).every(gap => gap.kind === 'optional')
      && (item.graph.rootPeerContracts ?? []).every(peer => peer.status === 'satisfied'))
}

/** Reviewed recipe for the published CLI's real initialize handshake, not an authenticated integration test. */
export async function observeDshAuthorAdapter(options: {
  packageSpec: string; dshVersion: string; adapter: 'sdk' | 'acp'; expectedArtifactSha256: string
  profileEnvironment?: DshProfileEnvironment; allowExecution: boolean; timeoutMs?: number; networkProxy?: string
  hostEnvironment?: NodeJS.ProcessEnv; runner?: InstallObservationRunner
}): Promise<DshAdapterObservationReport> {
  const spec = parseNpmSpec(options.packageSpec)
  // Doctor semantics were reviewed at source commit 6e722e0272f370fa0071715703294490e2f89bf8.
  // New package versions need recipe review; a matching name alone never grants coverage.
  if (spec.name !== 'dsh-feishu-bot' || spec.version !== '0.19.16') throw new Error('no reviewed author adapter recipe for this exact plugin version')
  if (!['sdk', 'acp'].includes(options.adapter) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.dshVersion)
    || !/^[a-f0-9]{64}$/.test(options.expectedArtifactSha256)) throw new Error('adapter requires exact bounded coordinates and artifact bytes')
  const profileEnvironment = parseDshProfileEnvironment(options.profileEnvironment)
  const timeoutMs = options.timeoutMs ?? 180_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) throw new Error('adapter timeout exceeds bounds')
  if (!options.allowExecution) throw new Error('author adapter observation requires explicit execution consent')
  if (!options.runner && (process.platform !== 'linux' || process.env.UPSTREAM_RADAR_ISOLATED_RUNNER !== '1')) {
    throw new Error('author adapter code must run in a declared disposable Linux executor')
  }
  const transport = observationNetworkEnvironment(options.networkProxy)
  const root = await mkdtemp(join(tmpdir(), 'upstream-radar-author-adapter-'))
  const env: NodeJS.ProcessEnv & { DSH_LARK_HOME: string; DSH_LARK_WORKSPACE: string } = {
    ...createDshIsolatedEnvironment(root, options.hostEnvironment ?? process.env), ...transport,
    DSH_LARK_ADAPTER: options.adapter, DSH_LARK_UPGRADE_CHECK: '0', DSH_LARK_GROUP_NO_AT: '0',
    DSH_LARK_HOME: join(root, 'lark'), DSH_LARK_PROVIDER: 'radar-local-fixture', DSH_LARK_MODEL: 'radar-fixture-model',
    DSH_LARK_WORKSPACE: join(root, 'workspace'), RADAR_FIXTURE_API_KEY: 'local-fixture-not-a-real-key',
    npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
    // pnpm 11 does not use the legacy npm_config spelling for this setting.
    PNPM_CONFIG_FROZEN_LOCKFILE: 'false', npm_config_frozen_lockfile: 'false' }
  const home = env.DSH_HOME!
  const application = join(home, 'profiles')
  const profile = `dsh-lark-${options.adapter}`
  const managed = join(application, profile)
  const report: DshAdapterObservationReport = {
    schema: 'upstream-radar.dsh-adapter-observation/v1alpha1', executionContract: DSH_ADAPTER_EXECUTION_CONTRACT,
    recipe: 'feishu-0.19.16-doctor-initialize', plugin: options.packageSpec, dshVersion: options.dshVersion,
    adapter: options.adapter, profile, startedAt: new Date().toISOString(), completedAt: '', profileEnvironment,
    runtime: { nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch },
    stages: { runtime: 'skipped', artifact: 'skipped', install: 'skipped', initialize: 'skipped', profileGraph: 'skipped' },
    commands: [], fixtureRequests: 0, result: 'unknown', reason: 'adapter initialization has not completed',
    coverageGaps: ['No real Feishu authentication, model generation, user task, resume, guardian service, or outbound message was exercised.'],
    boundary: { lifecycleScripts: 'disabled', inheritedHostSecrets: false,
      note: 'Target CLI and its child processes run only inside the caller-verified disposable executor. Doctor output and same-container graphs are bounded observations, not a malicious-code safety certificate.' },
  }
  const runner = options.runner ?? runDshIsolatedCommand
  const server = createServer((_request, response) => {
    report.fixtureRequests += 1
    response.writeHead(503).end('Only initialization is in scope; no model task is authorized.')
  })
  const successful = (result: InstallObservationCommandResult) => result.code === 0 && !result.timedOut && !result.outputExceeded && !result.launchError
  async function run(phase: InstallObservationPhase, command: string, args: string[], cwd: string) {
    const result = await runner({ phase, command, args, cwd, env, timeoutMs, sandboxRoot: root })
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 64 * 1024 || report.commands.length >= 8) throw new Error('adapter command evidence exceeds its bound')
    report.commands.push({ ...result, phase, command, args })
    return result
  }
  try {
    for (const path of [application, env.HOME!, env.DSH_LARK_HOME, env.DSH_LARK_WORKSPACE, env.TMPDIR!]) await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'controlled.npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n', { flag: 'wx', mode: 0o600 })
    for (const file of ['controlled-global.npmrc', 'controlled.gitconfig']) await writeFile(join(root, file), '', { flag: 'wx', mode: 0o600 })
    const runtime = await run('runtime', 'pnpm', ['--version'], root)
    report.stages.runtime = 'failed'
    if (!successful(runtime) || runtime.stdout.trim() !== profileEnvironment.pnpmVersion) throw new Error('the isolated package manager does not match the planned adapter environment')
    report.runtime.pnpmVersion = runtime.stdout.trim()
    report.stages.runtime = 'passed'
    const packed = await run('artifact', 'npm', ['pack', options.packageSpec, '--ignore-scripts', '--pack-destination', '.', '--silent'], root)
    report.stages.artifact = 'failed'
    const artifact = await readDshPackedArtifact(packed, root, spec.name, spec.version)
    report.artifact = { sha256: artifact.sha256, bytes: artifact.bytes }
    if (artifact.sha256 !== options.expectedArtifactSha256) throw new Error('adapter artifact differs from the exact reviewed bytes')
    report.stages.artifact = 'passed'
    await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'radar-isolated-adapter-application', version: '0.0.0', private: true,
      dependencies: { '@deepseek-ai/dsh': options.dshVersion, '@deepseek-ai/dsh-base': options.dshVersion, [spec.name]: `file:${artifact.path}` } }), { flag: 'wx', mode: 0o600 })
    await writeFile(join(application, 'pnpm-workspace.yaml'), JSON.stringify({ packages: ['*'], overrides: profileEnvironment.overrides }), { flag: 'wx', mode: 0o600 })
    const installed = await run('install', 'pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile', '--reporter=append-only'], application)
    report.stages.install = successful(installed) ? 'passed' : 'failed'
    if (!successful(installed)) throw new Error('isolated author application dependencies could not be established')
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('local model fixture did not start')
    await writeFile(join(home, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: { 'radar-local-fixture': {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'RADAR_FIXTURE_API_KEY', models: [{ id: 'radar-fixture-model' }],
    } } } }), { flag: 'wx', mode: 0o600 })
    await writeFile(join(env.DSH_LARK_HOME, 'config.json'), JSON.stringify({ schemaVersion: 1, activeProfile: 'default', profiles: { default: {
      schemaVersion: 1, agentKind: 'dsh', tenant: 'feishu', accounts: { appId: 'cli_radar_local_fixture', appSecret: 'local-fixture-not-a-real-secret' },
      workspaces: { default: env.DSH_LARK_WORKSPACE }, preferences: { model: 'radar-fixture-model', stopGraceMs: 5000, runTimeoutMs: timeoutMs },
      access: { allowedUsers: [], allowedChats: [], admins: [] },
    } } }), { flag: 'wx', mode: 0o600 })
    const doctor = await run('load', 'node', [join(application, 'node_modules', spec.name, 'dist', 'cli.js'), 'doctor'], env.DSH_LARK_WORKSPACE)
    const initialized = successful(doctor) && new RegExp(`^adapter: ${options.adapter}$`, 'm').test(doctor.stdout) && /^dsh: ok(?: |$)/m.test(doctor.stdout)
    report.stages.initialize = initialized ? 'passed' : 'failed'
    if (!initialized) report.reason = 'the published author CLI did not establish its adapter initialize handshake'
    if (report.fixtureRequests !== 0) report.coverageGaps.push('The CLI attempted a model request; the initialize-only boundary was not established.')
    try {
      report.profileGraph = await parseInstalledProfileGraph(managed, { workspaceDirectory: root })
      const service = options.adapter === 'sdk' ? '@deepseek-ai/dsh-sdk-jsonrpc-server' : '@deepseek-ai/dsh-acp'
      const roots = report.profileGraph.roots
      const recipeRoots = roots.some(item => item.name === service && item.requested === '0.1.0-rc.8'
        && item.version === '0.1.0-rc.8' && item.versionStatus === 'satisfied')
        && roots.some(item => item.name === spec.name && item.version === spec.version && item.versionStatus === 'linked')
        && roots.some(item => item.name === '@deepseek-ai/dsh-base' && item.version === options.dshVersion && item.versionStatus === 'satisfied')
      report.stages.profileGraph = graphComplete(report.profileGraph) && recipeRoots ? 'passed' : 'failed'
      if (report.stages.profileGraph !== 'passed') report.coverageGaps.push('The independent managed-profile graph is incomplete or does not establish the reviewed adapter service, exact linked plugin, and selected base bundle.')
    } catch (error) {
      report.stages.profileGraph = 'failed'
      report.coverageGaps.push(`The independent managed-profile graph could not be established: ${String(error).slice(0, 512)}`)
    }
    try { report.applicationGraph = await parseInstalledProfileGraph(application, { workspaceDirectory: root }) }
    catch (error) { report.coverageGaps.push(`Application graph is unavailable: ${String(error).slice(0, 512)}`) }
    // A file: root is byte-verified above; other direct roots must resolve exactly as requested.
    const hostRoots = report.applicationGraph?.roots.filter(item => item.name === '@deepseek-ai/dsh' || item.name === '@deepseek-ai/dsh-base') ?? []
    const hostVerified = hostRoots.length === 2 && hostRoots.every(item => item.version === options.dshVersion && item.versionStatus === 'satisfied')
    if (!hostVerified) report.coverageGaps.push('The exact installed DSH host and base bundle could not both be established.')
    if (initialized) report.reason = 'The author CLI reported initialization, but its complete independent runtime evidence has not been established.'
    const independent = dshAdapterHasIndependentRuntimeEvidence(report)
    if (!independent) report.coverageGaps.push('The complete application and adapter root sets, including their peer requirements, could not be verified independently.')
    if (initialized && report.stages.profileGraph === 'passed' && independent && report.fixtureRequests === 0) {
      report.result = 'initialize-compatible'
      report.reason = 'The published author CLI completed a real adapter initialize handshake with an independently collected managed-profile graph.'
    } else if (!initialized && successful({ ...doctor, code: 0 }) && doctor.code === 1 && /^dsh: unavailable/m.test(doctor.stdout)
      && report.stages.profileGraph === 'passed' && independent && report.fixtureRequests === 0) {
      report.result = 'initialize-failed'
    }
  } catch (error) { report.reason = String(error instanceof Error ? error.message : error).slice(0, 1024) }
  finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    report.completedAt = new Date().toISOString()
    await rm(root, { recursive: true, force: true })
  }
  return report
}
