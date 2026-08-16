#!/usr/bin/env node

import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { renderCompatibilityBenchmark, runCompatibilityBenchmark } from './compatibility-benchmark.js'
import { assessCompatibilityChange } from './compatibility.js'
import { probeDshLoad, probeDshLoadMatrix, renderDshLoadMatrix, renderDshLoadProbe } from './dsh-probe.js'
import { createAnalysisTask, renderAgentAnalysisPrompt } from './dsh-analysis.js'
import { createDoctorReport, renderDoctorReport } from './doctor.js'
import { createDemoReport, renderDemo } from './demo.js'
import { GitHubReleaseClient } from './github-release.js'
import { parseNpmLockGraph, parsePnpmLockGraph } from './graph.js'
import { createRadarConfigFromDshProfile, createRadarConfigFromNpmLock, createRadarConfigFromPnpmLock, discoverDshProfiles, refreshRadarConfigFromConfiguredProfile, resolveDshProfileDirectory, writeDshPatch, writeRadarConfig } from './init.js'
import { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
import { inspectNpmPackage } from './npm.js'
import { NpmCandidateGraphClient } from './npm-candidate.js'
import { NpmReleaseClient } from './npm-release.js'
import { createNotificationPolicyMap, filterNotifiableRadarEvents } from './notification-policy.js'
import { OsvClient } from './osv.js'
import { verdictAtLeast } from './policy.js'
import { createQuickstartReport, renderQuickstartReport } from './quickstart.js'
import { GitHubAdvisoryClient } from './github-advisory.js'
import { emptyRadarState, pollRadar } from './radar.js'
import {
  evaluateRadarPolicy,
  RADAR_COMPATIBILITY_FAIL_THRESHOLDS,
  RADAR_FAIL_THRESHOLDS,
  renderRadarPolicy,
  type RadarCompatibilityFailThreshold,
  type RadarFailThreshold,
} from './radar-policy.js'
import { renderRadarEvents } from './radar-render.js'
import { createRadarHistory, renderRadarHistory } from './radar-history.js'
import { loadRadarState, saveRadarState } from './radar-state.js'
import { createRadarNext, createRadarStatus, renderRadarNext, renderRadarStatus } from './radar-status.js'
import { renderTextReport } from './render.js'
import { scanDirectory } from './scan.js'
import { CisaKevClient, EpssClient } from './threat-intel.js'
import type { Verdict } from './types.js'
import type {
  RadarEvent,
  RadarIncidentTriage,
  RadarIncidentTriageStatus,
  RadarNotificationPolicy,
  RadarSeverity,
  RadarState,
} from './radar-types.js'
import { TOOL_VERSION } from './version.js'
import {
  markRadarWebhookEventsDelivered,
  normalizeRadarWebhookUrl,
  queueRadarWebhookEvents,
  radarWebhookEndpointHash,
  sendRadarWebhook,
  undeliveredRadarWebhookEvents,
} from './webhook.js'

const VALID_THRESHOLDS = new Set<Verdict | 'never'>(['warn', 'review', 'block', 'never'])
const VALID_RADAR_THRESHOLDS = new Set<RadarFailThreshold>(RADAR_FAIL_THRESHOLDS)
const VALID_RADAR_COMPATIBILITY_THRESHOLDS = new Set<RadarCompatibilityFailThreshold>(RADAR_COMPATIBILITY_FAIL_THRESHOLDS)
const VALID_NOTIFICATION_SEVERITIES = new Set<Exclude<RadarSeverity, 'unknown'>>(['info', 'low', 'medium', 'high', 'critical'])

function safeErrorMessage(value: string, maxLength = 2_048): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  )).slice(0, maxLength)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function parseNotificationPolicyArguments(
  minimumSeverity: string | undefined,
  quietHoursValue: string | undefined,
): RadarNotificationPolicy | undefined {
  if (minimumSeverity === undefined && quietHoursValue === undefined) return undefined
  if (minimumSeverity !== undefined && !VALID_NOTIFICATION_SEVERITIES.has(minimumSeverity as Exclude<RadarSeverity, 'unknown'>)) {
    throw new Error('--minimum-severity must be info, low, medium, high or critical')
  }
  let quietHours: RadarNotificationPolicy['quietHours'] | undefined
  if (quietHoursValue !== undefined) {
    const comma = quietHoursValue.indexOf(',')
    const interval = comma < 0 ? '' : quietHoursValue.slice(comma + 1)
    const dash = interval.indexOf('-')
    const timezone = comma < 1 ? '' : quietHoursValue.slice(0, comma)
    const start = dash < 1 ? '' : interval.slice(0, dash)
    const end = dash < 0 ? '' : interval.slice(dash + 1)
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end)
      || start === end
      || timezone.length === 0) {
      throw new Error('--quiet-hours must use <IANA timezone>,<HH:MM>-<HH:MM> with different start and end times')
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    } catch {
      throw new Error('--quiet-hours must start with a valid IANA timezone')
    }
    quietHours = { timezone, start, end }
  }
  return {
    ...(minimumSeverity === undefined ? {} : { minimumSeverity: minimumSeverity as Exclude<RadarSeverity, 'unknown'> }),
    ...(quietHours === undefined ? {} : { quietHours }),
  }
}

