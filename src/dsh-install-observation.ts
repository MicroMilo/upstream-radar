import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePnpmLockGraph } from './graph.js'
import {
  discoverDshRuntimeHostNodeModulesDirectory,
  discoverDshRuntimePackage,
  discoverDshRuntimePackageDirectory,
} from './dsh-runtime.js'
import { parseInstalledNodeModulesGraph } from './installed-graph.js'
import { parseNpmSpec } from './npm.js'
import type { DependencyKind, RootPeerContract } from './radar-types.js'
import { satisfiesSemverRange } from './semver.js'
import { parseNpmTarball, type TarEntry } from './tar.js'
import { TOOL_VERSION } from './version.js'

export const DSH_INSTALL_OBSERVATION_SCHEMA = 'upstream-radar.dsh-install-observation/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DEFAULT_TIMEOUT_MS = 180_000
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_ARTIFACT_UNPACKED_BYTES = 192 * 1024 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024
const MAX_REPORT_DETAIL_BYTES = 4 * 1024
const MAX_TRACE_BYTES = 16 * 1024 * 1024
const MAX_TRACE_LINES = 100_000
const MAX_TRACE_EVENTS = 512
const MAX_SNAPSHOT_ENTRIES = 25_000
const MAX_DIFF_PATHS = 512
const MAX_ALLOWED_BUILDS = 16
const MAX_PROFILE_LOCKFILE_BYTES = 16 * 1024 * 1024
const MAX_PROFILE_GRAPH_GAPS = 32
const MAX_PLUGIN_PEERS = 64
const MAX_STATIC_PEER_SCAN_BYTES = 8 * 1024 * 1024
const MAX_RUNTIME_DISCOVERY_DIRECTORIES = 12_000
const MAX_RUNTIME_DISCOVERY_DEPTH = 16
const PROFILE = 'headless'
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const
const PROFILE_LOCKFILE_CANDIDATES = [
  ['pnpm-lock.yaml'],
  ['node_modules', '.pnpm', 'lock.yaml'],
] as const
const SYNTHETIC_PROFILE_GRAPH_ROOT = { name: 'dsh-profile-headless', version: '0.0.0' } as const

export type DshInstallObservationResult =
  | 'compatible'
  | 'runtime-incompatible'
  | 'peer-contract-incompatible'
  | 'build-approval-required'
  | 'install-failed'
  | 'load-failed'
  | 'unknown'
export type InstallObservationPhase = 'runtime' | 'artifact' | 'profile' | 'install' | 'load'
export type InstallObservationIsolationProvider = 'github-actions-hosted-runner' | 'firecracker' | 'other'

export interface InstallObservationCommand {
  phase: InstallObservationPhase
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  sandboxRoot: string
  tracePath?: string
}

export interface InstallObservationCommandResult {
  code: number | null
  timedOut: boolean
  outputExceeded: boolean
  stdout: string
  stderr: string
  launchError?: string
}

export type InstallObservationRunner = (command: InstallObservationCommand) => Promise<InstallObservationCommandResult>

export interface InstallObservationStage {
  status: 'passed' | 'failed' | 'skipped'
  code?: number | null
  detail?: string
  timedOut?: boolean
  outputExceeded?: boolean
}

export interface InstallTraceProcess {
  executable: string
  arguments: string[]
  succeeded: boolean
  count: number
}

export interface InstallTraceNetwork {
  operation: 'connect' | 'sendto' | 'sendmsg'
  family: string
  address: string
  port?: number
  succeeded: boolean
  count: number
}

export interface InstallTraceFileWrite {
  operation: string
  path: string
  sourcePath?: string
  succeeded: boolean
  count: number
}

export interface InstallTraceObservation {
  coverage: {
    status: 'captured' | 'missing' | 'truncated'
    tracer: 'strace'
    traceFiles: number
    bytes: number
    lines: number
    parsedEvents: number
    otherLines: number
    tamperResistance: 'best-effort-same-container'
  }
  processes: InstallTraceProcess[]
  network: InstallTraceNetwork[]
  fileWrites: InstallTraceFileWrite[]
}

export interface InstallFilesystemDiff {
  created: string[]
  modified: string[]
  deleted: string[]
  totals: {
    created: number
    modified: number
    deleted: number
  }
  truncated: boolean
  snapshotErrors: number
}

export interface DshInstallProfileLockfileEvidence {
  sha256: string
  bytes: number
  graphDigest?: string
  nodes?: number
  edges?: number
  unresolved?: number
  /** A bounded, normalized sample of graph edges that could not be resolved. */
  unresolvedDependencies?: DshInstallProfileGraphGap[]
}

export interface DshInstallProfileGraphGap {
  from: string
  name: string
  spec: string
  kind: DependencyKind
}

/** A direct, required plugin peer that did not line up with the DSH runtime. */
export interface DshInstallPeerContractIssue {
  name: string
  required: string
  status: 'mismatched' | 'indeterminate' | 'missing'
  /** Static evidence explains whether a literal runtime import was observed. */
  staticUsage: DshInstallPeerStaticUsage
  resolvedVersion?: string
}

/**
 * What the packed artifact itself reveals about a declared peer. This is
 * intentionally syntactic evidence, not a claim that an unobserved import can
 * never happen at runtime.
 */
export type DshInstallPeerStaticUsage =
  | 'runtime-import-observed'
  | 'type-only-reference-observed'
  | 'no-literal-reference-observed'
  | 'scan-incomplete'

/** One direct plugin peer requirement aligned to its exact runtime resolution. */
export interface DshInstallPeerContractRelation {
  name: string
  required: string
  status: 'satisfied' | 'mismatched' | 'indeterminate' | 'missing'
  staticUsage: DshInstallPeerStaticUsage
  resolvedVersion?: string
}

/**
 * Direct plugin-to-DSH host contracts evaluated from the final installed
 * graph. This is distinct from whether the generic load probe happened to
 * exercise every API path.
 */
export interface DshInstallPluginPeerContracts {
  declared: number
  satisfied: number
  mismatched: number
  indeterminate: number
  missing: number
  /** Full bounded relation set; this is the plugin-to-DSH compatibility IR boundary. */
  relations: DshInstallPeerContractRelation[]
  issues?: DshInstallPeerContractIssue[]
}

/**
 * The dependency tree DSH can actually resolve after installing the plugin.
 * Unlike the profile lockfile alone, this may include the shared DSH host
 * dependency plane that satisfies plugin peer dependencies.
 */
export interface DshInstallRuntimeGraphEvidence {
  digest: string
  nodes: number
  edges: number
  /** Required runtime/peer gaps only. Platform-selected optional packages are reported separately. */
  unresolved: number
  unresolvedDependencies?: DshInstallProfileGraphGap[]
  /** Optional platform or feature packages absent from this exact runtime. */
  optionalUnavailable?: number
  optionalUnavailableDependencies?: DshInstallProfileGraphGap[]
  pluginPeerContracts: DshInstallPluginPeerContracts
  hostRuntime?: {
    source: 'dsh-profile-fallback' | 'dsh-process'
    resolvedNodes: number
    dshVersion?: string
  }
}

export interface DshInstallObservationReport {
  schema: typeof DSH_INSTALL_OBSERVATION_SCHEMA
  tool: { name: 'upstream-radar'; version: string }
  probe: 'dsh-install'
  scope: 'install-and-load-behavior'
  startedAt: string
  completedAt: string
  caseId?: string
  dshVersion: string
  runtime: {
    platform: string
    architecture: string
    nodeVersion: string
    packageManager: {
      name: 'pnpm'
      version?: string
    }
  }
  artifact: {
    spec: string
    name: string
    version: string
    sha256?: string
    integrity?: string
    bytes?: number
    bundlePatch?: string
    nodeEngine?: string
    lifecycleScripts: string[]
  }
  stages: {
    runtime: InstallObservationStage
    artifact: InstallObservationStage
    profile: InstallObservationStage
    install: InstallObservationStage
    registration: InstallObservationStage
    load: InstallObservationStage
  }
  observations: {
    install: InstallTraceObservation
    load: InstallTraceObservation
  }
  filesystem: {
    install: InstallFilesystemDiff
    load: InstallFilesystemDiff
  }
  resolution: {
    /** The exact DSH profile lockfile produced by the isolated install, never its contents. */
    profileLockfile?: DshInstallProfileLockfileEvidence
    /** The final profile plus shared-DSH-host graph observed after loading. */
    runtimeGraph?: DshInstallRuntimeGraphEvidence
    /** Bounded collector diagnostic when the effective graph could not be read. */
    runtimeGraphError?: string
  }
  result: DshInstallObservationResult
  reason: string
  boundary: {
    isolationProviderClaim: InstallObservationIsolationProvider
    isolationVerifiedByRadar: false
    disposableEnvironmentRequired: true
    lifecycleScriptsEnabledForPluginInstall: true
    pluginCodeMayExecuteDuringLoad: true
    inheritedHostSecrets: false
    approvedDependencyBuilds: string[]
    requiredDependencyBuilds: string[]
    note: string
  }
}

