import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { inspectNpmPackage, type InspectNpmOptions } from './npm.js'
import { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
import {
  INVENTORY_SCHEMA,
  RADAR_CONFIG_SCHEMA,
  type DependencyGraph,
  type PackageManifestSnapshot,
  type PluginInstallation,
  type RadarConfig,
} from './radar-types.js'

const MAX_JSON_BYTES = 8 * 1024 * 1024

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
  registry?: string
  inspect?: InitInspector
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

async function readJson(path: string): Promise<unknown> {
  const contents = await readFile(path, 'utf8')
  if (Buffer.byteLength(contents) > MAX_JSON_BYTES) throw new Error(`${path} exceeds the ${MAX_JSON_BYTES} byte limit`)
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
  return parsePackageManifestSnapshot(await readJson(path))
}

function isDshInfrastructure(packageName: string): boolean {
  return packageName === 'upstream-radar'
    || packageName === 'cordis'
    || packageName.startsWith('@deepseek-ai/')
    || packageName.startsWith('@cordis/')
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
  const home = dshHome?.trim() === '' || dshHome === undefined ? join(homedir(), '.dsh') : dshHome
  const profileName = requiredString(profile, 'profile')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName)) {
    throw new Error('profile must be a simple DSH profile name (letters, numbers, ., _, and -)')
  }
  return resolve(home, 'profiles', profileName)
}

/** Build a reviewable Radar inventory from the third-party bundles in a DSH profile. */
export async function createRadarConfigFromDshProfile(options: DshInitOptions): Promise<RadarConfig> {
  const profileDirectory = resolve(options.profileDirectory)
  const profileManifest = asRecord(await readJson(join(profileDirectory, 'package.json')), 'DSH profile package.json')
  const dsh = asRecord(profileManifest.dsh, 'DSH profile dsh')
  const profile = asRecord(dsh.profile, 'DSH profile dsh.profile')
  const bundles = profile.bundles
  if (!Array.isArray(bundles) || bundles.length === 0 || !bundles.every(item => typeof item === 'string')) {
    throw new Error('DSH profile package.json does not contain dsh.profile.bundles')
  }

  const workspace = options.workspace ?? process.cwd()
  const projectId = options.projectId ?? defaultProjectId(workspace)
  const projectName = options.projectName ?? defaultProjectName(workspace)
  const inspect = options.inspect ?? inspectNpmPackage
  const plugins: PluginInstallation[] = []
  for (const packageName of bundles) {
    if (isDshInfrastructure(packageName)) continue
    const manifest = await readPackageManifest(profileDirectory, packageName)
    if (manifest.name !== packageName) {
      throw new Error(`installed manifest name ${manifest.name} does not match DSH bundle ${packageName}`)
    }
    const report = await inspect(`npm:${manifest.name}@${manifest.version}`, {
      deep: true,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    })
    const graph = report.evidence.npm?.dependencyAudit.graph
    if (graph === undefined) {
      throw new Error(`could not resolve the exact dependency graph for ${manifest.name}@${manifest.version}`)
    }
    plugins.push({
      package: { ecosystem: 'npm', name: manifest.name, version: manifest.version },
      manifest,
      graph,
    })
  }
  if (plugins.length === 0) throw new Error('DSH profile has no third-party bundles to monitor')

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
      },
      environment: { nodeVersion: process.versions.node },
      plugins,
    }],
  }
  parseRadarConfig(config)
  return config
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
    `    intervalSeconds: ${intervalSeconds}`,
    `    runOnStart: ${runOnStart}`,
    '',
  ].join('\n')
  await writeFile(output, patch, { mode: 0o600 })
  return output
}