function commandUsage(key: string): string | undefined {
  const help: Record<string, string> = {
    setup: `Upstream Radar — install the exact Radar bundle into DSH and prepare monitoring

Usage:
  upstream-radar setup [--profile <name>] [--start] [--project-name <name>]

What it does:
  Installs Radar into the selected DSH profile, writes a reviewable config and
  --patch overlay, then runs the local doctor check. By default it does not
  start DSH or execute plugin business actions; --start opts into launching DSH
  only after the doctor check passes.

Prerequisite:
  Install DeepSeek Harness first and verify that \`dsh --help\` works.

Common options:
  --profile <name>       select a DSH profile (auto-selects the only candidate)
  --project-name <name>  name shown in incidents and Agent tasks
  --workspace <path>     project workspace used to route Agent follow-up
  --repository <url>     repository evidence passed to the Agent task
  --output <path>        Radar config path (default: ./upstream-radar.config.json)
  --dsh-patch <path>     DSH overlay path (default: ./upstream-radar.dsh.yml)
  --minimum-severity <level>  minimum vulnerability notice level
  --quiet-hours <tz,start-end>  e.g. Asia/Shanghai,22:00-08:00
  --start                 start DSH after the local wiring check passes
  --no-install            reuse an already installed Radar bundle
  --no-dsh-patch          use legacy environment-variable wiring

Notification controls:
  Add an optional \`notificationPolicy\` block to a generated projects[] entry
  to set \`minimumSeverity\` and timezone-aware \`quietHours\`. This changes only
  delivery; active evidence and queued tasks remain durable.

  Next:
  Review the generated files, then run the printed doctor command and start DSH
  with the printed --patch command. Pass --start only when you explicitly accept
  starting DSH in the same invocation after the doctor check passes.

If the profile has no third-party plugin yet:
  dsh plugin --profile <name> add <package>@<exact-version>
`,
    init: `Upstream Radar — create a reviewable inventory

Usage:
  upstream-radar init --profile <name> [options]
  upstream-radar init --pnpm-lock <pnpm-lock.yaml> [options]
  upstream-radar init --npm-lock <package-lock.json> [options]

What it does:
  Reads a DSH profile or lockfile without executing plugin code. Lockfile mode
  is the pre-install path; it writes a static graph for a later frozen check.

Common options:
  --root <package>@<exact-version>  explicit lockfile root when it cannot be inferred
  --project-name <name>             name shown in incidents
  --output <path>                   config path (default: ./upstream-radar.config.json)
  --dsh-patch <path>                write a self-contained DSH overlay (profile mode)
  --minimum-severity <level>        minimum vulnerability notice level
  --quiet-hours <tz,start-end>      e.g. Asia/Shanghai,22:00-08:00
  --json                            print a compact machine-readable summary
  --force                           replace an existing output file

Notification controls:
  Add an optional \`notificationPolicy\` block to a generated projects[] entry
  to set \`minimumSeverity\` and timezone-aware \`quietHours\`. This changes only
  delivery; active evidence and queued tasks remain durable.

Next:
  upstream-radar radar check ./upstream-radar.config.json --frozen
`,
    doctor: `Upstream Radar — verify local wiring without polling upstream sources

Usage:
  upstream-radar doctor [config.json] [--profile <name>] [--patch <path>] [--json]

Checks:
  config/state readability, Radar registration in DSH, overlay alignment,
  dependency coverage, and local webhook configuration. It does not contact
  OSV, npm, GitHub, DSH, or a model.
`,
    scan: `Upstream Radar — inspect a local package directory without running it

Usage:
  upstream-radar scan <directory> [--json] [--fail-on <warn|review|block|never>]

Use this for an unpacked plugin before installation. Lifecycle scripts, remote
shell patterns, unsafe symlinks, mutable dependencies, and DSH bundle metadata
are recorded as bounded evidence.
`,
    inspect: `Upstream Radar — inspect one exact npm artifact before installation

Usage:
  upstream-radar inspect npm:<package>@<exact-version> [--deep] [--json]
    [--registry <https-url>] [--fail-on <warn|review|block|never>]

--deep downloads the exact tarball, verifies npm integrity/signatures and
provenance when available, resolves the dependency graph with scripts disabled,
and queries the implemented vulnerability checks. An empty finding list is not
a safety certificate; check the coverage verdict before admitting the package.
The default gate exits 2 for review or block; use --fail-on block when review
should remain visible without failing CI.
`,
    graph: `Upstream Radar — read a lockfile into the canonical dependency graph

Usage:
  upstream-radar graph pnpm-lock <pnpm-lock.yaml> [--root <package>@<exact-version>] [--json]
  upstream-radar graph npm-lock <package-lock.json> [--root <package>@<exact-version>] [--json]

This command is offline and does not install packages, run lifecycle scripts,
load plugin code, or query vulnerability sources.
`,
    probe: `Upstream Radar — test whether a DSH bundle loads in disposable profiles

Usage:
  upstream-radar probe dsh-load <package.tgz> [--dsh-version <exact-version>] [--json]
  upstream-radar probe dsh-matrix <package.tgz> --dsh-version <v1>,<v2>,... [--json]

The probe is bounded and isolated. It is a compatibility/load check, not a
semantic safety review or a substitute for dependency monitoring.
`,
    demo: `Upstream Radar — show the exact-path-to-DSH handoff without side effects

Usage:
  upstream-radar demo [--json]

The demo is network-free and uses only a local fixture. It does not inspect your
repository, install a plugin, start DSH, or claim that its advisory is real.
`,
    quickstart: `Upstream Radar — choose the smallest honest first-use path

Usage:
  upstream-radar quickstart [directory] [--json]

What it does:
  Inspects only the selected directory and local DSH profile metadata. It finds
  an existing Radar config, one supported lockfile, or eligible DSH profiles,
  then prints the next commands in the right order.

Safety:
  This command never installs packages, starts DSH, queries vulnerability
  sources, or executes plugin code. It does not choose between two lockfiles or
  multiple DSH profiles on your behalf.
`,
    benchmark: `Upstream Radar — run offline compatibility-rule contracts

Usage:
  upstream-radar benchmark compatibility [--json]
`,
    radar: `Upstream Radar — monitor a reviewed inventory

Usage:
  upstream-radar radar check <config.json> [options]
  upstream-radar radar watch <config.json> [options]
  upstream-radar radar status <config.json> [options]
  upstream-radar radar history <config.json> [options]
  upstream-radar radar compare <config.json> <before.json> <candidate.json> [options]

Use 'radar status' and 'radar history' for local, no-network diagnosis. Use
--frozen for CI or any run that must not read a live DSH profile.
`,
    'radar check': `Upstream Radar — run one vulnerability and compatibility check

Usage:
  upstream-radar radar check <config.json> [--state <state.json>] [--frozen]
    [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>]
    [--webhook <https-url>] [--threat-intel] [--json]

One cycle queries the configured sources and persists changed incidents. Use
--frozen when the config is the reviewed graph you want to enforce.

--threat-intel adds CISA KEV and FIRST EPSS prioritization signals for matched
CVEs. It is opt-in here; the native DSH bundle enables it by default.
`,
    'radar watch': `Upstream Radar — keep monitoring a reviewed inventory

Usage:
  upstream-radar radar watch <config.json> [--interval <seconds>] [--once]
    [--state <state.json>] [--frozen] [--fail-on <severity>]
    [--fail-on-compatibility <never|breaking|any>] [--webhook <https-url>]
    [--threat-intel]

Use --once in CI. A long-running watch keeps polling and should not be given a
policy gate that would make it exit on the first incident.
`,
    'radar status': `Upstream Radar — see the local monitoring snapshot

Usage:
  upstream-radar radar status <config.json> [--state <state.json>]
    [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]

This command never polls OSV, npm, GitHub, or DSH. It shows whether monitoring
has run, coverage, active incidents, queued Agent tasks, and the next useful
action.
`,
    'radar next': `Upstream Radar — show the one next action for the highest-priority incident

Usage:
  upstream-radar radar next <config.json> [--state <state.json>] [--json]

This command is read-only and does not poll upstream sources. It selects the
same first incident as 'radar status', then points to the pending DSH task,
verified analysis, or the next check command.
`,
    'radar history': `Upstream Radar — inspect the durable transition ledger

Usage:
  upstream-radar radar history <config.json> [--state <state.json>] [--limit <n>] [--json]

This command is local-only and shows new, updated, resolved, and source-health
transitions, including their exact affected paths.
`,
    'radar compare': `Upstream Radar — compare one reviewed release candidate

Usage:
  upstream-radar radar compare <config.json> <before.json> <candidate.json>
    [--notes <release-notes.txt>] [--json]

The release notes are treated as untrusted evidence. This command does not
install or execute the candidate.
`,
    task: `Upstream Radar — inspect or acknowledge the DSH analysis outbox

Usage:
  upstream-radar task list <state.json> [--json]
  upstream-radar task show <state.json> [task-id] [--json]
  upstream-radar task ack <state.json> <task-id>
`,
    analysis: `Upstream Radar — inspect verified DSH conclusions

Usage:
  upstream-radar analysis list <state.json> [--json]
  upstream-radar analysis show <state.json> [incident-id] [--json]
`,
    mute: `Upstream Radar — pause delivery for one exact incident until a fixed expiry

Usage:
  upstream-radar mute <state.json> <incident-id> --until <ISO-8601> [--force] [--json]

This pauses DSH and webhook delivery only. The active incident, dependency paths,
history, and status remain visible. The mute expires automatically. Critical and
malware incidents require --force.
`,
    unmute: `Upstream Radar — resume delivery for one incident immediately

Usage:
  upstream-radar unmute <state.json> <incident-id> [--json]
`,
    triage: `Upstream Radar — record human follow-up for one active incident

Usage:
  upstream-radar triage <state.json> <incident-id>
    --status <open|in-progress|blocked|accepted-risk>
    [--owner <name>] [--note <text>] [--json]

This records ownership and work context without resolving, hiding, or changing
the deterministic incident. A new event version requires a fresh follow-up.
Blocked and accepted-risk states require a note.
`,
  }
  return help[key]
}

function commandHelp(args: readonly string[]): string | undefined {
  const helpIndex = args.findIndex(argument => argument === '--help' || argument === '-h')
  if (helpIndex < 0) return undefined
  const command = args[0]
  if (command === undefined) return undefined
  const nested = command === 'radar' || command === 'task' || command === 'analysis'
    ? args[1]
    : undefined
  const key = nested === undefined ? command : `${command} ${nested}`
  return commandUsage(key) ?? commandUsage(command)
}