export interface DshInstallObservationOptions {
  packageSpec: string
  dshVersion: string
  caseId?: string
  allowExecution: boolean
  isolationProvider: InstallObservationIsolationProvider
  allowedBuilds?: readonly string[]
  timeoutMs?: number
  hostEnvironment?: NodeJS.ProcessEnv
  runner?: InstallObservationRunner
}

interface SnapshotEntry {
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  mtimeMs: number
}

interface TreeSnapshot {
  entries: Map<string, SnapshotEntry>
  truncated: boolean
  errors: number
}

function normalizeAllowedBuilds(values: readonly string[] | undefined): string[] {
  if (values === undefined) return []
  if (values.length > MAX_ALLOWED_BUILDS) {
    throw new Error(`DSH install observation accepts at most ${MAX_ALLOWED_BUILDS} approved dependency builds`)
  }
  const names = new Set<string>()
  for (const value of values) {
    if (value.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)) {
      throw new Error(`invalid approved dependency build package name: ${JSON.stringify(value)}`)
    }
    names.add(value)
  }
  return [...names].sort()
}

interface ParsedArtifact {
  path: string
  filename: string
  sha256: string
  integrity?: string
  bytes: number
  bundlePatch: string
  nodeEngine?: string
  lifecycleScripts: string[]
  requiredPeerDependencies: ProfilePeerRequirement[]
}

function isNpmPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(value)
}

/**
 * pnpm 10+ deliberately stops before running dependency lifecycle scripts
 * unless each package is approved. Keep that policy gate distinct from a
 * plugin install defect, but only when pnpm supplied a bounded, exact list.
 */
function requiredDependencyBuilds(output: string, artifactName: string): string[] {
  const normalized = output.replace(/\r\n?/g, '\n')
  const marker = '[ERR_PNPM_IGNORED_BUILDS]'
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex < 0) return []
  const tail = normalized.slice(markerIndex, markerIndex + MAX_COMMAND_OUTPUT_BYTES)
  const prefix = 'Ignored build scripts:'
  const prefixIndex = tail.indexOf(prefix)
  if (prefixIndex < marker.length || prefixIndex > 256) return []
  let list = tail.slice(prefixIndex + prefix.length)
  const terminator = list.search(/\n\s*\n|\n\s*Run\s+["']pnpm approve-builds["']/)
  if (terminator >= 0) list = list.slice(0, terminator)
  const coordinates = list.split(',').map(value => value.trim()).filter(Boolean)
  if (coordinates.length === 0 || coordinates.length > MAX_ALLOWED_BUILDS) return []
  const names = new Set<string>()
  for (const coordinate of coordinates) {
    try {
      const parsed = parseNpmSpec(coordinate)
      if (!EXACT_VERSION.test(parsed.version) || !isNpmPackageName(parsed.name)) return []
      names.add(parsed.name)
    } catch {
      // When the exact reviewed tarball itself has a lifecycle script, pnpm
      // prints its profile-relative file: coordinate alongside registry
      // dependencies. Accept only the already-established artifact identity;
      // an arbitrary local coordinate must not become an approval suggestion.
      const prefix = `${artifactName}@file:`
      const localPath = coordinate.startsWith(prefix) ? coordinate.slice(prefix.length) : ''
      if (localPath === '' || localPath.length > 4_096 || /[\u0000-\u0020\u007f]/.test(localPath)) return []
      names.add(artifactName)
    }
  }
  return [...names].sort()
}

function staticPeerUsage(entries: readonly TarEntry[], requirements: readonly { name: string, required: string }[]): DshInstallPeerStaticUsage[] {
  const state = new Map(requirements.map(requirement => [requirement.name, 'no-literal-reference-observed' as DshInstallPeerStaticUsage]))
  let scanned = 0
  let incomplete = false
  for (const entry of entries) {
    if (entry.type !== 'file' || entry.contents === undefined
      || !/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(entry.path)) continue
    if (scanned + entry.contents.length > MAX_STATIC_PEER_SCAN_BYTES) {
      incomplete = true
      continue
    }
    scanned += entry.contents.length
    const text = entry.contents.toString('utf8')
    const declarationFile = /\.d\.(?:[cm]?ts)$/i.test(entry.path)
    for (const requirement of requirements) {
      if (state.get(requirement.name) === 'runtime-import-observed') continue
      const escaped = requirement.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const literal = `['"]${escaped}(?:/[^'"]*)?['"]`
      // Stay within one statement line. A wider expression can start at an
      // unrelated runtime import and accidentally consume a later `import
      // type`, which would turn declaration-only evidence into a false runtime
      // claim. Missing a heavily formatted import is safer than that claim.
      const typeOnly = new RegExp(`(?:^|[;\\n])[\\t ]*import[\\t ]+type\\b[^;\\n]{0,1024}?\\bfrom[\\t ]*${literal}`)
      const runtime = new RegExp([
        `(?:^|[;\\n])[\\t ]*import[\\t ]+(?!type\\b)(?:[^;\\n]{0,1024}?[\\t ]+from[\\t ]+)?${literal}`,
        `(?:^|[;\\n])[\\t ]*export[\\t ]+(?!type\\b)[^;\\n]{0,1024}?[\\t ]+from[\\t ]+${literal}`,
        `\\b(?:require|import)\\s*\\(\\s*${literal}`,
      ].join('|'))
      const literalReference = new RegExp(literal)
      if (!declarationFile && runtime.test(text)) {
        state.set(requirement.name, 'runtime-import-observed')
      } else if (declarationFile ? literalReference.test(text) : typeOnly.test(text)) {
        state.set(requirement.name, 'type-only-reference-observed')
      }
    }
  }
  return requirements.map(requirement => {
    const observed = state.get(requirement.name) ?? 'no-literal-reference-observed'
    return observed === 'no-literal-reference-observed' && incomplete ? 'scan-incomplete' : observed
  })
}

function requiredPeerDependencies(manifest: Record<string, unknown>, entries: readonly TarEntry[]): ProfilePeerRequirement[] {
  const peers = typeof manifest.peerDependencies === 'object' && manifest.peerDependencies !== null && !Array.isArray(manifest.peerDependencies)
    ? manifest.peerDependencies as Record<string, unknown>
    : {}
  const metadata = typeof manifest.peerDependenciesMeta === 'object' && manifest.peerDependenciesMeta !== null && !Array.isArray(manifest.peerDependenciesMeta)
    ? manifest.peerDependenciesMeta as Record<string, unknown>
    : {}
  const requirements: Array<{ name: string, required: string }> = []
  for (const [name, rawRange] of Object.entries(peers).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isNpmPackageName(name)) throw new Error(`packed artifact has an invalid peer dependency name: ${name}`)
    if (typeof rawRange !== 'string' || rawRange.trim() === '' || rawRange.length > 512) {
      throw new Error(`packed artifact has an invalid peer dependency range for ${name}`)
    }
    const peerMetadata = metadata[name]
    const optional = typeof peerMetadata === 'object' && peerMetadata !== null && !Array.isArray(peerMetadata)
      && (peerMetadata as Record<string, unknown>).optional === true
    if (!optional) requirements.push({ name, required: bounded(rawRange.trim(), 512) })
  }
  if (requirements.length > MAX_PLUGIN_PEERS) {
    throw new Error(`packed artifact declares more than ${MAX_PLUGIN_PEERS} required peer dependencies`)
  }
  const usages = staticPeerUsage(entries, requirements)
  return requirements.map((requirement, index) => ({
    ...requirement,
    staticUsage: usages[index] ?? 'scan-incomplete',
  }))
}

function bounded(value: string, maximum = MAX_REPORT_DETAIL_BYTES): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

function decodeStraceString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\\n')
    .replace(/\\r/g, '\\r')
    .replace(/\\t/g, '\\t')
}

function quotedValues(value: string, maximum = 32): string[] {
  const values: string[] = []
  const expression = /"((?:\\.|[^"\\])*)"/g
  for (let match = expression.exec(value); match !== null && values.length < maximum; match = expression.exec(value)) {
    values.push(bounded(decodeStraceString(match[1] ?? ''), 512))
  }
  return values
}

function syscallSucceeded(line: string): boolean {
  const result = line.match(/\)\s+=\s+([^\s]+)/)?.[1]
  return result !== undefined && !result.startsWith('-1')
}

function sandboxPath(value: string, sandboxRoot: string): string {
  const normalizedRoot = resolve(sandboxRoot)
  const normalizedValue = value.startsWith('/') ? resolve(value) : value
  if (normalizedValue === normalizedRoot) return '$SANDBOX'
  if (normalizedValue.startsWith(`${normalizedRoot}${sep}`)) {
    return `$SANDBOX/${normalizedValue.slice(normalizedRoot.length + 1).replaceAll(sep, '/')}`
  }
  return bounded(value, 1_024)
}

function incrementEvent<T extends { count: number }>(events: Map<string, T>, key: string, event: T): void {
  const existing = events.get(key)
  if (existing !== undefined) existing.count += 1
  else if (events.size < MAX_TRACE_EVENTS) events.set(key, event)
}

