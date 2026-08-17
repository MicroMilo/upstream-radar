import { access, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseNpmLockGraph, parsePnpmLockGraph } from './graph.js'
import { inspectNpmPackage, type InspectNpmOptions } from './npm.js'
import { parseInstalledNodeModulesGraph } from './installed-graph.js'
import { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
import { discoverDshRuntimePackageFromNodeModulesDirectory } from './dsh-runtime.js'
import {
  INVENTORY_SCHEMA,
  RADAR_CONFIG_SCHEMA,
  type DependencyGraph,
  type DependencyHostRuntimeSource,
  type PackageCoordinate,
  type PackageManifestSnapshot,
  type PluginInstallation,
  type RadarConfig,
  type RadarNotificationPolicy,
} from './radar-types.js'

const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_LOCKFILE_JSON_BYTES = 256 * 1024 * 1024

type InitInspection = {
  evidence: {
    npm?: {
      dependencyAudit: {
        graph?: DependencyGraph
      }
    }
  }
}

export type InitInspector = (spec: string, options: InspectNpmOptions) => Promise<InitInspection>

export interface DshInitOptions {
  profileDirectory: string
  projectId?: string
  projectName?: string
  repository?: string
  workspace?: string
  channels?: string[]
  webhookUrlEnv?: string
  webhookSecretEnv?: string
  notificationPolicy?: RadarNotificationPolicy
  registry?: string
  inspect?: InitInspector
  /** Optional DSH process dependency plane discovered without importing DSH code. */
  hostNodeModulesDirectory?: string
  hostRuntimeSource?: DependencyHostRuntimeSource
  /** Exact DSH executable package owning the shared host plane. */
  hostRuntimePackage?: PackageCoordinate
  /** Directory containing the exact DSH executable package when its dependency plane is nested. */
  hostRuntimePackageDirectory?: string
}

export interface PnpmLockInitOptions {
  lockfile: string
  root: {
    name: string
    version: string
  }
  projectId?: string
  projectName?: string
  repository?: string
  workspace?: string
  channels?: string[]
  webhookUrlEnv?: string
  webhookSecretEnv?: string
  notificationPolicy?: RadarNotificationPolicy
}

export interface NpmLockInitOptions {
  lockfile: string
  root: {
    name: string
    version: string
  }
  projectId?: string
  projectName?: string
  repository?: string
  workspace?: string
  channels?: string[]
  webhookUrlEnv?: string
  webhookSecretEnv?: string
  notificationPolicy?: RadarNotificationPolicy
}

export interface WriteRadarConfigOptions {
  output: string
  force?: boolean
}

export interface WriteDshPatchOptions {
  output: string
  configFile: string
  stateFile: string
  profile: string
  intervalSeconds?: number
  runOnStart?: boolean
  registry?: string
  deepCandidates?: boolean
  threatIntel?: boolean
  force?: boolean
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) throw new Error(`${label} must be a non-empty string`)
  return value
}

async function readJson(path: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const contents = await readFile(path, 'utf8')
  if (Buffer.byteLength(contents) > maxBytes) throw new Error(`${path} exceeds the ${maxBytes} byte limit`)
  try {
    return JSON.parse(contents) as unknown
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
}

async function readPackageManifest(profileDirectory: string, packageName: string): Promise<PackageManifestSnapshot> {
  const nodeModulesDirectory = resolve(profileDirectory, 'node_modules')
  const path = resolve(nodeModulesDirectory, packageName, 'package.json')
  const relativePath = relative(nodeModulesDirectory, path)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`DSH bundle name escapes the profile node_modules directory: ${packageName}`)
  }
  const realProfileDirectory = await realpath(profileDirectory)
  const realNodeModulesDirectory = await realpath(nodeModulesDirectory)
  const realManifest = await realpath(path)
  const profileRelativePath = relative(realProfileDirectory, realManifest)
  if (profileRelativePath.startsWith('..') || isAbsolute(profileRelativePath)) {
    throw new Error(`DSH bundle manifest escapes the DSH profile: ${packageName}`)
  }
  const realRelativePath = relative(realNodeModulesDirectory, realManifest)
  if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
    throw new Error(`DSH bundle manifest escapes the profile node_modules directory: ${packageName}`)
  }
  return parsePackageManifestSnapshot(await readJson(realManifest))
}