function usage(): string {
  return `Upstream Radar — always-on dependency and compatibility monitoring for DSH plugins

Usage:
  upstream-radar <command> --help
  upstream-radar setup [--profile <name>] [--start] [options]
  upstream-radar init [--profile <name>] [options]
  upstream-radar init --pnpm-lock <pnpm-lock.yaml> [--root <package>@<exact-version>] [options]
  upstream-radar init --npm-lock <package-lock.json> [--root <package>@<exact-version>] [options]
  upstream-radar doctor [config.json] [options]
  upstream-radar scan <directory> [--json] [--fail-on <warn|review|block|never>]
  upstream-radar inspect npm:<package>@<exact-version> [--deep] [--json] [--fail-on <warn|review|block|never>]
  upstream-radar graph <npm-lock|pnpm-lock> <lockfile> [--root <package>@<exact-version>] [--json]
  upstream-radar probe dsh-load <package.tgz> [--dsh-version <exact-version>] [--timeout <seconds>] [--keep-profile] [--json]
  upstream-radar probe dsh-matrix <package.tgz> --dsh-version <v1>[,<v2>,...] [--timeout <seconds>] [--keep-profile] [--json]
  upstream-radar demo [--json]
  upstream-radar quickstart [directory] [--json]
  upstream-radar benchmark compatibility [--json]
  upstream-radar radar check <config.json> [--state <state.json>] [--webhook <https-url>] [--threat-intel] [--frozen] [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]
  upstream-radar radar watch <config.json> [--state <state.json>] [--webhook <https-url>] [--threat-intel] [--interval <seconds>] [--once] [--frozen] [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]
  upstream-radar radar status <config.json> [--state <state.json>] [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]
  upstream-radar radar next <config.json> [--state <state.json>] [--json]
  upstream-radar radar history <config.json> [--state <state.json>] [--limit <n>] [--json]
  upstream-radar radar compare <config.json> <before.json> <candidate.json> [--notes <release-notes.txt>] [--json]
  upstream-radar task list <state.json> [--json]
  upstream-radar task show <state.json> [task-id] [--json]
  upstream-radar task ack <state.json> <task-id>
  upstream-radar analysis list <state.json> [--json]
  upstream-radar analysis show <state.json> [incident-id] [--json]
  upstream-radar mute <state.json> <incident-id> --until <ISO-8601> [--force] [--json]
  upstream-radar unmute <state.json> <incident-id> [--json]
  upstream-radar triage <state.json> <incident-id> --status <open|in-progress|blocked|accepted-risk> [--owner <name>] [--note <text>] [--json]
  upstream-radar version

Commands:
  setup    install the exact Radar bundle, generate DSH wiring, and run doctor
  init     discover third-party bundles in DSH or initialize a reviewable lockfile inventory
  doctor   check local Radar/DSH wiring without polling upstream sources
  scan     bounded, read-only inspection of a local package directory
  inspect  fetch and verify the exact npm artifact before inspecting its contents
  graph    read a lockfile into the canonical dependency graph without installing packages
  probe    run a bounded DSH bundle-load check or version matrix in disposable profiles
  demo     show the exact-path-to-DSH handoff without network, DSH, or plugin installation
  quickstart choose the smallest first-use path without changing the environment
  benchmark run offline compatibility-rule contracts without network or plugin execution
  radar    monitor vulnerability changes, watch continuously, find the next action, inspect status/history, or assess a candidate compatibility change
  task     inspect or acknowledge the durable DSH analysis outbox
  analysis inspect verified DSH conclusions stored in the Radar state
  mute     pause delivery for one incident with a bounded expiry
  unmute   resume delivery for one incident immediately
  triage   record owner, work status, and handoff note for one incident

Options:
  --deep               resolve the dependency graph with scripts disabled and ask npm to verify signatures/provenance
  --registry <url>     HTTPS npm registry for inspect or explicit public-graph init
  --no-deep-candidates skip bounded transitive dependency graph checks for upgrade candidates
  --state <path>       persistent radar state (default: <config.json>.state.json)
  --osv-base-url <url> alternate HTTPS OSV API base URL
  --no-github-advisories disable the independent GitHub Advisory Database check for radar check/watch
  --threat-intel      radar check/watch: add CISA KEV and FIRST EPSS signals for matched CVEs
  --webhook <https-url>  radar check/watch: POST changed events to an HTTPS endpoint
  --interval <seconds> watch interval from 300 to 86400 seconds (default: 1800)
  --limit <n>         radar history: show 1 to 1000 recent transitions (default: 20)
  --once               run one watch cycle and exit (useful for CI and demos)
  --frozen             radar check/watch: use the reviewed graph in config without reading a local DSH profile
  --fail-on <value>    scan/inspect verdict or radar severity: unknown|info|low|medium|high|critical|never
  --fail-on-compatibility <value>  CI gate: never|breaking|any (default: never)
  --notes <path>       release notes used as untrusted compatibility evidence
  --profile <name>     DSH profile for init or doctor (init auto-selects the only candidate when omitted)
  --npm-lock <path>    init: build a static inventory from an npm v2/v3 package-lock.json
  --pnpm-lock <path>   init: build a static inventory from a pnpm v6/v9 lockfile
  --root <coordinate>  init/graph lockfiles: override the root; otherwise read package.json beside the lockfile
  --no-install          setup: reuse an already installed upstream-radar bundle
  --output <path>      init output path (default: ./upstream-radar.config.json)
  --dsh-patch <path>   write a self-contained DSH --patch overlay (setup default: ./upstream-radar.dsh.yml)
  --minimum-severity <level>  init/setup notification threshold: info|low|medium|high|critical
  --quiet-hours <tz,start-end>  init/setup window, e.g. Asia/Shanghai,22:00-08:00
  --start              setup: start DSH after the local wiring check passes
  --no-dsh-patch       setup: keep the legacy UPSTREAM_RADAR_* environment-variable wiring
  --patch <path>       DSH overlay to verify with doctor
  --force              allow init to replace an existing output file
  --json               emit the canonical JSON report

Exit codes:
  0  completed without an operational error or configured policy match
  1  operational, source, or input error
  2  configured policy threshold was reached
`
}

function parseExactPackageCoordinate(value: string): { name: string; version: string } {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) throw new Error(`--root must be an exact package coordinate: ${value}`)
  const name = value.slice(0, at)
  const version = value.slice(at + 1)
  if (name.startsWith('@') && !name.includes('/')) throw new Error(`--root must include a scoped package name: ${value}`)
  return { name, version }
}

async function inferLockfileRoot(lockfile: string, kind: 'npm' | 'pnpm'): Promise<{ name: string; version: string }> {
  const manifestPath = join(dirname(resolve(lockfile)), 'package.json')
  try {
    const manifest = parsePackageManifestSnapshot(await readJson(manifestPath))
    return { name: manifest.name, version: manifest.version }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`could not infer the ${kind} lockfile root from ${manifestPath}; pass --root <package>@<exact-version>`)
    }
    throw error
  }
}

async function runGraph(args: readonly string[]): Promise<number> {
  const kind = args[0]
  if (kind !== 'npm-lock' && kind !== 'pnpm-lock') throw new Error('graph requires the npm-lock or pnpm-lock subcommand')
  const lockfile = args[1]
  if (lockfile === undefined || lockfile.startsWith('-')) throw new Error(`graph ${kind} requires a lockfile path`)
  let rootSpec: string | undefined
  let json = false
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--root') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--root requires a value')
      rootSpec = value
      index += 1
    } else {
      throw new Error(`unknown option for graph ${kind}: ${argument}`)
    }
  }
  const packageRoot = rootSpec === undefined
    ? await inferLockfileRoot(lockfile, kind === 'npm-lock' ? 'npm' : 'pnpm')
    : parseExactPackageCoordinate(rootSpec)
  const graph = kind === 'npm-lock'
    ? parseNpmLockGraph(await readJson(lockfile), packageRoot)
    : parsePnpmLockGraph(await readBoundedFile(lockfile, 16 * 1024 * 1024), packageRoot)
  if (json) {
    process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`)
    return 0
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const root = nodes.get(graph.rootNodeId)
  const display = (id: string): string => {
    const node = nodes.get(id)
    return node === undefined ? id : `${node.name}@${node.version}`
  }
  const unresolved = graph.unresolved ?? []
  process.stdout.write([
    `Dependency graph: ${root === undefined ? graph.rootNodeId : `${root.name}@${root.version}`}`,
    `Source: ${kind} (read-only; no install, no plugin execution)`,
    `Nodes: ${graph.nodes.length}`,
    `Edges: ${graph.edges.length}`,
    `Unresolved: ${unresolved.length}`,
    `Digest: ${graph.digest ?? '(none)'}`,
    '',
    'Edges:',
    ...(graph.edges.length === 0 ? ['  (none)'] : graph.edges.map(edge => `  ${display(edge.from)} -[${edge.kind}]-> ${display(edge.to)}`)),
    ...(unresolved.length === 0 ? [] : [
      '',
      'Unresolved dependencies:',
      ...unresolved.map(item => `  ${display(item.from)} -[${item.kind}]-> ${item.name} (${item.spec})`),
    ]),
  ].join('\n') + '\n')
  return 0
}

async function runTask(args: readonly string[]): Promise<number> {
  const subcommand = args[0]
  if (subcommand !== 'list' && subcommand !== 'show' && subcommand !== 'ack') {
    throw new Error('task requires list, show or ack')
  }
  const statePath = args[1]
  if (statePath === undefined || statePath.startsWith('-')) throw new Error(`task ${subcommand} requires a state file`)
  const positional: string[] = []
  let json = false
  for (const argument of args.slice(2)) {
    if (argument === '--json') json = true
    else if (argument.startsWith('-')) throw new Error(`unknown option for task ${subcommand}: ${argument}`)
    else positional.push(argument)
  }
  if (subcommand === 'list') {
    if (positional.length > 0) throw new Error('task list received unexpected arguments')
    const state = await loadRadarState(statePath)
    if (json) {
      process.stdout.write(`${JSON.stringify(state.pendingAnalysisTasks, null, 2)}\n`)
    } else if (state.pendingAnalysisTasks.length === 0) {
      process.stdout.write('No pending analysis tasks.\n')
    } else {
      process.stdout.write('ID\tKIND\tCHANGE\tPROJECT\tINCIDENT\n')
      for (const task of state.pendingAnalysisTasks) {
        process.stdout.write([
          safeErrorMessage(task.id),
          task.event.kind,
          task.event.change,
          safeErrorMessage(task.event.project.name),
          safeErrorMessage(task.event.incidentId),
        ].join('\t') + '\n')
      }
    }
    return 0
  }

  if (subcommand === 'show') {
    if (positional.length > 1) throw new Error('task show accepts at most one task id')
    const state = await loadRadarState(statePath)
    const requestedId = positional[0]
    const task = requestedId === undefined
      ? state.pendingAnalysisTasks[0]
      : state.pendingAnalysisTasks.find(item => item.id === requestedId)
    if (task === undefined) throw new Error(requestedId === undefined ? 'no pending analysis task' : `pending task not found: ${requestedId}`)
    process.stdout.write(json ? `${JSON.stringify(task, null, 2)}\n` : renderAgentAnalysisPrompt(task))
    return 0
  }

  if (json) throw new Error('task ack does not accept --json')
  if (positional.length !== 1) throw new Error('task ack requires one task id')
  const taskId = positional[0] ?? ''
  const state = await loadRadarState(statePath)
  const remaining = state.pendingAnalysisTasks.filter(task => task.id !== taskId)
  if (remaining.length === state.pendingAnalysisTasks.length) throw new Error(`pending task not found: ${taskId}`)
  await saveRadarState(statePath, { ...state, pendingAnalysisTasks: remaining })
  process.stdout.write(`Acknowledged ${safeErrorMessage(taskId)}.\n`)
  return 0
}

const MAX_INCIDENT_MUTE_MS = 30 * 24 * 60 * 60 * 1_000
const VALID_INCIDENT_TRIAGE_STATUSES = new Set<RadarIncidentTriageStatus>([
  'open',
  'in-progress',
  'blocked',
  'accepted-risk',
])

function activeEventForIncident(state: RadarState, incidentId: string): RadarEvent | undefined {
  return [
    ...Object.values(state.activeVulnerabilities),
    ...Object.values(state.activeCompatibility),
    ...Object.values(state.activeSourceHealth ?? {}),
  ].map(item => item.event).find(event => event.incidentId === incidentId)
}

async function runIncidentMute(args: readonly string[]): Promise<number> {
  const statePath = args[0]
  const incidentId = args[1]
  if (statePath === undefined || statePath.startsWith('-')) throw new Error('mute requires a state file')
  if (incidentId === undefined || incidentId.startsWith('-')) throw new Error('mute requires an incident id')
  let untilValue: string | undefined
  let force = false
  let json = false
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) throw new Error('mute received an incomplete option')
    if (argument === '--force') force = true
    else if (argument === '--json') json = true
    else if (argument === '--until') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--until requires a value')
      untilValue = value
      index += 1
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option for mute: ${argument}`)
    } else {
      throw new Error(`mute received unexpected argument: ${argument}`)
    }
  }
  if (untilValue === undefined) throw new Error('mute requires --until <ISO-8601>')
  const mutedUntilMs = Date.parse(untilValue)
  const nowMs = Date.now()
  if (!Number.isFinite(mutedUntilMs)) throw new Error('--until must be a valid ISO-8601 timestamp')
  if (mutedUntilMs <= nowMs) throw new Error('--until must be in the future')
  if (mutedUntilMs > nowMs + MAX_INCIDENT_MUTE_MS) throw new Error('--until cannot be more than 30 days away')

  const state = await loadRadarState(statePath)
  const event = activeEventForIncident(state, incidentId)
  if (event === undefined) throw new Error(`active incident not found: ${incidentId}`)
  const forceRequired = event.kind === 'malware'
    || (event.kind === 'vulnerability' && event.advisory.severity === 'critical')
  if (forceRequired && !force) throw new Error('critical or malware incidents require --force to mute')
  const mutedUntil = new Date(mutedUntilMs).toISOString()
  await saveRadarState(statePath, {
    ...state,
    incidentMutes: {
      ...(state.incidentMutes ?? {}),
      [incidentId]: { eventId: event.id, mutedUntil },
    },
  })
  const result = { incidentId, eventId: event.id, mutedUntil, forced: force }
  process.stdout.write(json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Muted delivery for ${safeErrorMessage(incidentId)} until ${mutedUntil}. Active evidence and history remain visible.\n`)
  return 0
}

async function runIncidentUnmute(args: readonly string[]): Promise<number> {
  const statePath = args[0]
  const incidentId = args[1]
  if (statePath === undefined || statePath.startsWith('-')) throw new Error('unmute requires a state file')
  if (incidentId === undefined || incidentId.startsWith('-')) throw new Error('unmute requires an incident id')
  let json = false
  for (const argument of args.slice(2)) {
    if (argument === '--json') json = true
    else throw new Error(`unknown option for unmute: ${argument}`)
  }
  const state = await loadRadarState(statePath)
  if (state.incidentMutes?.[incidentId] === undefined) throw new Error(`incident is not muted: ${incidentId}`)
  const nextIncidentMutes = Object.fromEntries(
    Object.entries(state.incidentMutes).filter(([id]) => id !== incidentId),
  )
  await saveRadarState(statePath, { ...state, incidentMutes: nextIncidentMutes })
  const result = { incidentId, unmuted: true }
  process.stdout.write(json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Resumed delivery for ${safeErrorMessage(incidentId)}.\n`)
  return 0
}