export function parseDshInstallTrace(
  traces: readonly string[],
  sandboxRoot: string,
  options: { inputTruncated?: boolean } = {},
): InstallTraceObservation {
  if (traces.length === 0) return emptyTraceObservation()
  const processes = new Map<string, InstallTraceProcess>()
  const network = new Map<string, InstallTraceNetwork>()
  const fileWrites = new Map<string, InstallTraceFileWrite>()
  let bytes = 0
  let lines = 0
  let parsedEvents = 0
  let otherLines = 0
  let truncated = options.inputTruncated === true

  outer: for (const trace of traces) {
    bytes += Buffer.byteLength(trace)
    for (const line of trace.split(/\r?\n/)) {
      if (line === '') continue
      if (lines >= MAX_TRACE_LINES) {
        truncated = true
        break outer
      }
      lines += 1
      const succeeded = syscallSucceeded(line)

      const execMatch = line.match(/\bexecve\("((?:\\.|[^"\\])*)",\s*\[(.*?)\],/)
        ?? line.match(/\bexecveat\([^,]+,\s*"((?:\\.|[^"\\])*)",\s*\[(.*?)\],/)
      if (execMatch !== null) {
        const executable = sandboxPath(decodeStraceString(execMatch[1] ?? ''), sandboxRoot)
        const argumentsList = quotedValues(execMatch[2] ?? '', 16)
        const key = `${executable}\u0000${argumentsList.join('\u0000')}\u0000${succeeded}`
        incrementEvent(processes, key, { executable, arguments: argumentsList, succeeded, count: 1 })
        parsedEvents += 1
        continue
      }

      const networkMatch = line.match(/\b(connect|sendto|sendmsg)\(/)
      if (networkMatch !== null) {
        const operation = networkMatch[1] as InstallTraceNetwork['operation']
        const family = line.match(/sa_family=(AF_[A-Z0-9_]+)/)?.[1] ?? 'unknown'
        const address = line.match(/sin_addr=inet_addr\("([^"]+)"\)/)?.[1]
          ?? line.match(/inet_pton\(AF_INET6,\s*"([^"]+)"/)?.[1]
          ?? line.match(/sun_path="((?:\\.|[^"\\])*)"/)?.[1]
        if (address !== undefined) {
          const decodedAddress = family === 'AF_UNIX'
            ? sandboxPath(decodeStraceString(address), sandboxRoot)
            : bounded(decodeStraceString(address), 256)
          const portText = line.match(/sin6?_port=htons\((\d+)\)/)?.[1]
          const port = portText === undefined ? undefined : Number(portText)
          const key = `${operation}\u0000${family}\u0000${decodedAddress}\u0000${port ?? ''}\u0000${succeeded}`
          incrementEvent(network, key, {
            operation,
            family,
            address: decodedAddress,
            ...(port === undefined ? {} : { port }),
            succeeded,
            count: 1,
          })
          parsedEvents += 1
          continue
        }
      }

      const operation = line.match(/\b(openat2?|open|creat|renameat2?|rename|unlink(?:at)?|mkdir(?:at)?|rmdir|symlink(?:at)?|link(?:at)?|truncate|ftruncate|chmod|fchmodat|chown|fchownat)\(/)?.[1]
      if (operation !== undefined) {
        const isOpen = operation === 'open' || operation === 'openat' || operation === 'openat2'
        const writes = !isOpen || /\b(?:O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)\b/.test(line)
        if (writes) {
          const values = quotedValues(line, 4)
          const first = values[0]
          if (first !== undefined) {
            const hasSourceAndDestination = /^(?:rename|renameat|renameat2|symlink|symlinkat|link|linkat)$/.test(operation)
            const destination = hasSourceAndDestination && values[1] !== undefined ? values[1] : first
            const path = sandboxPath(destination, sandboxRoot)
            const sourcePath = hasSourceAndDestination ? sandboxPath(first, sandboxRoot) : undefined
            const key = `${operation}\u0000${sourcePath ?? ''}\u0000${path}\u0000${succeeded}`
            incrementEvent(fileWrites, key, {
              operation,
              path,
              ...(sourcePath === undefined ? {} : { sourcePath }),
              succeeded,
              count: 1,
            })
            parsedEvents += 1
            continue
          }
        }
      }
      otherLines += 1
    }
  }

  if (processes.size >= MAX_TRACE_EVENTS || network.size >= MAX_TRACE_EVENTS || fileWrites.size >= MAX_TRACE_EVENTS) {
    truncated = true
  }
  return {
    coverage: {
      status: truncated ? 'truncated' : 'captured',
      tracer: 'strace',
      traceFiles: traces.length,
      bytes,
      lines,
      parsedEvents,
      otherLines,
      tamperResistance: 'best-effort-same-container',
    },
    processes: [...processes.values()],
    network: [...network.values()],
    fileWrites: [...fileWrites.values()],
  }
}

function emptyTraceObservation(): InstallTraceObservation {
  return {
    coverage: {
      status: 'missing',
      tracer: 'strace',
      traceFiles: 0,
      bytes: 0,
      lines: 0,
      parsedEvents: 0,
      otherLines: 0,
      tamperResistance: 'best-effort-same-container',
    },
    processes: [],
    network: [],
    fileWrites: [],
  }
}

function emptyFilesystemDiff(): InstallFilesystemDiff {
  return {
    created: [],
    modified: [],
    deleted: [],
    totals: { created: 0, modified: 0, deleted: 0 },
    truncated: false,
    snapshotErrors: 0,
  }
}

function controlledEnvironment(root: string, hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = hostEnvironment[name]
    if (value !== undefined) environment[name] = value
  }
  if (environment.PATH === undefined && environment.Path === undefined) environment.PATH = '/usr/local/bin:/usr/bin:/bin'
  environment.HOME = join(root, 'home')
  environment.DSH_HOME = join(root, 'dsh-home')
  environment.XDG_CACHE_HOME = join(root, 'xdg-cache')
  environment.XDG_CONFIG_HOME = join(root, 'xdg-config')
  environment.XDG_DATA_HOME = join(root, 'xdg-data')
  environment.TMPDIR = join(root, 'tmp')
  environment.NPM_CONFIG_CACHE = join(root, 'npm-cache')
  environment.NPM_CONFIG_USERCONFIG = join(root, 'controlled.npmrc')
  environment.NPM_CONFIG_GLOBALCONFIG = join(root, 'controlled-global.npmrc')
  environment.NPM_CONFIG_AUDIT = 'false'
  environment.NPM_CONFIG_FUND = 'false'
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  environment.PNPM_HOME = join(root, 'pnpm-home')
  environment.COREPACK_HOME = join(root, 'corepack-home')
  environment.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = join(root, 'controlled.gitconfig')
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.DSH_PERMISSION_MODE = 'read-only'
  environment.DSH_TELEMETRY_MODE = 'DISABLED'
  environment.CI = 'true'
  environment.NO_COLOR = '1'
  return environment
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

function dshArgs(dshVersion: string, args: readonly string[]): string[] {
  return ['dlx', `--package=@deepseek-ai/dsh@${dshVersion}`, 'dsh', ...args]
}

function defaultCommandRunner(input: InstallObservationCommand): Promise<InstallObservationCommandResult> {
  return new Promise(resolveResult => {
    const traced = input.tracePath !== undefined
    const command = traced ? 'strace' : input.command
    const args = traced
      ? ['-f', '-qq', '-s', '256', '-o', input.tracePath as string, '-e', 'trace=%process,%file,%network', '--', input.command, ...input.args]
      : input.args
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputExceeded = false
    let timedOut = false
    let launchError: string | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const terminate = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolveResult({
        code,
        timedOut,
        outputExceeded,
        stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
        ...(launchError === undefined ? {} : { launchError }),
      })
    }
    const collect = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (stdoutBytes + stderrBytes + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true
        terminate()
        return
      }
      if (stream === 'stdout') stdoutBytes += chunk.length
      else stderrBytes += chunk.length
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, 'stderr'))
    child.once('error', error => {
      launchError = bounded(error.message)
      finish(null)
    })
    child.once('close', code => finish(code))
    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, input.timeoutMs)
  })
}

function commandStage(result: InstallObservationCommandResult): InstallObservationStage {
  if (result.code === 0 && !result.timedOut && !result.outputExceeded && result.launchError === undefined) {
    return { status: 'passed', code: result.code }
  }
  const output = [result.launchError, result.stderr, result.stdout].filter(value => value !== undefined && value !== '').join('\n').trim()
  const prefix = result.timedOut
    ? 'command timed out'
    : result.outputExceeded
      ? 'command exceeded the output budget'
      : result.launchError !== undefined
        ? 'command could not start'
        : `command exited with ${result.code}`
  return {
    status: 'failed',
    code: result.code,
    detail: output === '' ? prefix : `${prefix}: ${bounded(output)}`,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.outputExceeded ? { outputExceeded: true } : {}),
  }
}