function isDshInfrastructure(packageName: string): boolean {
  return packageName === 'upstream-radar'
    || packageName === 'cordis'
    || packageName.startsWith('@deepseek-ai/')
    || packageName.startsWith('@cordis/')
}

function resolveDshHome(dshHome = process.env.DSH_HOME): string {
  return dshHome?.trim() === '' || dshHome === undefined ? join(homedir(), '.dsh') : dshHome
}

async function readDshProfileBundles(profileDirectory: string): Promise<string[]> {
  const profileManifest = asRecord(await readJson(join(profileDirectory, 'package.json')), 'DSH profile package.json')
  const dsh = asRecord(profileManifest.dsh, 'DSH profile dsh')
  const profile = asRecord(dsh.profile, 'DSH profile dsh.profile')
  const bundles = profile.bundles
  if (!Array.isArray(bundles) || bundles.length === 0 || !bundles.every(item => typeof item === 'string')) {
    throw new Error('DSH profile package.json does not contain dsh.profile.bundles')
  }
  return bundles
}

function defaultProjectId(workspace: string): string {
  const name = basename(resolve(workspace)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return name.replace(/^-+|-+$/g, '').slice(0, 512) || 'dsh-project'
}

function defaultProjectName(workspace: string): string {
  return basename(resolve(workspace)) || 'DSH project'
}

/** Resolve a DSH profile using the same DSH_HOME convention as the launcher. */
export function resolveDshProfileDirectory(profile: string, dshHome = process.env.DSH_HOME): string {
  const home = resolveDshHome(dshHome)
  const profileName = requiredString(profile, 'profile')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName)) {
    throw new Error('profile must be a simple DSH profile name (letters, numbers, ., _, and -)')
  }
  return resolve(home, 'profiles', profileName)
}

/** Find DSH profiles that contain at least one installed third-party bundle. */
export async function discoverDshProfiles(dshHome = process.env.DSH_HOME): Promise<string[]> {
  const profilesDirectory = resolve(resolveDshHome(dshHome), 'profiles')
  let entries
  try {
    entries = await readdir(profilesDirectory, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue
    const profileDirectory = resolveDshProfileDirectory(entry.name, dshHome)
    let bundles: string[]
    try {
      bundles = await readDshProfileBundles(profileDirectory)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`could not inspect DSH profile ${entry.name}: ${message}`)
    }
    if (bundles.some(bundle => !isDshInfrastructure(bundle))) candidates.push(entry.name)
  }
  return candidates.sort()
}

/** Build a reviewable Radar inventory from the third-party bundles in a DSH profile. */
export async function createRadarConfigFromDshProfile(options: DshInitOptions): Promise<RadarConfig> {
  const profileDirectory = resolve(options.profileDirectory)
  const bundles = await readDshProfileBundles(profileDirectory)

  // Keep the generated inventory portable by default. DSH is expected to be
  // started from the project root; callers that launch it elsewhere can pass
  // an explicit absolute workspace path.
  const workspace = options.workspace ?? '.'
  const projectId = options.projectId ?? defaultProjectId(workspace)
  const projectName = options.projectName ?? defaultProjectName(workspace)
  const inspect = options.inspect ?? inspectNpmPackage
  const hostNodeModulesDirectory = options.hostNodeModulesDirectory ?? join(dirname(profileDirectory), 'node_modules')
  const hostRuntimeSource = options.hostRuntimeSource ?? 'dsh-profile-fallback'
  const hostRuntimePackage = options.hostRuntimePackage
    ?? discoverDshRuntimePackageFromNodeModulesDirectory(hostNodeModulesDirectory)
  const hostRuntimePackageDirectory = options.hostRuntimePackageDirectory
    ?? (hostRuntimePackage === undefined ? undefined : resolve(hostNodeModulesDirectory, '@deepseek-ai', 'dsh'))
  const plugins: PluginInstallation[] = []
  for (const packageName of bundles) {
    if (isDshInfrastructure(packageName)) continue
    const manifest = await readPackageManifest(profileDirectory, packageName)
    if (manifest.name !== packageName) {
      throw new Error(`installed manifest name ${manifest.name} does not match DSH bundle ${packageName}`)
    }
    const graph = options.inspect !== undefined || options.registry !== undefined
      ? (await inspect(`npm:${manifest.name}@${manifest.version}`, {
          deep: true,
          ...(options.registry === undefined ? {} : { registry: options.registry }),
        })).evidence.npm?.dependencyAudit.graph
      : await parseInstalledNodeModulesGraph(profileDirectory, {
          name: manifest.name,
          version: manifest.version,
        }, {
          // DSH makes this shared flat directory so in-box runtime packages can
          // satisfy third-party plugin peer dependencies without being copied
          // into every profile.
          hostNodeModulesDirectory,
          hostRuntimeSource,
          ...(hostRuntimePackage === undefined ? {} : { hostRuntimePackage }),
          ...(hostRuntimePackageDirectory === undefined ? {} : { hostRuntimePackageDirectory }),
        })
    if (graph === undefined) throw new Error(`could not resolve the exact dependency graph for ${manifest.name}@${manifest.version}`)
    plugins.push({
      package: { ecosystem: 'npm', name: manifest.name, version: manifest.version },
      manifest,
      graph,
    })
  }
  if (plugins.length === 0) {
    throw new Error('DSH profile has no third-party bundles to monitor; install one with `dsh plugin --profile <name> add <package>@<exact-version>`, then rerun setup')
  }

  const config: RadarConfig = {
    schema: RADAR_CONFIG_SCHEMA,
    projects: [{
      schema: INVENTORY_SCHEMA,
      project: {
        id: projectId,
        name: projectName,
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        workspace,
        ...(options.channels === undefined || options.channels.length === 0 ? {} : { channels: options.channels }),
        ...(options.webhookUrlEnv === undefined ? {} : { webhookUrlEnv: options.webhookUrlEnv }),
        ...(options.webhookSecretEnv === undefined ? {} : { webhookSecretEnv: options.webhookSecretEnv }),
      },
      environment: { nodeVersion: process.versions.node },
      ...(options.notificationPolicy === undefined ? {} : { notificationPolicy: options.notificationPolicy }),
      plugins,
    }],
  }
  parseRadarConfig(config)
  return config
}