async function runIncidentTriage(args: readonly string[]): Promise<number> {
  const statePath = args[0]
  const incidentId = args[1]
  if (statePath === undefined || statePath.startsWith('-')) throw new Error('triage requires a state file')
  if (incidentId === undefined || incidentId.startsWith('-')) throw new Error('triage requires an incident id')
  let statusValue: string | undefined
  let ownerValue: string | undefined
  let noteValue: string | undefined
  let json = false
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) throw new Error('triage received an incomplete option')
    if (argument === '--json') json = true
    else if (argument === '--status' || argument === '--owner' || argument === '--note') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--status') statusValue = value
      else if (argument === '--owner') ownerValue = value
      else noteValue = value
      index += 1
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option for triage: ${argument}`)
    } else {
      throw new Error(`triage received unexpected argument: ${argument}`)
    }
  }
  if (statusValue === undefined) throw new Error('triage requires --status <open|in-progress|blocked|accepted-risk>')
  if (!VALID_INCIDENT_TRIAGE_STATUSES.has(statusValue as RadarIncidentTriageStatus)) {
    throw new Error(`invalid triage --status value: ${statusValue}`)
  }
  const status = statusValue as RadarIncidentTriageStatus
  const owner = ownerValue?.trim()
  const note = noteValue?.trim()
  if (ownerValue !== undefined && (owner === undefined || owner.length === 0)) throw new Error('--owner cannot be empty')
  if (owner !== undefined && owner.length > 512) throw new Error('--owner must be 512 characters or fewer')
  if (noteValue !== undefined && (note === undefined || note.length === 0)) throw new Error('--note cannot be empty')
  if (note !== undefined && note.length > 2_048) throw new Error('--note must be 2048 characters or fewer')

  const state = await loadRadarState(statePath)
  const event = activeEventForIncident(state, incidentId)
  if (event === undefined) throw new Error(`active incident not found: ${incidentId}`)
  const previous = state.incidentTriage?.[incidentId]
  const inherited = previous?.eventId === event.id ? previous : undefined
  const recordNote = note ?? inherited?.note
  if ((status === 'blocked' || status === 'accepted-risk') && recordNote === undefined) {
    throw new Error(`triage status ${status} requires --note <text>`)
  }
  const recordOwner = owner ?? inherited?.owner
  const record: RadarIncidentTriage = {
    eventId: event.id,
    status,
    updatedAt: new Date().toISOString(),
    ...(recordOwner === undefined ? {} : { owner: recordOwner }),
    ...(recordNote === undefined ? {} : { note: recordNote }),
  }
  await saveRadarState(statePath, {
    ...state,
    incidentTriage: {
      ...(state.incidentTriage ?? {}),
      [incidentId]: record,
    },
  })
  const result = { incidentId, ...record }
  process.stdout.write(json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Recorded ${status} follow-up for ${safeErrorMessage(incidentId)}${record.owner === undefined ? '' : ` (owner: ${safeErrorMessage(record.owner)})`}.\n`)
  return 0
}

async function runAnalysis(args: readonly string[]): Promise<number> {
  const subcommand = args[0]
  if (subcommand !== 'list' && subcommand !== 'show') throw new Error('analysis requires list or show')
  const statePath = args[1]
  if (statePath === undefined || statePath.startsWith('-')) throw new Error(`analysis ${subcommand} requires a state file`)
  const positional: string[] = []
  let json = false
  for (const argument of args.slice(2)) {
    if (argument === '--json') json = true
    else if (argument.startsWith('-')) throw new Error(`unknown option for analysis ${subcommand}: ${argument}`)
    else positional.push(argument)
  }
  const results = Object.values((await loadRadarState(statePath)).analysisResults ?? {})
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
  if (subcommand === 'list') {
    if (positional.length > 0) throw new Error('analysis list received unexpected arguments')
    if (json) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
    } else if (results.length === 0) {
      process.stdout.write('No verified DSH analysis results.\n')
    } else {
      process.stdout.write('INCIDENT\tEXPOSURE\tCONFIDENCE\tURGENCY\tRECEIVED\n')
      for (const result of results) {
        process.stdout.write([
          safeErrorMessage(result.incidentId),
          result.project_exposure,
          result.confidence,
          result.urgency,
          safeErrorMessage(result.receivedAt),
        ].join('\t') + '\n')
      }
    }
    return 0
  }
  if (positional.length > 1) throw new Error('analysis show accepts at most one incident id')
  const requestedId = positional[0]
  const result = requestedId === undefined
    ? results[0]
    : results.find(item => item.incidentId === requestedId)
  if (result === undefined) throw new Error(requestedId === undefined ? 'no verified DSH analysis result' : `analysis result not found: ${requestedId}`)
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write([
      `Incident: ${safeErrorMessage(result.incidentId)}`,
      `Exposure: ${result.project_exposure}`,
      `Confidence: ${result.confidence}`,
      `Urgency: ${result.urgency}`,
      `Evidence: ${result.evidence.map(item => safeErrorMessage(item, 4_096)).join(' | ') || '(none)'}`,
      `Recommended action: ${safeErrorMessage(result.recommended_action, 8_192)}`,
      `Reasoning: ${safeErrorMessage(result.reasoning_summary, 16_384)}`,
      `Received: ${safeErrorMessage(result.receivedAt)}`,
    ].join('\n') + '\n')
  }
  return 0
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > maxBytes) throw new Error(`${path} exceeds the ${maxBytes} byte limit`)
  return contents
}