async function runSafely(runner: InstallObservationRunner, input: InstallObservationCommand): Promise<InstallObservationCommandResult> {
  try {
    return await runner(input)
  } catch (error: unknown) {
    return {
      code: null,
      timedOut: false,
      outputExceeded: false,
      stdout: '',
      stderr: '',
      launchError: bounded(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function readRegularFileNoFollow(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${basename(path)} is not a regular file`)
    if (metadata.size > maximum) throw new Error(`${basename(path)} exceeds ${maximum} bytes`)
    const buffer = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset !== buffer.length) throw new Error(`${basename(path)} changed while it was being read`)
    return buffer
  } finally {
    await handle.close()
  }
}

async function parsePackedArtifact(
  result: InstallObservationCommandResult,
  artifactDirectory: string,
  expectedName: string,
  expectedVersion: string,
): Promise<ParsedArtifact> {
  if (commandStage(result).status !== 'passed') throw new Error(commandStage(result).detail ?? 'npm pack failed')
  const stdout = result.stdout.trim()
  let filename: unknown
  let integrity: string | undefined
  if (stdout.startsWith('[')) {
    let output: unknown
    try {
      output = JSON.parse(stdout) as unknown
    } catch {
      throw new Error('npm pack did not return valid JSON')
    }
    if (!Array.isArray(output) || output.length !== 1 || typeof output[0] !== 'object' || output[0] === null) {
      throw new Error('npm pack returned an unexpected result')
    }
    const item = output[0] as Record<string, unknown>
    filename = item.filename
    integrity = typeof item.integrity === 'string' ? bounded(item.integrity, 1_024) : undefined
  } else {
    const lines = stdout.split(/\r?\n/)
    if (lines.length !== 1) throw new Error('npm pack returned an unexpected result')
    filename = lines[0]
  }
  if (typeof filename !== 'string' || filename === '' || filename !== basename(filename) || !filename.endsWith('.tgz')) {
    throw new Error('npm pack returned an unsafe artifact filename')
  }
  const path = resolve(artifactDirectory, filename)
  if (!path.startsWith(`${resolve(artifactDirectory)}${sep}`)) throw new Error('npm pack artifact escaped its directory')
  const compressed = await readRegularFileNoFollow(path, MAX_ARTIFACT_BYTES)
  const parsed = parseNpmTarball(compressed, {
    maxFileBytes: MAX_ARTIFACT_BYTES,
    maxUnpackedBytes: MAX_ARTIFACT_UNPACKED_BYTES,
  })
  const manifestEntry = parsed.entries.find(entry => entry.path === 'package.json' && entry.type === 'file')
  if (manifestEntry?.contents === undefined) throw new Error('packed artifact has no package.json')
  let manifest: Record<string, unknown>
  try {
    const value = JSON.parse(manifestEntry.contents.toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    manifest = value as Record<string, unknown>
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
  const bundlePatchValue = bundle?.patch
  if (typeof bundlePatchValue !== 'string' || bundlePatchValue === '') throw new Error('packed artifact does not declare dsh.bundle.patch')
  const bundlePatch = bundlePatchValue.replace(/^\.\//, '')
  if (bundlePatch.startsWith('/') || bundlePatch.includes('\\') || bundlePatch.split('/').some(part => part === '..' || part === '')) {
    throw new Error('packed artifact declares an unsafe dsh.bundle.patch')
  }
  if (!parsed.entries.some(entry => entry.path === bundlePatch && entry.type === 'file')) {
    throw new Error(`packed artifact is missing ${bundlePatch}`)
  }
  const scripts = typeof manifest.scripts === 'object' && manifest.scripts !== null && !Array.isArray(manifest.scripts)
    ? manifest.scripts as Record<string, unknown>
    : {}
  const lifecycleScripts = LIFECYCLE_SCRIPTS.filter(name => typeof scripts[name] === 'string')
  const engines = typeof manifest.engines === 'object' && manifest.engines !== null && !Array.isArray(manifest.engines)
    ? manifest.engines as Record<string, unknown>
    : undefined
  const rawNodeEngine = typeof engines?.node === 'string' ? engines.node.trim() : undefined
  if (rawNodeEngine !== undefined && rawNodeEngine.length > 512) {
    throw new Error('packed artifact Node engine requirement exceeds 512 characters')
  }
  const nodeEngine = rawNodeEngine === undefined || rawNodeEngine === '' ? undefined : bounded(rawNodeEngine, 512)
  const peerRequirements = requiredPeerDependencies(manifest, parsed.entries)
  return {
    path,
    filename,
    sha256: createHash('sha256').update(compressed).digest('hex'),
    ...(integrity === undefined ? {} : { integrity }),
    bytes: compressed.length,
    bundlePatch,
    ...(nodeEngine === undefined ? {} : { nodeEngine }),
    lifecycleScripts,
    requiredPeerDependencies: peerRequirements,
  }
}

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const snapshot: TreeSnapshot = { entries: new Map(), truncated: false, errors: 0 }
  const queue = [root]
  while (queue.length > 0) {
    if (snapshot.entries.size >= MAX_SNAPSHOT_ENTRIES) {
      snapshot.truncated = true
      break
    }
    const current = queue.shift()
    if (current === undefined) break
    let metadata
    try {
      metadata = await lstat(current)
    } catch {
      snapshot.errors += 1
      continue
    }
    const path = relative(root, current).replaceAll(sep, '/') || '.'
    const type: SnapshotEntry['type'] = metadata.isDirectory()
      ? 'directory'
      : metadata.isFile()
        ? 'file'
        : metadata.isSymbolicLink()
          ? 'symlink'
          : 'other'
    snapshot.entries.set(path, { type, size: metadata.size, mtimeMs: metadata.mtimeMs })
    if (type !== 'directory') continue
    try {
      const children = await readdir(current, { withFileTypes: true })
      children.sort((left, right) => left.name.localeCompare(right.name))
      for (const child of children) queue.push(join(current, child.name))
    } catch {
      snapshot.errors += 1
    }
  }
  return snapshot
}

async function snapshotSandbox(sandboxRoot: string, environment: NodeJS.ProcessEnv): Promise<TreeSnapshot> {
  const combined: TreeSnapshot = { entries: new Map(), truncated: false, errors: 0 }
  for (const path of [environment.DSH_HOME, environment.HOME]) {
    if (path === undefined) continue
    const snapshot = await snapshotTree(path)
    combined.truncated ||= snapshot.truncated
    combined.errors += snapshot.errors
    const prefix = relative(sandboxRoot, path).replaceAll(sep, '/')
    for (const [entryPath, entry] of snapshot.entries) {
      if (combined.entries.size >= MAX_SNAPSHOT_ENTRIES) {
        combined.truncated = true
        break
      }
      combined.entries.set(`$SANDBOX/${prefix}${entryPath === '.' ? '' : `/${entryPath}`}`, entry)
    }
  }
  return combined
}

function snapshotSignature(entry: SnapshotEntry): string {
  return `${entry.type}\u0000${entry.size}\u0000${entry.type === 'directory' ? '' : entry.mtimeMs}`
}

function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): InstallFilesystemDiff {
  const createdAll: string[] = []
  const modifiedAll: string[] = []
  const deletedAll: string[] = []
  for (const [path, entry] of after.entries) {
    const previous = before.entries.get(path)
    if (previous === undefined) createdAll.push(path)
    else if (snapshotSignature(previous) !== snapshotSignature(entry)) modifiedAll.push(path)
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) deletedAll.push(path)
  }
  createdAll.sort()
  modifiedAll.sort()
  deletedAll.sort()
  return {
    created: createdAll.slice(0, MAX_DIFF_PATHS),
    modified: modifiedAll.slice(0, MAX_DIFF_PATHS),
    deleted: deletedAll.slice(0, MAX_DIFF_PATHS),
    totals: { created: createdAll.length, modified: modifiedAll.length, deleted: deletedAll.length },
    truncated: before.truncated || after.truncated
      || createdAll.length > MAX_DIFF_PATHS || modifiedAll.length > MAX_DIFF_PATHS || deletedAll.length > MAX_DIFF_PATHS,
    snapshotErrors: before.errors + after.errors,
  }
}

async function readTrace(path: string, sandboxRoot: string): Promise<InstallTraceObservation> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile()) return emptyTraceObservation()
    const truncated = metadata.size > MAX_TRACE_BYTES
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const length = Math.min(metadata.size, MAX_TRACE_BYTES)
      const buffer = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const read = await handle.read(buffer, offset, length - offset, offset)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      return parseDshInstallTrace([buffer.subarray(0, offset).toString('utf8')], sandboxRoot, { inputTruncated: truncated })
    } finally {
      await handle.close()
    }
  } catch {
    return emptyTraceObservation()
  }
}

async function registeredBundle(dshHome: string, packageName: string): Promise<boolean> {
  try {
    const contents = await readRegularFileNoFollow(join(dshHome, 'profiles', PROFILE, 'package.json'), 4 * 1024 * 1024)
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

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * DSH versions have emitted both a project lockfile and pnpm's virtual-store
 * lockfile. Read only those fixed descendants, refuse every symlink in their
 * path, and never retain the lockfile contents outside the disposable runner.
 */
async function readProfileLockfile(dshHome: string): Promise<Buffer | undefined> {
  const profileDirectory = join(dshHome, 'profiles', PROFILE)
  try {
    const profileMetadata = await lstat(profileDirectory)
    if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) return undefined
  } catch {
    return undefined
  }

  for (const segments of PROFILE_LOCKFILE_CANDIDATES) {
    let current = profileDirectory
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] as string
        current = join(current, segment)
        const metadata = await lstat(current)
        if (metadata.isSymbolicLink()) return undefined
        if (index < segments.length - 1 && !metadata.isDirectory()) return undefined
      }
      return await readRegularFileNoFollow(current, MAX_PROFILE_LOCKFILE_BYTES)
    } catch (error: unknown) {
      if (isNotFound(error)) continue
      return undefined
    }
  }
  return undefined
}

function profileGraphRoot(manifest: Record<string, unknown>): { name: string, version: string } {
  return typeof manifest.name === 'string' && manifest.name.length > 0
    && typeof manifest.version === 'string' && EXACT_VERSION.test(manifest.version)
    ? { name: manifest.name, version: manifest.version }
    : SYNTHETIC_PROFILE_GRAPH_ROOT
}

function graphGaps(graph: { unresolved?: readonly DshInstallProfileGraphGap[] }): DshInstallProfileGraphGap[] | undefined {
  if (graph.unresolved === undefined || graph.unresolved.length === 0) return undefined
  return graph.unresolved.slice(0, MAX_PROFILE_GRAPH_GAPS).map(gap => ({
    from: bounded(gap.from, 512),
    name: bounded(gap.name, 214),
    spec: bounded(gap.spec, 512),
    kind: gap.kind,
  }))
}

function pluginPeerContractEvidence(contracts: readonly ObservedPeerContract[] | undefined): DshInstallPluginPeerContracts {
  const entries = [...(contracts ?? [])].sort((left, right) => left.name.localeCompare(right.name))
  const issues = entries
    .filter((entry): entry is ObservedPeerContract & { status: DshInstallPeerContractIssue['status'] } => entry.status !== 'satisfied')
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    declared: entries.length,
    satisfied: entries.filter(entry => entry.status === 'satisfied').length,
    mismatched: entries.filter(entry => entry.status === 'mismatched').length,
    indeterminate: entries.filter(entry => entry.status === 'indeterminate').length,
    missing: entries.filter(entry => entry.status === 'missing').length,
    relations: entries.map(entry => ({
      name: bounded(entry.name, 214),
      required: bounded(entry.required, 512),
      status: entry.status,
      staticUsage: entry.staticUsage,
      ...(entry.resolvedVersion === undefined ? {} : { resolvedVersion: bounded(entry.resolvedVersion, 256) }),
    })),
    ...(issues.length === 0 ? {} : {
      issues: issues.slice(0, MAX_PROFILE_GRAPH_GAPS).map(issue => ({
        name: bounded(issue.name, 214),
        required: bounded(issue.required, 512),
        status: issue.status,
        staticUsage: issue.staticUsage,
        ...(issue.resolvedVersion === undefined ? {} : { resolvedVersion: bounded(issue.resolvedVersion, 256) }),
      })),
    }),
  }
}

function graphGapPartitions(graph: { unresolved?: readonly DshInstallProfileGraphGap[] }): {
  required: DshInstallProfileGraphGap[]
  optional: DshInstallProfileGraphGap[]
} {
  const required: DshInstallProfileGraphGap[] = []
  const optional: DshInstallProfileGraphGap[] = []
  for (const gap of graph.unresolved ?? []) {
    if (gap.kind === 'optional') optional.push(gap)
    else required.push(gap)
  }
  return { required, optional }
}

function isLexicallyInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..')
}

interface ProfilePeerRequirement {
  name: string
  required: string
  staticUsage: DshInstallPeerStaticUsage
}

interface ObservedPeerContract extends RootPeerContract {
  staticUsage: DshInstallPeerStaticUsage
}

interface ProfilePeerResolutionRecord {
  name: string
  status: 'resolved' | 'missing'
  url?: string
}

const PROFILE_PEER_RESOLUTION_SCHEMA = 'upstream-radar.profile-peer-resolution/v1alpha1'

function indeterminatePeerContracts(requirements: readonly ProfilePeerRequirement[]): ObservedPeerContract[] {
  return requirements.map(requirement => ({ ...requirement, status: 'indeterminate' }))
}

async function peerVersionFromResolvedModule(
  url: string,
  expectedName: string,
  sandboxRoot: string,
): Promise<string | undefined> {
  let resolvedModule: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return undefined
    resolvedModule = await realpath(fileURLToPath(parsed))
  } catch {
    return undefined
  }
  let sandboxReal: string
  try {
    sandboxReal = await realpath(sandboxRoot)
  } catch {
    return undefined
  }
  if (!isLexicallyInside(sandboxReal, resolvedModule)) return undefined
  let cursor = dirname(resolvedModule)
  for (let depth = 0; depth < 32 && isLexicallyInside(sandboxReal, cursor); depth += 1) {
    try {
      const manifest = JSON.parse((await readRegularFileNoFollow(join(cursor, 'package.json'), 1 * 1024 * 1024)).toString('utf8')) as unknown
      if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
        const item = manifest as Record<string, unknown>
        if (item.name === expectedName && typeof item.version === 'string' && EXACT_VERSION.test(item.version)) return item.version
      }
    } catch {
      // Continue toward the package root; a module may live in a nested directory.
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return undefined
}

async function readProfilePeerContracts(
  path: string,
  requirements: readonly ProfilePeerRequirement[],
  sandboxRoot: string,
): Promise<ObservedPeerContract[]> {
  if (requirements.length === 0) return []
  let records: ProfilePeerResolutionRecord[]
  try {
    const raw = JSON.parse((await readRegularFileNoFollow(path, 64 * 1024)).toString('utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return indeterminatePeerContracts(requirements)
    const item = raw as Record<string, unknown>
    if (item.schema !== PROFILE_PEER_RESOLUTION_SCHEMA || !Array.isArray(item.peers) || item.peers.length !== requirements.length) {
      return indeterminatePeerContracts(requirements)
    }
    records = item.peers.map((value): ProfilePeerResolutionRecord => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid peer resolver record')
      const peer = value as Record<string, unknown>
      if (typeof peer.name !== 'string' || (peer.status !== 'resolved' && peer.status !== 'missing')) {
        throw new Error('invalid peer resolver record')
      }
      if (peer.status === 'resolved' && (typeof peer.url !== 'string' || peer.url.length === 0 || peer.url.length > 4_096)) {
        throw new Error('resolved peer has no bounded URL')
      }
      return {
        name: peer.name,
        status: peer.status,
        ...(typeof peer.url === 'string' ? { url: peer.url } : {}),
      }
    })
  } catch {
    return indeterminatePeerContracts(requirements)
  }
  const byName = new Map(records.map(record => [record.name, record]))
  if (byName.size !== requirements.length || requirements.some(requirement => !byName.has(requirement.name))) {
    return indeterminatePeerContracts(requirements)
  }
  const contracts: ObservedPeerContract[] = []
  for (const requirement of requirements) {
    const record = byName.get(requirement.name)
    if (record === undefined || record.status === 'missing') {
      contracts.push({ ...requirement, status: 'missing' })
      continue
    }
    const resolvedVersion = record.url === undefined
      ? undefined
      : await peerVersionFromResolvedModule(record.url, requirement.name, sandboxRoot)
    if (resolvedVersion === undefined) {
      contracts.push({ ...requirement, status: 'indeterminate' })
      continue
    }
    const evaluation = satisfiesSemverRange(resolvedVersion, requirement.required)
    contracts.push({
      ...requirement,
      status: evaluation === true ? 'satisfied' : evaluation === false ? 'mismatched' : 'indeterminate',
      resolvedVersion,
    })
  }
  return contracts
}

/**
 * Resolve direct peer contracts from the profile anchor, then boot the actual
 * composed DSH profile. A DSH bundle does not have to export its package root:
 * its patch may load one or more package subpaths (or a command adapter).
 * Importing the root here would therefore test a contract DSH never declared.
 */
async function writeProfileLoadProbe(
  dshHome: string,
  dshVersion: string,
  pnpmCommand: string,
  peerRequirements: readonly ProfilePeerRequirement[],
): Promise<{ path: string, peerResolutionPath: string, profileDirectory: string }> {
  const profileDirectory = join(dshHome, 'profiles', PROFILE)
  const profileMetadata = await lstat(profileDirectory)
  if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) {
    throw new Error('the DSH profile directory is not a regular directory for the load probe')
  }
  const [homeReal, profileReal] = await Promise.all([realpath(dshHome), realpath(profileDirectory)])
  if (!isLexicallyInside(homeReal, profileReal)) {
    throw new Error('the DSH profile directory escaped the controlled DSH home')
  }
  const probePath = join(profileDirectory, '.upstream-radar-load-probe.mjs')
  const peerResolutionPath = join(profileDirectory, '.upstream-radar-peer-resolution.json')
  const dshBootArgs = dshArgs(dshVersion, ['--profile', PROFILE, '--help'])
  const contents = [
    "import { spawn } from 'node:child_process'",
    "import { writeFile } from 'node:fs/promises'",
    `const peerRequirements = ${JSON.stringify(peerRequirements)}`,
    'const peers = []',
    'for (const peer of peerRequirements) {',
    '  try { peers.push({ name: peer.name, status: \'resolved\', url: import.meta.resolve(peer.name) }) }',
    '  catch { peers.push({ name: peer.name, status: \'missing\' }) }',
    '}',
    `await writeFile(${JSON.stringify(peerResolutionPath)}, JSON.stringify({ schema: ${JSON.stringify(PROFILE_PEER_RESOLUTION_SCHEMA)}, peers }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })`,
    `const child = spawn(${JSON.stringify(pnpmCommand)}, ${JSON.stringify(dshBootArgs)}, { cwd: process.cwd(), env: process.env, stdio: 'inherit' })`,
    "const exitCode = await new Promise(resolve => {",
    "  child.once('error', error => { console.error(error.message); resolve(1) })",
    "  child.once('close', code => resolve(code ?? 1))",
    '})',
    'process.exitCode = exitCode',
    '',
  ].join('\n')
  // Never overwrite a path a target package may have planted in the profile.
  await writeFile(probePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return { path: probePath, peerResolutionPath, profileDirectory }
}

interface ExactDshRuntime {
  packageDirectory: string
  nodeModulesDirectory: string
  package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: string }
}

/**
 * `pnpm dlx` owns the DSH host dependency plane, rather than a plugin-created
 * symlink in the profile. Discover the exact cached DSH package by manifest,
 * with bounded directory traversal and no symlink following.
 */
async function discoverExactDshRuntime(cacheHome: string, dshVersion: string): Promise<ExactDshRuntime> {
  const root = resolve(cacheHome, 'pnpm', 'dlx')
  const rootReal = await realpath(root)
  const queue: Array<{ path: string, depth: number }> = [{ path: root, depth: 0 }]
  const candidates = new Set<string>()
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (visited >= MAX_RUNTIME_DISCOVERY_DIRECTORIES) {
      throw new Error(`DSH runtime discovery exceeds ${MAX_RUNTIME_DISCOVERY_DIRECTORIES} directories`)
    }
    visited += 1
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch (error: unknown) {
      if (isNotFound(error)) continue
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(current.path, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < MAX_RUNTIME_DISCOVERY_DEPTH) queue.push({ path: child, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue
      let manifest: unknown
      try {
        manifest = JSON.parse((await readRegularFileNoFollow(child, 1 * 1024 * 1024)).toString('utf8')) as unknown
      } catch {
        continue
      }
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) continue
      const item = manifest as Record<string, unknown>
      if (item.name === '@deepseek-ai/dsh' && item.version === dshVersion) candidates.add(child)
    }
  }
  if (candidates.size === 0) throw new Error(`exact @deepseek-ai/dsh@${dshVersion} was not found in the controlled pnpm dlx cache`)
  if (candidates.size > 1) throw new Error(`multiple exact @deepseek-ai/dsh@${dshVersion} packages were found in the controlled pnpm dlx cache`)
  const manifestPath = [...candidates][0] as string
  const packageDirectory = discoverDshRuntimePackageDirectory(manifestPath)
  const packageCoordinate = discoverDshRuntimePackage(manifestPath)
  const nodeModulesDirectory = discoverDshRuntimeHostNodeModulesDirectory(manifestPath)
  if (packageDirectory === undefined || packageCoordinate === undefined || nodeModulesDirectory === undefined) {
    throw new Error('the exact DSH package did not expose a usable dependency plane')
  }
  if (!isLexicallyInside(rootReal, packageDirectory) || !isLexicallyInside(rootReal, nodeModulesDirectory)) {
    throw new Error('the exact DSH dependency plane escaped the controlled pnpm dlx cache')
  }
  if (packageCoordinate.name !== '@deepseek-ai/dsh' || packageCoordinate.version !== dshVersion) {
    throw new Error('the discovered DSH package does not match the requested exact version')
  }
  return {
    packageDirectory,
    nodeModulesDirectory,
    package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: packageCoordinate.version },
  }
}

async function profileResolutionEvidence(dshHome: string): Promise<DshInstallObservationReport['resolution']> {
  const profileDirectory = join(dshHome, 'profiles', PROFILE)
  const lockfile = await readProfileLockfile(dshHome)
  if (lockfile === undefined) return {}
  const profileLockfile: DshInstallProfileLockfileEvidence = {
    sha256: createHash('sha256').update(lockfile).digest('hex'),
    bytes: lockfile.length,
  }
  try {
    const manifestBuffer = await readRegularFileNoFollow(join(profileDirectory, 'package.json'), 4 * 1024 * 1024)
    const manifest = JSON.parse(manifestBuffer.toString('utf8')) as Record<string, unknown>
    const graph = parsePnpmLockGraph(lockfile.toString('utf8'), profileGraphRoot(manifest))
    const gaps = graphGaps(graph)
    return {
      profileLockfile: {
        ...profileLockfile,
        ...(graph.digest === undefined ? {} : { graphDigest: graph.digest }),
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        unresolved: graph.unresolved?.length ?? 0,
        ...(gaps === undefined ? {} : { unresolvedDependencies: gaps }),
      },
    }
  } catch {
    return { profileLockfile }
  }
}

async function runtimeGraphEvidence(
  dshHome: string,
  rootPackage: { name: string, version: string },
  dshVersion: string,
  cacheHome: string,
  profileResolvedPeerContracts?: readonly ObservedPeerContract[],
): Promise<Pick<DshInstallObservationReport['resolution'], 'runtimeGraph' | 'runtimeGraphError'>> {
  try {
    const dshRuntime = await discoverExactDshRuntime(cacheHome, dshVersion)
    const graph = await parseInstalledNodeModulesGraph(
      join(dshHome, 'profiles', PROFILE),
      rootPackage,
      {
        hostNodeModulesDirectory: dshRuntime.nodeModulesDirectory,
        hostRuntimeSource: 'dsh-process',
        hostRuntimePackage: dshRuntime.package,
        hostRuntimePackageDirectory: dshRuntime.packageDirectory,
      },
    )
    if (graph.digest === undefined) return {}
    const gaps = graphGapPartitions(graph)
    const contracts = profileResolvedPeerContracts ?? graph.rootPeerContracts?.map(contract => ({
      ...contract,
      staticUsage: 'scan-incomplete' as const,
    }))
    const concretelyResolvedRootPeers = new Set((contracts ?? [])
      .filter(contract => contract.status === 'satisfied' || contract.status === 'mismatched')
      .map(contract => contract.name))
    const effectiveRequiredGaps = gaps.required.filter(gap => !(
      gap.from === graph.rootNodeId
      && gap.kind === 'peer'
      && concretelyResolvedRootPeers.has(gap.name)
    ))
    const requiredGaps = graphGaps({ unresolved: effectiveRequiredGaps })
    const optionalGaps = graphGaps({ unresolved: gaps.optional })
    return {
      runtimeGraph: {
        digest: graph.digest,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        unresolved: effectiveRequiredGaps.length,
        ...(requiredGaps === undefined ? {} : { unresolvedDependencies: requiredGaps }),
        ...(gaps.optional.length === 0 ? {} : {
          optionalUnavailable: gaps.optional.length,
          ...(optionalGaps === undefined ? {} : { optionalUnavailableDependencies: optionalGaps }),
        }),
        pluginPeerContracts: pluginPeerContractEvidence(contracts),
        ...(graph.hostRuntime === undefined ? {} : {
          hostRuntime: {
            source: graph.hostRuntime.source,
            resolvedNodes: graph.hostRuntime.resolvedNodes,
            ...(graph.hostRuntime.package === undefined ? {} : { dshVersion: graph.hostRuntime.package.version }),
          },
        }),
      },
    }
  } catch (error: unknown) {
    return {
      runtimeGraphError: bounded(error instanceof Error ? error.message : String(error), 512),
    }
  }
}

async function resolutionEvidence(
  dshHome: string,
  rootPackage: { name: string, version: string },
  dshVersion: string,
  cacheHome: string,
  profileResolvedPeerContracts?: readonly ObservedPeerContract[],
): Promise<DshInstallObservationReport['resolution']> {
  const [profile, runtime] = await Promise.all([
    profileResolutionEvidence(dshHome),
    runtimeGraphEvidence(dshHome, rootPackage, dshVersion, cacheHome, profileResolvedPeerContracts),
  ])
  return { ...profile, ...runtime }
}

function finishReport(report: DshInstallObservationReport, result: DshInstallObservationResult, reason: string): DshInstallObservationReport {
  report.completedAt = new Date().toISOString()
  report.result = result
  report.reason = reason
  return report
}

/**
 * A load success is necessary but not enough for the compatibility claim. The
 * final verdict also requires a complete required-edge graph and a direct
 * plugin peer contract that the observer could actually evaluate.
 */
function finalCompatibilityConclusion(
  resolution: DshInstallObservationReport['resolution'],
): { result: DshInstallObservationResult, reason: string } {
  const graph = resolution.runtimeGraph
  if (graph === undefined) {
    return {
      result: 'unknown',
      reason: resolution.runtimeGraphError === undefined
        ? 'the exact artifact installed and loaded, but the effective DSH runtime graph was not established'
        : `the exact artifact installed and loaded, but the effective DSH runtime graph could not be established: ${resolution.runtimeGraphError}`,
    }
  }
  const contracts = graph.pluginPeerContracts
  const firstIssue = contracts.issues?.[0]
  if (contracts.mismatched > 0 || contracts.missing > 0) {
    const detail = firstIssue === undefined
      ? `${contracts.mismatched + contracts.missing} required plugin peer contract(s) do not match the DSH runtime`
      : firstIssue.status === 'missing'
        ? `${firstIssue.name}@${firstIssue.required} was not resolved by the DSH runtime (${firstIssue.staticUsage})`
        : `${firstIssue.name}@${firstIssue.resolvedVersion ?? 'unknown'} does not satisfy ${firstIssue.required} (${firstIssue.staticUsage})`
    return {
      result: 'peer-contract-incompatible',
      reason: `the exact artifact installed and loaded, but ${detail}`,
    }
  }
  if (graph.unresolved > 0) {
    return {
      result: 'unknown',
      reason: `the exact artifact installed and loaded, but the effective DSH runtime graph has ${graph.unresolved} required unresolved edge(s)`,
    }
  }
  if (contracts.indeterminate > 0) {
    return {
      result: 'unknown',
      reason: `the exact artifact installed and loaded, but ${contracts.indeterminate} required plugin peer range(s) could not be evaluated safely`,
    }
  }
  return {
    result: 'compatible',
    reason: 'the exact artifact installed, registered, loaded, and satisfied its direct peer contracts under the requested DSH version',
  }
}

export async function observeDshPluginInstall(options: DshInstallObservationOptions): Promise<DshInstallObservationReport> {
  const spec = parseNpmSpec(options.packageSpec)
  if (!EXACT_VERSION.test(options.dshVersion)) throw new Error('DSH version must be an exact semantic version')
  if (options.caseId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.caseId)) {
    throw new Error('DSH install observation caseId must be a short lowercase label')
  }
  const allowedBuilds = normalizeAllowedBuilds(options.allowedBuilds)
  if (!options.allowExecution) throw new Error('DSH install observation requires explicit execution consent')
  if (!['github-actions-hosted-runner', 'firecracker', 'other'].includes(options.isolationProvider)) {
    throw new Error('unsupported isolation provider')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error('DSH install observation timeout must be between 30000 and 600000 milliseconds')
  }
  if (options.runner === undefined) {
    if (process.platform !== 'linux') throw new Error('DSH install observation requires Linux strace')
    const declaration = options.hostEnvironment?.UPSTREAM_RADAR_ISOLATED_RUNNER ?? process.env.UPSTREAM_RADAR_ISOLATED_RUNNER
    if (declaration !== '1') throw new Error('DSH install observation requires UPSTREAM_RADAR_ISOLATED_RUNNER=1')
  }

  const startedAt = new Date().toISOString()
  const report: DshInstallObservationReport = {
    schema: DSH_INSTALL_OBSERVATION_SCHEMA,
    tool: { name: 'upstream-radar', version: TOOL_VERSION },
    probe: 'dsh-install',
    scope: 'install-and-load-behavior',
    startedAt,
    completedAt: startedAt,
    ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
    dshVersion: options.dshVersion,
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version.replace(/^v/, ''),
      packageManager: { name: 'pnpm' },
    },
    artifact: {
      spec: spec.canonical,
      name: spec.name,
      version: spec.version,
      lifecycleScripts: [],
    },
    stages: {
      runtime: { status: 'skipped' },
      artifact: { status: 'skipped' },
      profile: { status: 'skipped' },
      install: { status: 'skipped' },
      registration: { status: 'skipped' },
      load: { status: 'skipped' },
    },
    observations: { install: emptyTraceObservation(), load: emptyTraceObservation() },
    filesystem: { install: emptyFilesystemDiff(), load: emptyFilesystemDiff() },
    resolution: {},
    result: 'unknown',
    reason: 'observation did not complete',
    boundary: {
      isolationProviderClaim: options.isolationProvider,
      isolationVerifiedByRadar: false,
      disposableEnvironmentRequired: true,
      lifecycleScriptsEnabledForPluginInstall: true,
      pluginCodeMayExecuteDuringLoad: true,
      inheritedHostSecrets: false,
      approvedDependencyBuilds: allowedBuilds,
      requiredDependencyBuilds: [],
      note: 'Radar scrubs the child environment and records Linux system-call evidence, but the caller provides and must verify the disposable isolation boundary. Same-container traces are best-effort evidence, not a malicious-code safety certificate.',
    },
  }

  const sandboxRoot = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-install-'))
  const artifactDirectory = join(sandboxRoot, 'artifact')
  const traceDirectory = join(sandboxRoot, 'trace')
  const hostEnvironment = options.hostEnvironment ?? process.env
  const environment = controlledEnvironment(sandboxRoot, hostEnvironment)
  const noScriptsEnvironment = scriptPolicy(environment, false)
  const scriptsEnvironment = scriptPolicy(environment, true)
  const runner = options.runner ?? defaultCommandRunner
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  try {
    await Promise.all([
      mkdir(artifactDirectory, { recursive: true, mode: 0o700 }),
      mkdir(traceDirectory, { recursive: true, mode: 0o700 }),
      mkdir(environment.HOME as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.DSH_HOME as string, { recursive: true, mode: 0o700 }),
      mkdir(environment.TMPDIR as string, { recursive: true, mode: 0o700 }),
    ])
    await Promise.all([
      writeFile(join(sandboxRoot, 'controlled.npmrc'), 'registry=https://registry.npmjs.org/\naudit=false\nfund=false\nupdate-notifier=false\n', { mode: 0o600 }),
      writeFile(join(sandboxRoot, 'controlled-global.npmrc'), '', { mode: 0o600 }),
      writeFile(join(sandboxRoot, 'controlled.gitconfig'), '', { mode: 0o600 }),
    ])

    const runtimeResult = await runSafely(runner, {
      phase: 'runtime',
      command: pnpmCommand,
      args: ['--version'],
      cwd: sandboxRoot,
      env: noScriptsEnvironment,
      timeoutMs,
      sandboxRoot,
    })
    report.stages.runtime = commandStage(runtimeResult)
    const packageManagerVersion = runtimeResult.stdout.trim()
    if (report.stages.runtime.status !== 'passed' || !EXACT_VERSION.test(packageManagerVersion)) {
      report.stages.runtime = {
        ...report.stages.runtime,
        status: 'failed',
        detail: report.stages.runtime.detail ?? 'pnpm did not return one exact semantic version',
      }
      return finishReport(report, 'unknown', 'the package-manager runtime could not be established before execution')
    }
    report.runtime.packageManager.version = packageManagerVersion

    const artifactResult = await runSafely(runner, {
      phase: 'artifact',
      command: npmCommand,
      args: ['pack', `${spec.name}@${spec.version}`, '--ignore-scripts', '--pack-destination', '.', '--silent'],
      cwd: artifactDirectory,
      env: noScriptsEnvironment,
      timeoutMs,
      sandboxRoot,
    })
    let artifact: ParsedArtifact
    try {
      artifact = await parsePackedArtifact(artifactResult, artifactDirectory, spec.name, spec.version)
    } catch (error: unknown) {
      report.stages.artifact = {
        ...commandStage(artifactResult),
        status: 'failed',
        detail: bounded(error instanceof Error ? error.message : String(error)),
      }
      return finishReport(report, 'unknown', 'the exact npm artifact could not be established before execution')
    }
    report.artifact = {
      ...report.artifact,
      sha256: artifact.sha256,
      ...(artifact.integrity === undefined ? {} : { integrity: artifact.integrity }),
      bytes: artifact.bytes,
      bundlePatch: artifact.bundlePatch,
      ...(artifact.nodeEngine === undefined ? {} : { nodeEngine: artifact.nodeEngine }),
      lifecycleScripts: artifact.lifecycleScripts,
    }
    report.stages.artifact = { status: 'passed', code: artifactResult.code }

    if (artifact.nodeEngine !== undefined) {
      const runtimeMatches = satisfiesSemverRange(report.runtime.nodeVersion, artifact.nodeEngine)
      if (runtimeMatches === false) {
        return finishReport(
          report,
          'runtime-incompatible',
          `the plugin declares Node ${artifact.nodeEngine}, but the isolated runtime is Node ${report.runtime.nodeVersion}`,
        )
      }
      if (runtimeMatches === undefined) {
        return finishReport(
          report,
          'unknown',
          `the observer could not safely evaluate the plugin Node requirement ${artifact.nodeEngine}`,
        )
      }
    }

    try {
      const profileResult = await runSafely(runner, {
        phase: 'profile',
        command: pnpmCommand,
        args: dshArgs(options.dshVersion, ['--profile', PROFILE, '--help']),
        cwd: artifactDirectory,
        env: noScriptsEnvironment,
        timeoutMs,
        sandboxRoot,
      })
      report.stages.profile = commandStage(profileResult)
      if (report.stages.profile.status !== 'passed') {
        return finishReport(report, 'unknown', 'the exact DSH runtime could not initialize the disposable profile')
      }

      const beforeInstall = await snapshotSandbox(sandboxRoot, environment)
      const installTracePath = join(traceDirectory, 'install.strace')
      const installResult = await runSafely(runner, {
        phase: 'install',
        command: pnpmCommand,
        args: dshArgs(options.dshVersion, [
          'plugin', '--profile', PROFILE, 'add', join(artifactDirectory, artifact.filename),
          ...allowedBuilds.map(name => `--allow-build=${name}`),
        ]),
        cwd: artifactDirectory,
        env: scriptsEnvironment,
        timeoutMs,
        sandboxRoot,
        tracePath: installTracePath,
      })
      const afterInstall = await snapshotSandbox(sandboxRoot, environment)
      report.observations.install = await readTrace(installTracePath, sandboxRoot)
      report.filesystem.install = diffSnapshots(beforeInstall, afterInstall)
      report.resolution = await resolutionEvidence(environment.DSH_HOME as string, spec, options.dshVersion, environment.XDG_CACHE_HOME as string)
      report.stages.install = commandStage(installResult)
      if (installResult.timedOut || installResult.outputExceeded || installResult.launchError !== undefined) {
        return finishReport(report, 'unknown', 'the plugin install did not produce a bounded command result')
      }
      if (report.observations.install.coverage.status === 'missing') {
        report.stages.install = {
          ...report.stages.install,
          status: 'failed',
          detail: 'install trace evidence is missing',
        }
        return finishReport(report, 'unknown', 'the install command ran without readable trace evidence')
      }
      if (installResult.code !== 0) {
        const requiredBuilds = requiredDependencyBuilds(`${installResult.stderr}\n${installResult.stdout}`, spec.name)
        if (requiredBuilds.length > 0) {
          report.boundary.requiredDependencyBuilds = requiredBuilds
          return finishReport(
            report,
            'build-approval-required',
            `the DSH plugin install requires explicit approval for dependency builds: ${requiredBuilds.join(', ')}`,
          )
        }
        return finishReport(report, 'install-failed', 'the traced DSH plugin install command failed')
      }

      const registered = await registeredBundle(environment.DSH_HOME as string, spec.name)
      report.stages.registration = registered
        ? { status: 'passed' }
        : { status: 'failed', detail: `the DSH profile did not register ${spec.name}` }
      if (!registered) return finishReport(report, 'install-failed', 'DSH accepted the install command but did not register the plugin bundle')

      const loadProbe = await writeProfileLoadProbe(
        environment.DSH_HOME as string,
        options.dshVersion,
        pnpmCommand,
        artifact.requiredPeerDependencies,
      )
      const loadTracePath = join(traceDirectory, 'load.strace')
      const loadResult = await runSafely(runner, {
        phase: 'load',
        command: process.execPath,
        args: [loadProbe.path],
        cwd: loadProbe.profileDirectory,
        env: scriptsEnvironment,
        timeoutMs,
        sandboxRoot,
        tracePath: loadTracePath,
      })
      const afterLoad = await snapshotSandbox(sandboxRoot, environment)
      report.observations.load = await readTrace(loadTracePath, sandboxRoot)
      report.filesystem.load = diffSnapshots(afterInstall, afterLoad)
      const profilePeerContracts = await readProfilePeerContracts(
        loadProbe.peerResolutionPath,
        artifact.requiredPeerDependencies,
        sandboxRoot,
      )
      // Loading may trigger one final DSH profile reconciliation. Preserve the
      // final resolved graph rather than only the state immediately after add.
      report.resolution = await resolutionEvidence(
        environment.DSH_HOME as string,
        spec,
        options.dshVersion,
        environment.XDG_CACHE_HOME as string,
        profilePeerContracts,
      )
      report.stages.load = commandStage(loadResult)
      if (loadResult.timedOut || loadResult.outputExceeded || loadResult.launchError !== undefined) {
        return finishReport(report, 'unknown', 'the plugin load did not produce a bounded command result')
      }
      if (report.observations.load.coverage.status === 'missing') {
        report.stages.load = { ...report.stages.load, status: 'failed', detail: 'load trace evidence is missing' }
        return finishReport(report, 'unknown', 'the load command ran without readable trace evidence')
      }
      if (loadResult.code !== 0) return finishReport(report, 'load-failed', 'the traced DSH profile load command failed')
      const conclusion = finalCompatibilityConclusion(report.resolution)
      return finishReport(report, conclusion.result, conclusion.reason)
    } catch (error: unknown) {
      const detail = bounded(error instanceof Error ? error.message : String(error))
      const currentStage = (['runtime', 'profile', 'install', 'registration', 'load'] as const)
        .find(name => report.stages[name].status === 'skipped')
      if (currentStage !== undefined) report.stages[currentStage] = { status: 'failed', detail }
      return finishReport(report, 'unknown', `the bounded observer failed while collecting ${currentStage ?? 'runtime'} evidence`)
    }
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
}

export function renderDshInstallObservation(report: DshInstallObservationReport): string {
  const install = report.observations.install
  const load = report.observations.load
  const lifecycle = report.artifact.lifecycleScripts.length === 0 ? 'none' : report.artifact.lifecycleScripts.join(', ')
  const lines = [
    'DSH isolated install observation',
    ...(report.caseId === undefined ? [] : [`Case: ${report.caseId}`]),
    `Artifact: ${report.artifact.name}@${report.artifact.version}${report.artifact.sha256 === undefined ? '' : ` (sha256:${report.artifact.sha256.slice(0, 12)}…)`}`,
    `DSH: ${report.dshVersion}`,
    `Runtime: Node ${report.runtime.nodeVersion} (${report.runtime.platform}/${report.runtime.architecture}), pnpm ${report.runtime.packageManager.version ?? 'unknown'}`,
    `Plugin Node requirement: ${report.artifact.nodeEngine ?? 'not declared'}`,
    `Isolation claim: ${report.boundary.isolationProviderClaim} (provided externally; not verified by Radar)`,
    `Approved dependency builds: ${report.boundary.approvedDependencyBuilds.length === 0 ? 'none' : report.boundary.approvedDependencyBuilds.join(', ')}`,
    `Additional dependency builds required: ${report.boundary.requiredDependencyBuilds.length === 0 ? 'none' : report.boundary.requiredDependencyBuilds.join(', ')}`,
    '',
    `Result: ${report.result.toUpperCase()} — ${report.reason}`,
    `Lifecycle scripts declared: ${lifecycle}`,
    `Install evidence: ${install.processes.length} process, ${install.network.length} network, ${install.fileWrites.length} file-write event(s); trace ${install.coverage.status}`,
    `Load evidence: ${load.processes.length} process, ${load.network.length} network, ${load.fileWrites.length} file-write event(s); trace ${load.coverage.status}`,
    `Final filesystem delta: install +${report.filesystem.install.totals.created} ~${report.filesystem.install.totals.modified} -${report.filesystem.install.totals.deleted}; load +${report.filesystem.load.totals.created} ~${report.filesystem.load.totals.modified} -${report.filesystem.load.totals.deleted}`,
    `Resolved profile graph: ${report.resolution.profileLockfile?.graphDigest ?? 'not established'}${report.resolution.profileLockfile === undefined ? '' : ` (lock sha256:${report.resolution.profileLockfile.sha256.slice(0, 12)}…)`}`,
    `Effective DSH runtime graph: ${report.resolution.runtimeGraph?.digest ?? 'not established'}${report.resolution.runtimeGraph === undefined ? '' : ` (${report.resolution.runtimeGraph.nodes} nodes, ${report.resolution.runtimeGraph.edges} edges, ${report.resolution.runtimeGraph.unresolved} required unresolved${report.resolution.runtimeGraph.optionalUnavailable === undefined ? '' : `, ${report.resolution.runtimeGraph.optionalUnavailable} optional unavailable`})`}`,
    `Plugin peer contracts: ${report.resolution.runtimeGraph === undefined
      ? 'not established'
      : `${report.resolution.runtimeGraph.pluginPeerContracts.satisfied}/${report.resolution.runtimeGraph.pluginPeerContracts.declared} satisfied; ${report.resolution.runtimeGraph.pluginPeerContracts.mismatched} mismatched, ${report.resolution.runtimeGraph.pluginPeerContracts.missing} missing, ${report.resolution.runtimeGraph.pluginPeerContracts.indeterminate} indeterminate`}`,
    `Effective graph collector: ${report.resolution.runtimeGraphError ?? 'captured'}`,
    '',
  ]
  for (const [name, stage] of Object.entries(report.stages)) {
    lines.push(`  ${name}: ${stage.status}${stage.detail === undefined ? '' : ` (${stage.detail})`}`)
  }
  const peerIssues = report.resolution.runtimeGraph?.pluginPeerContracts.issues ?? []
  if (peerIssues.length > 0) {
    lines.push('', 'Direct peer-contract findings:')
    for (const issue of peerIssues) {
      lines.push(`  ${issue.name}: ${issue.status}; requires ${issue.required}${issue.resolvedVersion === undefined ? '' : `, resolved ${issue.resolvedVersion}`}; static use ${issue.staticUsage}`)
    }
  }
  lines.push('', report.boundary.note)
  return `${lines.join('\n')}\n`
}