function createStaticLockConfig(
  graph: DependencyGraph,
  root: { name: string; version: string },
  options: Pick<PnpmLockInitOptions, 'projectId' | 'projectName' | 'repository' | 'workspace' | 'channels' | 'webhookUrlEnv' | 'webhookSecretEnv' | 'notificationPolicy'>,
): RadarConfig {
  const workspace = options.workspace ?? '.'
  const projectId = options.projectId ?? defaultProjectId(workspace)
  const projectName = options.projectName ?? defaultProjectName(workspace)
  const config: RadarConfig = {
    schema: RADAR_CONFIG_SCHEMA,
    projects: [{
      schema: INVENTORY_SCHEMA,
      project: {
        id: projectId,
        name: projectName,
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        workspace,
        ...(options.channels === undefined || options.channels.length === 0 ? {} : { channels: options.channels }),
        ...(options.webhookUrlEnv === undefined ? {} : { webhookUrlEnv: options.webhookUrlEnv }),
        ...(options.webhookSecretEnv === undefined ? {} : { webhookSecretEnv: options.webhookSecretEnv }),
      },
      environment: { nodeVersion: process.versions.node },
      ...(options.notificationPolicy === undefined ? {} : { notificationPolicy: options.notificationPolicy }),
      plugins: [{
        package: { ecosystem: 'npm', name: root.name, version: root.version },
        graph,
      }],
    }],
  }
  parseRadarConfig(config)
  return config
}

/** Build a static Radar inventory from a pnpm lockfile without installing packages. */
export async function createRadarConfigFromPnpmLock(options: PnpmLockInitOptions): Promise<RadarConfig> {
  const lockfile = resolve(options.lockfile)
  const graph = parsePnpmLockGraph(await readFile(lockfile, 'utf8'), options.root)
  return createStaticLockConfig(graph, options.root, options)
}

/** Build a static Radar inventory from an npm lockfile without installing packages. */
export async function createRadarConfigFromNpmLock(options: NpmLockInitOptions): Promise<RadarConfig> {
  const lockfile = resolve(options.lockfile)
  const graph = parseNpmLockGraph(await readJson(lockfile, MAX_LOCKFILE_JSON_BYTES), options.root)
  return createStaticLockConfig(graph, options.root, options)
}

/**
 * Rebuild a CLI-generated inventory from the profile DSH is currently running.
 * Hand-written configs and multi-project configs are intentionally left alone.
 */