async function readJson(path: string): Promise<unknown> {
  const contents = await readBoundedFile(path, 256 * 1024 * 1024)
  try {
    return JSON.parse(contents) as unknown
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
}

async function runBenchmark(args: readonly string[]): Promise<number> {
  if (args[0] !== 'compatibility') throw new Error('benchmark requires compatibility')
  let json = false
  for (const argument of args.slice(1)) {
    if (argument === '--json') json = true
    else throw new Error(`unknown option for benchmark: ${argument}`)
  }
  const report = runCompatibilityBenchmark()
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderCompatibilityBenchmark(report))
  return report.summary.failed === 0 ? 0 : 1
}

function runDemo(args: readonly string[]): number {
  let json = false
  for (const argument of args) {
    if (argument === '--json') json = true
    else throw new Error(`unknown option for demo: ${argument}`)
  }
  const report = createDemoReport()
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderDemo(report))
  return 0
}

async function runProbe(args: readonly string[]): Promise<number> {
  const mode = args[0]
  if (mode !== 'dsh-load' && mode !== 'dsh-matrix') throw new Error('probe requires dsh-load or dsh-matrix')
  const packagePath = args[1]
  if (packagePath === undefined || packagePath.startsWith('-')) throw new Error(`probe ${mode} requires a package.tgz file`)
  const dshVersions: string[] = []
  let timeoutSeconds = 120
  let keepProfile = false
  let json = false
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--keep-profile') {
      keepProfile = true
    } else if (argument === '--dsh-version' || argument === '--timeout') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--dsh-version') {
        const values = value.split(',').map(item => item.trim()).filter(item => item !== '')
        if (values.length === 0) throw new Error('--dsh-version requires at least one exact version')
        if (mode === 'dsh-load' && values.length !== 1) throw new Error('probe dsh-load accepts only one DSH version')
        if (mode === 'dsh-load' && dshVersions.length > 0) throw new Error('probe dsh-load accepts only one DSH version')
        dshVersions.push(...values)
      } else {
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 30 || parsed > 600) {
          throw new Error('--timeout must be an integer between 30 and 600 seconds')
        }
        timeoutSeconds = parsed
      }
      index += 1
    } else {
      throw new Error(`unknown option for probe ${mode}: ${argument}`)
    }
  }
  const timeoutMs = timeoutSeconds * 1_000
  if (mode === 'dsh-load') {
    const report = await probeDshLoad({
      packagePath,
      ...(dshVersions[0] === undefined ? {} : { dshVersion: dshVersions[0] }),
      timeoutMs,
      keepProfile,
    })
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderDshLoadProbe(report))
    return report.result === 'compatible' ? 0 : report.result === 'incompatible' ? 2 : 1
  }
  const report = await probeDshLoadMatrix({
    packagePath,
    dshVersions,
    timeoutMs,
    keepProfiles: keepProfile,
  })
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderDshLoadMatrix(report))
  return report.result === 'compatible' ? 0 : report.result === 'incompatible' ? 2 : 1
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(resolve(path))
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function runRadar(args: readonly string[]): Promise<number> {
  const subcommand = args[0]
  if (subcommand !== 'check' && subcommand !== 'watch' && subcommand !== 'status' && subcommand !== 'next' && subcommand !== 'history' && subcommand !== 'compare') {
    throw new Error('radar requires check, watch, status, next, history or compare')
  }
  const configPath = args[1]
  if (configPath === undefined || configPath.startsWith('-')) throw new Error(`radar ${subcommand} requires a config file`)
  const positional: string[] = []
  let json = false
  let statePath: string | undefined
  let osvBaseUrl: string | undefined
  let registry: string | undefined
  let webhookUrl: string | undefined
  let notesPath: string | undefined
  let intervalSeconds = 1_800
  let intervalProvided = false
  let historyLimit = 20
  let historyLimitProvided = false
  let once = false
  let deepCandidates = true
  let githubAdvisories = true
  let threatIntel = false
  let frozen = false
  let failOn: RadarFailThreshold = 'never'
  let failOnCompatibility: RadarCompatibilityFailThreshold = 'never'
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--once') {
      once = true
    } else if (argument === '--no-deep-candidates') {
      deepCandidates = false
    } else if (argument === '--no-github-advisories') {
      githubAdvisories = false
    } else if (argument === '--threat-intel') {
      threatIntel = true
    } else if (argument === '--frozen') {
      frozen = true
    } else if (argument === '--state' || argument === '--osv-base-url' || argument === '--registry' || argument === '--webhook'
      || argument === '--notes' || argument === '--interval' || argument === '--limit' || argument === '--fail-on'
      || argument === '--fail-on-compatibility') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--state') statePath = value
      else if (argument === '--osv-base-url') osvBaseUrl = value
      else if (argument === '--registry') registry = value
      else if (argument === '--webhook') webhookUrl = normalizeRadarWebhookUrl(value)
      else if (argument === '--notes') notesPath = value
      else if (argument === '--fail-on') {
        if (!VALID_RADAR_THRESHOLDS.has(value as RadarFailThreshold)) {
          throw new Error(`invalid radar --fail-on value: ${value}`)
        }
        failOn = value as RadarFailThreshold
      } else if (argument === '--fail-on-compatibility') {
        if (!VALID_RADAR_COMPATIBILITY_THRESHOLDS.has(value as RadarCompatibilityFailThreshold)) {
          throw new Error(`invalid radar --fail-on-compatibility value: ${value}`)
        }
        failOnCompatibility = value as RadarCompatibilityFailThreshold
      } else if (argument === '--limit') {
        historyLimitProvided = true
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
          throw new Error('--limit must be an integer between 1 and 1000')
        }
        historyLimit = parsed
      }
      else {
        intervalProvided = true
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 300 || parsed > 86_400) {
          throw new Error('--interval must be an integer between 300 and 86400')
        }
        intervalSeconds = parsed
      }
      index += 1
    } else if (argument?.startsWith('-')) {
      throw new Error(`unknown option for radar ${subcommand}: ${argument}`)
    } else if (argument !== undefined) {
      positional.push(argument)
    }
  }

  const readConfig = async () => parseRadarConfig(await readJson(configPath))
  const readConfigForPoll = async () => frozen
    ? readConfig()
    : refreshRadarConfigFromConfiguredProfile(await readConfig())
  if (subcommand === 'status' || subcommand === 'next') {
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided
      || historyLimitProvided || osvBaseUrl !== undefined || registry !== undefined || webhookUrl !== undefined || !deepCandidates || !githubAdvisories || threatIntel || frozen || statePath === ':memory:'
      || (subcommand === 'next' && (failOn !== 'never' || failOnCompatibility !== 'never'))) {
      throw new Error(subcommand === 'next'
        ? 'radar next only accepts --state and --json options'
        : 'radar status only accepts --state, --fail-on, --fail-on-compatibility and --json options')
    }
    const config = await readConfig()
    const stateFile = statePath ?? `${resolve(configPath)}.state.json`
    const stateExists = await fileExists(stateFile)
    const state = stateExists ? await loadRadarState(stateFile) : emptyRadarState()
    const report = createRadarStatus(config, state, {
      configFile: resolve(configPath),
      stateFile: resolve(stateFile),
      stateExists,
    })
    const policy = evaluateRadarPolicy(state, failOn, failOnCompatibility)
    const policyEnabled = failOn !== 'never' || failOnCompatibility !== 'never'
    if (subcommand === 'next') {
      const next = createRadarNext(report, state)
      process.stdout.write(json ? `${JSON.stringify(next, null, 2)}\n` : renderRadarNext(next))
      return 0
    }
    if (json) {
      process.stdout.write(!policyEnabled
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${JSON.stringify({ ...report, policy }, null, 2)}\n`)
    } else {
      process.stdout.write(`${renderRadarStatus(report)}${policyEnabled ? renderRadarPolicy(policy) : ''}`)
    }
    if (report.monitoring === 'degraded' || report.coverage === 'incomplete') return 1
    return policy.status === 'fail' ? 2 : 0
  }
  if (subcommand === 'history') {
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided
      || osvBaseUrl !== undefined || registry !== undefined || webhookUrl !== undefined || !deepCandidates || !githubAdvisories || frozen
      || failOn !== 'never' || failOnCompatibility !== 'never' || threatIntel) {
      throw new Error('radar history only accepts --state, --limit and --json options')
    }
    // Parse the config as an input check, but deliberately do not refresh it
    // or contact any upstream source. History is a local diagnosis command.
    await readConfig()
    const stateFile = statePath ?? `${resolve(configPath)}.state.json`
    const stateExists = await fileExists(stateFile)
    const state = stateExists ? await loadRadarState(stateFile) : emptyRadarState()
    const report = createRadarHistory(state, {
      configFile: resolve(configPath),
      stateFile: resolve(stateFile),
      stateExists,
      limit: historyLimit,
    })
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderRadarHistory(report))
    return 0
  }
  const osv = new OsvClient({
    ...(osvBaseUrl === undefined ? {} : { baseUrl: osvBaseUrl }),
  })
  const releases = new NpmReleaseClient({
    ...(registry === undefined ? {} : { registry }),
  })
  const candidateGraphs = deepCandidates
    ? new NpmCandidateGraphClient({ ...(registry === undefined ? {} : { registry }) })
    : undefined
  const releaseNotesSource = new GitHubReleaseClient()
  const githubAdvisorySource = githubAdvisories
    ? new GitHubAdvisoryClient({ ...(process.env.GITHUB_TOKEN === undefined ? {} : { token: process.env.GITHUB_TOKEN }) })
    : undefined
  const threatIntelSources = threatIntel
    ? [
        { name: 'cisa-kev' as const, source: new CisaKevClient() },
        { name: 'epss' as const, source: new EpssClient() },
      ]
    : []
  const stateFile = statePath ?? `${resolve(configPath)}.state.json`
  if (webhookUrl !== undefined && statePath === ':memory:') {
    throw new Error('radar --webhook requires a persistent --state file so successful deliveries can be remembered')
  }
  const webhookEndpointHash = webhookUrl === undefined ? undefined : radarWebhookEndpointHash(webhookUrl)
  const feishuSecret = process.env.UPSTREAM_RADAR_FEISHU_SECRET?.trim() || undefined
  const runCheck = async () => {
    const config = await readConfigForPoll()
    const state = statePath === ':memory:' ? emptyRadarState() : await loadRadarState(stateFile)
    const checkedAt = new Date()
    const result = await pollRadar(
      config.projects,
      state,
      osv,
      checkedAt,
      releases,
      releaseNotesSource,
      candidateGraphs,
      githubAdvisorySource === undefined ? [] : [{ name: 'github-advisories' as const, source: githubAdvisorySource }],
      threatIntelSources,
    )
    if (statePath !== ':memory:') await saveRadarState(stateFile, result.state)
    if (webhookUrl === undefined || webhookEndpointHash === undefined) return result
    const queuedState = queueRadarWebhookEvents(result.state, webhookEndpointHash, result.events)
    if (statePath !== ':memory:') await saveRadarState(stateFile, queuedState)
    const notificationPolicies = createNotificationPolicyMap(config.projects)
    const pendingWebhookEvents = filterNotifiableRadarEvents(
      undeliveredRadarWebhookEvents(queuedState, webhookEndpointHash, result.events),
      notificationPolicies,
      checkedAt,
      queuedState,
    )
    if (pendingWebhookEvents.length === 0) return { ...result, state: queuedState }
    const payload = await sendRadarWebhook(webhookUrl, pendingWebhookEvents, feishuSecret === undefined ? {} : { feishuSecret })
    const deliveredIds = new Set(payload.events.map(event => event.id))
    const deliveredEvents = pendingWebhookEvents.filter(event => deliveredIds.has(event.id))
    const nextState = markRadarWebhookEventsDelivered(queuedState, webhookEndpointHash, deliveredEvents)
    await saveRadarState(stateFile, nextState)
    return { ...result, state: nextState }
  }
  const writeCheckResult = (result: Awaited<ReturnType<typeof pollRadar>>, compactJson = false) => {
    const policy = evaluateRadarPolicy(result.state, failOn, failOnCompatibility)
    const policyEnabled = failOn !== 'never' || failOnCompatibility !== 'never'
    if (json) {
      process.stdout.write(!policyEnabled
        ? `${JSON.stringify(result, null, compactJson ? 0 : 2)}\n`
        : `${JSON.stringify({ ...result, policy }, null, compactJson ? 0 : 2)}\n`)
    } else {
      process.stdout.write(`${renderRadarEvents(result.events)}${result.sourceErrors.map(error => `Source warning (${error.source}): ${safeErrorMessage(error.message)}\n`).join('')}Prepared ${result.analysisTasks.length} DSH analysis task(s); queried ${result.packagesQueried} exact package versions and ${result.releasePackagesQueried} release streams.\n${policyEnabled ? renderRadarPolicy(policy) : ''}`)
    }
    return policy
  }

  if (subcommand === 'check') {
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided || historyLimitProvided) {
      throw new Error('radar check received an option meant for watch or compare')
    }
    const result = await runCheck()
    const policy = writeCheckResult(result)
    if (result.sourceErrors.length > 0) return 1
    return policy.status === 'fail' ? 2 : 0
  }

  if (subcommand === 'watch') {
    if (positional.length > 0 || notesPath !== undefined || historyLimitProvided) throw new Error('radar watch received unexpected arguments')
    if ((failOn !== 'never' || failOnCompatibility !== 'never') && !once) throw new Error('radar watch requires --once when a policy gate is used')
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let wake: (() => void) | undefined
    const stop = (): void => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      wake?.()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      do {
        try {
          const result = await runCheck()
          const policy = writeCheckResult(result, true)
          if (once && result.sourceErrors.length > 0) return 1
          if (once && policy.status === 'fail') return 2
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`upstream-radar: watch cycle failed: ${safeErrorMessage(message)}\n`)
          if (once) return 1
        }
        if (once || stopped) break
        await new Promise<void>(resolvePromise => {
          wake = resolvePromise
          timer = setTimeout(resolvePromise, intervalSeconds * 1_000)
        })
        timer = undefined
        wake = undefined
      } while (!stopped)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    return 0
  }

  if (statePath !== undefined || osvBaseUrl !== undefined || registry !== undefined || webhookUrl !== undefined || once || intervalProvided || historyLimitProvided || !deepCandidates || !githubAdvisories || threatIntel || frozen || failOn !== 'never' || failOnCompatibility !== 'never') {
    throw new Error('radar compare does not accept check or watch options')
  }
  const config = await readConfig()
  if (positional.length !== 2) throw new Error('radar compare requires before.json and candidate.json')
  const previous = parsePackageManifestSnapshot(await readJson(positional[0] ?? ''))
  const candidate = parsePackageManifestSnapshot(await readJson(positional[1] ?? ''))
  const releaseNotes = notesPath === undefined ? undefined : await readBoundedFile(notesPath, 64 * 1024)
  const detectedAt = new Date().toISOString()
  const events = config.projects.flatMap((inventory) => {
    const event = assessCompatibilityChange(inventory, {
      previous,
      candidate,
      detectedAt,
      ...(releaseNotes === undefined ? {} : { releaseNotes }),
    })
    return event === undefined ? [] : [event]
  })
  const analysisTasks = events.map(createAnalysisTask)
  process.stdout.write(json
    ? `${JSON.stringify({ detectedAt, events, analysisTasks }, null, 2)}\n`
    : `${renderRadarEvents(events)}Prepared ${analysisTasks.length} DSH compatibility analysis task(s).\n`)
  return 0
}

async function runQuickstart(args: readonly string[]): Promise<number> {
  let directory = process.cwd()
  let json = false
  let positional = false
  for (const argument of args) {
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument.startsWith('-')) throw new Error(`unknown option for quickstart: ${argument}`)
    if (positional) throw new Error('quickstart accepts at most one directory')
    directory = argument
    positional = true
  }
  const report = await createQuickstartReport(directory)
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderQuickstartReport(report))
  return 0
}

async function runSetup(args: readonly string[]): Promise<number> {
  let profile: string | undefined
  let output = 'upstream-radar.config.json'
  let patchFile: string | undefined = 'upstream-radar.dsh.yml'
  let noInstall = false
  let startDsh = false
  const initArgs: string[] = []
  const valueOptions = new Set([
    '--profile', '--output', '--dsh-patch', '--project-id', '--project-name',
    '--repository', '--workspace', '--channel', '--registry', '--minimum-severity', '--quiet-hours',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--no-install') {
      noInstall = true
      continue
    }
    if (argument === '--no-dsh-patch') {
      patchFile = undefined
      continue
    }
    if (argument === '--start') {
      startDsh = true
      continue
    }
    if (argument === '--json') throw new Error('setup does not accept --json; use init --json')
    if (argument === '--force') {
      initArgs.push(argument)
      continue
    }
    if (valueOptions.has(argument ?? '')) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--profile') profile = value
      else if (argument === '--output') output = value
      if (argument === '--dsh-patch') patchFile = value
      else initArgs.push(argument ?? '', value)
      index += 1
      continue
    }
    throw new Error(`unknown option for setup: ${argument}`)
  }

  let resolvedProfile = profile
  if (!noInstall && resolvedProfile === undefined) {
    const candidates = await discoverDshProfiles()
    if (candidates.length === 0) {
      throw new Error('setup could not find a DSH profile with third-party bundles; install one with `dsh plugin --profile <name> add <package>@<exact-version>`, then rerun setup')
    }
    if (candidates.length > 1) {
      throw new Error(`setup found multiple DSH profiles with third-party bundles (${candidates.join(', ')}); pass --profile <name>`)
    }
    resolvedProfile = candidates[0]
  }
  if (resolvedProfile !== undefined && profile === undefined) {
    initArgs.unshift('--profile', resolvedProfile)
  }

  // Setup is the beginner-facing path: make the generated DSH overlay the
  // default so a first run does not fall back to hidden environment variables.
  // `init` remains available when a user deliberately wants the legacy
  // environment-variable wiring instead.
  if (patchFile !== undefined) initArgs.push('--dsh-patch', patchFile)

  if (!noInstall) {
    if (resolvedProfile === undefined) throw new Error('setup could not select a DSH profile')
    resolveDshProfileDirectory(resolvedProfile)
    const dshCommand = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    process.stdout.write(`Installing upstream-radar@${TOOL_VERSION} into DSH profile ${resolvedProfile}...\n`)
    const result = spawnSync(dshCommand, [
      'plugin', '--profile', resolvedProfile, 'add', `upstream-radar@${TOOL_VERSION}`,
    ], {
      env: process.env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) {
      const spawnError = result.error as NodeJS.ErrnoException
      if (spawnError.code === 'ENOENT') {
        throw new Error('setup could not find the `dsh` command; install DeepSeek Harness, verify `dsh --help` works, then rerun setup')
      }
      throw new Error(`setup could not run ${dshCommand}: ${safeErrorMessage(result.error.message)}`)
    }
    if (result.status !== 0) {
      throw new Error(`DSH plugin installation failed with exit code ${result.status ?? 'unknown'}`)
    }
  }

  const initStatus = await runInit(initArgs)
  if (initStatus !== 0) return initStatus

  const outputPath = resolve(output)
  const config = parseRadarConfig(await readJson(outputPath))
  const statePath = `${outputPath}.state.json`
  const doctorOptions: Parameters<typeof createDoctorReport>[0] = {
    configFile: outputPath,
    stateFile: statePath,
  }
  const doctorProfile = config.dshProfile?.name ?? resolvedProfile
  if (doctorProfile !== undefined) doctorOptions.profile = doctorProfile
  if (patchFile !== undefined) doctorOptions.patchFile = patchFile
  const doctor = await createDoctorReport(doctorOptions)
  process.stdout.write(`\nLocal wiring check:\n${renderDoctorReport(doctor)}`)
  if (doctor.status === 'blocked') return 1
  if (!startDsh) return 0

  if (doctorProfile === undefined) {
    throw new Error('setup --start could not determine the DSH profile; pass --profile <name>')
  }
  const dshCommand = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const dshArgs = ['--profile', doctorProfile]
  const dshEnvironment = patchFile === undefined
    ? { ...process.env, UPSTREAM_RADAR_CONFIG: outputPath, UPSTREAM_RADAR_STATE: statePath }
    : process.env
  if (patchFile !== undefined) dshArgs.push('--patch', patchFile)
  process.stdout.write(`\nStarting DSH profile ${doctorProfile}; press Ctrl-C to stop.\n`)
  const result = spawnSync(dshCommand, dshArgs, { env: dshEnvironment, stdio: 'inherit' })
  if (result.error !== undefined) {
    const spawnError = result.error as NodeJS.ErrnoException
    if (spawnError.code === 'ENOENT') {
      throw new Error('setup --start could not find the `dsh` command; install DeepSeek Harness, verify `dsh --help` works, then rerun setup')
    }
    throw new Error(`setup --start could not run ${dshCommand}: ${safeErrorMessage(result.error.message)}`)
  }
  return result.status ?? 1
}

async function runInit(args: readonly string[]): Promise<number> {
  let profile: string | undefined
  let npmLockPath: string | undefined
  let pnpmLockPath: string | undefined
  let rootSpec: string | undefined
  let output = 'upstream-radar.config.json'
  let dshPatch: string | undefined
  let projectId: string | undefined
  let projectName: string | undefined
  let repository: string | undefined
  let workspace: string | undefined
  let registry: string | undefined
  let minimumSeverity: string | undefined
  let quietHoursValue: string | undefined
  let force = false
  let json = false
  const channels: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--force') force = true
    else if (argument === '--json') json = true
    else if (argument === '--profile' || argument === '--npm-lock' || argument === '--pnpm-lock' || argument === '--root' || argument === '--output' || argument === '--dsh-patch' || argument === '--project-id'
      || argument === '--project-name' || argument === '--repository' || argument === '--workspace'
      || argument === '--channel' || argument === '--registry' || argument === '--minimum-severity' || argument === '--quiet-hours') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--profile') profile = value
      else if (argument === '--npm-lock') npmLockPath = value
      else if (argument === '--pnpm-lock') pnpmLockPath = value
      else if (argument === '--root') rootSpec = value
      else if (argument === '--output') output = value
      else if (argument === '--dsh-patch') dshPatch = value
      else if (argument === '--project-id') projectId = value
      else if (argument === '--project-name') projectName = value
      else if (argument === '--repository') repository = value
      else if (argument === '--workspace') workspace = value
      else if (argument === '--channel') channels.push(value)
      else if (argument === '--minimum-severity') minimumSeverity = value
      else if (argument === '--quiet-hours') quietHoursValue = value
      else registry = value
      index += 1
    } else {
      throw new Error(`unknown option for init: ${argument}`)
    }
  }
  const notificationPolicy = parseNotificationPolicyArguments(minimumSeverity, quietHoursValue)

  if (npmLockPath !== undefined || pnpmLockPath !== undefined) {
    if (npmLockPath !== undefined && pnpmLockPath !== undefined) {
      throw new Error('init accepts only one of --npm-lock or --pnpm-lock')
    }
    const lockKind = npmLockPath === undefined ? 'pnpm-lock' : 'npm-lock'
    const lockfile = npmLockPath ?? pnpmLockPath
    if (lockfile === undefined) throw new Error('init lockfile path is missing')
    if (profile !== undefined || dshPatch !== undefined || registry !== undefined) {
      throw new Error(`init --${lockKind} does not accept --profile, --dsh-patch or --registry`)
    }
    const root = rootSpec === undefined
      ? await inferLockfileRoot(lockfile, lockKind === 'npm-lock' ? 'npm' : 'pnpm')
      : parseExactPackageCoordinate(rootSpec)
    const config = lockKind === 'npm-lock'
      ? await createRadarConfigFromNpmLock({
        lockfile,
        root,
        ...(projectId === undefined ? {} : { projectId }),
        ...(projectName === undefined ? {} : { projectName }),
        ...(repository === undefined ? {} : { repository }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(channels.length === 0 ? {} : { channels }),
        ...(notificationPolicy === undefined ? {} : { notificationPolicy }),
      })
      : await createRadarConfigFromPnpmLock({
        lockfile,
        root,
        ...(projectId === undefined ? {} : { projectId }),
        ...(projectName === undefined ? {} : { projectName }),
        ...(repository === undefined ? {} : { repository }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(channels.length === 0 ? {} : { channels }),
        ...(notificationPolicy === undefined ? {} : { notificationPolicy }),
      })
    const outputPath = await writeRadarConfig(config, { output: resolve(output), force })
    const plugin = config.projects[0]?.plugins[0]
    if (plugin === undefined) throw new Error(`${lockKind} initialization produced no plugin`)
    if (json) {
      process.stdout.write(`${JSON.stringify({
        output: outputPath,
        source: plugin.graph.source,
        root: plugin.package,
        nodes: plugin.graph.nodes.length,
        edges: plugin.graph.edges.length,
        ...(plugin.graph.unresolved === undefined ? {} : { unresolved: plugin.graph.unresolved.length }),
      }, null, 2)}\n`)
    } else {
      const unresolved = plugin.graph.unresolved?.length ?? 0
      process.stdout.write(`Created ${outputPath}\nSource: ${plugin.graph.source ?? lockKind}\nRoot: ${plugin.package.name}@${plugin.package.version}\nGraph: ${plugin.graph.nodes.length} nodes, ${plugin.graph.edges.length} edges, ${unresolved} unresolved\nNext: upstream-radar radar check ${shellQuote(outputPath)} --frozen\n`)
    }
    return 0
  }
  if (rootSpec !== undefined) throw new Error('init --root is only valid with --npm-lock or --pnpm-lock')
  let autoSelected = false
  let resolvedProfile = profile
  if (resolvedProfile === undefined) {
    const candidates = await discoverDshProfiles()
    if (candidates.length === 0) {
      throw new Error('init could not find a DSH profile with third-party bundles; pass --profile <name>')
    }
    if (candidates.length > 1) {
      throw new Error(`init found multiple DSH profiles with third-party bundles (${candidates.join(', ')}); pass --profile <name>`)
    }
    resolvedProfile = candidates[0]
    autoSelected = true
  }
  if (resolvedProfile === undefined) throw new Error('init could not select a DSH profile')
  const plannedOutputPath = resolve(output)
  const plannedStatePath = `${plannedOutputPath}.state.json`
  if (dshPatch !== undefined) {
    const plannedPatchPath = resolve(dshPatch)
    if (plannedPatchPath === plannedOutputPath || plannedPatchPath === plannedStatePath) {
      throw new Error('DSH patch output must be different from the Radar config and state files')
    }
    if (!force) {
      try {
        await access(plannedPatchPath)
        throw new Error(`${plannedPatchPath} already exists; pass --force to replace it`)
      } catch (error: unknown) {
        if (error instanceof Error && !('code' in error)) throw error
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
    }
  }
  const config = await createRadarConfigFromDshProfile({
    profileDirectory: resolveDshProfileDirectory(resolvedProfile),
    ...(projectId === undefined ? {} : { projectId }),
    ...(projectName === undefined ? {} : { projectName }),
    ...(repository === undefined ? {} : { repository }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(channels.length === 0 ? {} : { channels }),
    ...(notificationPolicy === undefined ? {} : { notificationPolicy }),
    ...(registry === undefined ? {} : { registry }),
  })
  config.dshProfile = { name: resolvedProfile }
  const outputPath = await writeRadarConfig(config, { output: plannedOutputPath, force })
  const statePath = plannedStatePath
  const patchPath = dshPatch === undefined ? undefined : await writeDshPatch({
    output: dshPatch,
    configFile: outputPath,
    stateFile: statePath,
    profile: resolvedProfile,
    ...(registry === undefined ? {} : { registry }),
    force,
  })
  const plugins = config.projects[0]?.plugins ?? []
  // Keep the printed recovery command independent of the package manager that
  // happened to launch this copy. Node ships with npm/npx, while a user may
  // have entered setup through pnpm, yarn, or a global binary. The command is
  // deliberately exact-versioned so the doctor checks the same release that
  // generated the config.
  const doctorCommand = `npx --yes upstream-radar@${TOOL_VERSION} doctor ${shellQuote(outputPath)} --profile ${shellQuote(resolvedProfile)}${patchPath === undefined ? '' : ` --patch ${shellQuote(patchPath)}`}`
  const statusCommand = `npx --yes upstream-radar@${TOOL_VERSION} radar status ${shellQuote(outputPath)} --state ${shellQuote(statePath)}`
  const startCommand = patchPath === undefined
    ? `dsh --profile ${shellQuote(resolvedProfile)}`
    : `dsh --profile ${shellQuote(resolvedProfile)} --patch ${shellQuote(patchPath)}`
  if (json) {
    process.stdout.write(`${JSON.stringify({ output: outputPath, profile: resolvedProfile, plugins: plugins.map(plugin => ({
      name: plugin.package.name,
      version: plugin.package.version,
      nodes: plugin.graph.nodes.length,
      edges: plugin.graph.edges.length,
      ...(plugin.graph.source === undefined ? {} : { source: plugin.graph.source }),
      ...(plugin.graph.hostRuntime === undefined ? {} : { hostRuntimeNodes: plugin.graph.hostRuntime.resolvedNodes }),
      ...(plugin.graph.hostRuntime?.package === undefined ? {} : { hostRuntimePackage: plugin.graph.hostRuntime.package }),
      ...(plugin.graph.unresolved === undefined ? {} : { unresolved: plugin.graph.unresolved.length }),
      ...(plugin.graph.unresolved === undefined ? {} : {
        requiredUnresolved: plugin.graph.unresolved.filter(item => item.kind !== 'optional').length,
        optionalUnresolved: plugin.graph.unresolved.filter(item => item.kind === 'optional').length,
      }),
    })), state: statePath, ...(patchPath === undefined ? {} : { patch: patchPath }) }, null, 2)}\n`)
  } else {
    if (autoSelected) process.stdout.write(`Auto-selected DSH profile: ${resolvedProfile}\n`)
    process.stdout.write(`Created ${outputPath}\nDiscovered ${plugins.length} DSH plugin bundle(s):\n`)
    for (const plugin of plugins) {
      const unresolved = plugin.graph.unresolved?.length ?? 0
      const requiredUnresolved = plugin.graph.unresolved?.filter(item => item.kind !== 'optional').length ?? 0
      const optionalUnresolved = unresolved - requiredUnresolved
      const hostRuntime = plugin.graph.hostRuntime?.resolvedNodes ?? 0
      const hostRuntimePackage = plugin.graph.hostRuntime?.package
      process.stdout.write(`  ${plugin.package.name}@${plugin.package.version} (${plugin.graph.nodes.length} dependency nodes${plugin.graph.source === undefined ? '' : `, ${plugin.graph.source}`}${hostRuntime === 0 ? '' : `, ${hostRuntime} DSH host`}${hostRuntimePackage === undefined ? '' : `, runtime ${hostRuntimePackage.name}@${hostRuntimePackage.version}`}${requiredUnresolved === 0 ? '' : `, ${requiredUnresolved} required unresolved`}${optionalUnresolved === 0 ? '' : `, ${optionalUnresolved} optional absent`})\n`)
    }
    if (patchPath === undefined) {
      process.stdout.write(`\nReview the generated inventory, then verify the wiring:\n  ${doctorCommand}\n\nStart DSH (keep it running):\n  export UPSTREAM_RADAR_CONFIG=${shellQuote(outputPath)}\n  export UPSTREAM_RADAR_STATE=${shellQuote(statePath)}\n  ${startCommand}\n\nAfter the first check, inspect the local result:\n  ${statusCommand}\n`)
    } else {
      process.stdout.write(`Created ${patchPath}\n\nReview the generated inventory and DSH overlay, then verify the wiring:\n  ${doctorCommand}\n\nStart DSH (keep it running):\n  ${startCommand}\n\nAfter the first check, inspect the local result:\n  ${statusCommand}\n`)
    }
  }
  return 0
}

async function runDoctor(args: readonly string[]): Promise<number> {
  let configFile = 'upstream-radar.config.json'
  let stateFile: string | undefined
  let profile: string | undefined
  let patchFile: string | undefined
  let json = false
  let positionalConfig = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) throw new Error('doctor received an empty argument')
    if (argument === '--json') {
      json = true
    } else if (argument === '--state' || argument === '--profile' || argument === '--patch') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--state') stateFile = value
      else if (argument === '--profile') profile = value
      else patchFile = value
      index += 1
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option for doctor: ${argument}`)
    } else if (!positionalConfig) {
      configFile = argument
      positionalConfig = true
    } else {
      throw new Error(`doctor received unexpected argument: ${argument}`)
    }
  }
  const report = await createDoctorReport({
    configFile,
    ...(stateFile === undefined ? {} : { stateFile }),
    ...(profile === undefined ? {} : { profile }),
    ...(patchFile === undefined ? {} : { patchFile }),
  })
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report))
  return report.status === 'blocked' ? 1 : 0
}