export async function refreshRadarConfigFromDshProfile(
  config: RadarConfig,
  profile: string,
  dshHome?: string,
  options: Pick<DshInitOptions, 'hostNodeModulesDirectory' | 'hostRuntimeSource' | 'hostRuntimePackage' | 'hostRuntimePackageDirectory'> = {},
): Promise<RadarConfig> {
  if (config.dshProfile?.name !== profile) return config
  if (config.projects.length !== 1) throw new Error('DSH profile refresh requires exactly one configured project')
  const project = config.projects[0]
  if (project === undefined) throw new Error('DSH profile refresh found no configured project')
  const refreshed = await createRadarConfigFromDshProfile({
    profileDirectory: resolveDshProfileDirectory(profile, dshHome),
    projectId: project.project.id,
    projectName: project.project.name,
    ...(project.project.repository === undefined ? {} : { repository: project.project.repository }),
    ...(project.project.workspace === undefined ? {} : { workspace: project.project.workspace }),
    ...(project.project.channels === undefined ? {} : { channels: project.project.channels }),
    ...(project.project.webhookUrlEnv === undefined ? {} : { webhookUrlEnv: project.project.webhookUrlEnv }),
    ...(project.project.webhookSecretEnv === undefined ? {} : { webhookSecretEnv: project.project.webhookSecretEnv }),
    ...options,
  })
  const refreshedProject = refreshed.projects[0]
  if (refreshedProject === undefined) throw new Error('DSH profile refresh produced no project')
  const next: RadarConfig = {
    ...config,
    projects: [{
      ...refreshedProject,
      ...(project.notificationPolicy === undefined ? {} : { notificationPolicy: project.notificationPolicy }),
      project: { ...project.project },
    }],
  }
  parseRadarConfig(next)
  return next
}

/** Refresh a generated inventory when it carries profile metadata; static configs stay unchanged. */
export async function refreshRadarConfigFromConfiguredProfile(
  config: RadarConfig,
  dshHome?: string,
): Promise<RadarConfig> {
  const profile = config.dshProfile?.name
  if (profile === undefined) return config
  return refreshRadarConfigFromDshProfile(config, profile, dshHome)
}

export async function writeRadarConfig(config: RadarConfig, options: WriteRadarConfigOptions): Promise<string> {
  const output = resolve(options.output)
  if (!options.force) {
    try {
      await access(output)
      throw new Error(`${output} already exists; pass --force to replace it`)
    } catch (error: unknown) {
      if (error instanceof Error && !('code' in error)) throw error
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return output
}

/** Write a self-contained DSH overlay so startup does not depend on shell environment variables. */
export async function writeDshPatch(options: WriteDshPatchOptions): Promise<string> {
  const output = resolve(options.output)
  const configFile = resolve(options.configFile)
  const stateFile = resolve(options.stateFile)
  if (output === configFile || output === stateFile) {
    throw new Error('DSH patch output must be different from the Radar config and state files')
  }
  const intervalSeconds = options.intervalSeconds ?? 1_800
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 300 || intervalSeconds > 86_400) {
    throw new Error('DSH patch intervalSeconds must be between 300 and 86400')
  }
  const runOnStart = options.runOnStart ?? true
  if (!options.force) {
    try {
      await access(output)
      throw new Error(`${output} already exists; pass --force to replace it`)
    } catch (error: unknown) {
      if (error instanceof Error && !('code' in error)) throw error
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  const patch = [
    '# Generated by upstream-radar init. Review before starting DSH.',
    `# Run: dsh --profile ${JSON.stringify(options.profile)} --patch ${JSON.stringify(output)}`,
    '- id: upstream-radar',
    "  name: 'upstream-radar/dsh'",
    '  config:',
    `    configFile: ${JSON.stringify(configFile)}`,
    `    stateFile: ${JSON.stringify(stateFile)}`,
    `    profile: ${JSON.stringify(options.profile)}`,
    '    refreshProfile: true',
    `    intervalSeconds: ${intervalSeconds}`,
    `    runOnStart: ${runOnStart}`,
    ...(options.registry === undefined ? [] : [`    registry: ${JSON.stringify(options.registry)}`]),
    ...(options.deepCandidates === undefined ? [] : [`    deepCandidates: ${options.deepCandidates}`]),
    ...(options.threatIntel === undefined ? [`    threatIntel: true`] : [`    threatIntel: ${options.threatIntel}`]),
    '',
  ].join('\n')
  await writeFile(output, patch, { mode: 0o600 })
  return output
}