async function main(args: readonly string[]): Promise<number> {
  const help = commandHelp(args)
  if (help !== undefined) {
    process.stdout.write(help)
    return 0
  }
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${TOOL_VERSION}\n`)
    return 0
  }
  if (command === 'quickstart') return runQuickstart(args.slice(1))
  if (command === 'setup') return runSetup(args.slice(1))
  if (command === 'init') return runInit(args.slice(1))
  if (command === 'doctor') return runDoctor(args.slice(1))
  if (command === 'graph') return runGraph(args.slice(1))
  if (command === 'probe') return runProbe(args.slice(1))
  if (command === 'demo') return runDemo(args.slice(1))
  if (command === 'benchmark') return runBenchmark(args.slice(1))
  if (command === 'radar') return runRadar(args.slice(1))
  if (command === 'task') return runTask(args.slice(1))
  if (command === 'analysis') return runAnalysis(args.slice(1))
  if (command === 'mute') return runIncidentMute(args.slice(1))
  if (command === 'unmute') return runIncidentUnmute(args.slice(1))
  if (command === 'triage') return runIncidentTriage(args.slice(1))
  if (command !== 'scan' && command !== 'inspect') throw new Error(`unknown command: ${command}`)

  const target = args[1]
  if (target === undefined || target.startsWith('-')) throw new Error(`${command} requires a target`)
  let thresholdValue: string = 'review'
  let registry: string | undefined
  let json = false
  let deep = false
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--deep' && command === 'inspect') {
      deep = true
    } else if (argument === '--fail-on' || (argument === '--registry' && command === 'inspect')) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--fail-on') thresholdValue = value
      else registry = value
      index += 1
    } else {
      throw new Error(`unknown option for ${command}: ${argument}`)
    }
  }
  if (!VALID_THRESHOLDS.has(thresholdValue as Verdict | 'never')) {
    throw new Error(`invalid --fail-on value: ${thresholdValue}`)
  }

  const report = command === 'scan'
    ? await scanDirectory(target)
    : await inspectNpmPackage(target, {
        deep,
        ...(registry === undefined ? {} : { registry }),
      })
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(renderTextReport(report))
  }

  if (thresholdValue !== 'never' && verdictAtLeast(report.verdict, thresholdValue as Verdict)) return 2
  return 0
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`upstream-radar: ${safeErrorMessage(message)}\n`)
    process.exitCode = 1
  },
)
