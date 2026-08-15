#!/usr/bin/env node

import process from 'node:process'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderCompatibilityBenchmark, runCompatibilityBenchmark } from './compatibility-benchmark.js'
import { assessCompatibilityChange } from './compatibility.js'
import { probeDshLoad, probeDshLoadMatrix, renderDshLoadMatrix, renderDshLoadProbe } from './dsh-probe.js'
import { createAnalysisTask, renderAgentAnalysisPrompt } from './dsh-analysis.js'
import { createDoctorReport, renderDoctorReport } from './doctor.js'
import { GitHubReleaseClient } from './github-release.js'
import { createRadarConfigFromDshProfile, discoverDshProfiles, refreshRadarConfigFromConfiguredProfile, resolveDshProfileDirectory, writeDshPatch, writeRadarConfig } from './init.js'
import { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
import { inspectNpmPackage } from './npm.js'
import { NpmCandidateGraphClient } from './npm-candidate.js'
import { NpmReleaseClient } from './npm-release.js'
import { OsvClient } from './osv.js'
import { verdictAtLeast } from './policy.js'
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
import { loadRadarState, saveRadarState } from './radar-state.js'
import { createRadarStatus, renderRadarStatus } from './radar-status.js'
import { renderTextReport } from './render.js'
import { scanDirectory } from './scan.js'
import type { Verdict } from './types.js'
import { TOOL_VERSION } from './version.js'

const VALID_THRESHOLDS = new Set<Verdict | 'never'>(['warn', 'review', 'block', 'never'])
const VALID_RADAR_THRESHOLDS = new Set<RadarFailThreshold>(RADAR_FAIL_THRESHOLDS)
const VALID_RADAR_COMPATIBILITY_THRESHOLDS = new Set<RadarCompatibilityFailThreshold>(RADAR_COMPATIBILITY_FAIL_THRESHOLDS)

function safeErrorMessage(value: string, maxLength = 2_048): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  )).slice(0, maxLength)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function usage(): string {
  return `Upstream Radar — always-on dependency and compatibility monitoring for DSH plugins

Usage:
  upstream-radar init [--profile <name>] [options]
  upstream-radar doctor [config.json] [options]
  upstream-radar scan <directory> [--json] [--fail-on <warn|review|block|never>]
  upstream-radar inspect npm:<package>@<exact-version> [--deep] [--json] [--fail-on <warn|review|block|never>]
  upstream-radar probe dsh-load <package.tgz> [--dsh-version <exact-version>] [--timeout <seconds>] [--keep-profile] [--json]
  upstream-radar probe dsh-matrix <package.tgz> --dsh-version <v1>[,<v2>,...] [--timeout <seconds>] [--keep-profile] [--json]
  upstream-radar benchmark compatibility [--json]
  upstream-radar radar check <config.json> [--state <state.json>] [--frozen] [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]
  upstream-radar radar watch <config.json> [--state <state.json>] [--interval <seconds>] [--once] [--frozen] [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]
  upstream-radar radar status <config.json> [--state <state.json>] [--fail-on <severity>] [--fail-on-compatibility <never|breaking|any>] [--json]
  upstream-radar radar compare <config.json> <before.json> <candidate.json> [--notes <release-notes.txt>] [--json]
  upstream-radar task list <state.json> [--json]
  upstream-radar task show <state.json> [task-id] [--json]
  upstream-radar task ack <state.json> <task-id>
  upstream-radar analysis list <state.json> [--json]
  upstream-radar analysis show <state.json> [incident-id] [--json]
  upstream-radar version

Commands:
  init     discover third-party bundles in a DSH profile and write a reviewable inventory
  doctor   check local Radar/DSH wiring without polling upstream sources
  scan     bounded, read-only inspection of a local package directory
  inspect  fetch and verify the exact npm artifact before inspecting its contents
  probe    run a bounded DSH bundle-load check or version matrix in disposable profiles
  benchmark run offline compatibility-rule contracts without network or plugin execution
  radar    monitor vulnerability changes, watch continuously, inspect status, or assess a candidate compatibility change
  task     inspect or acknowledge the durable DSH analysis outbox
  analysis inspect verified DSH conclusions stored in the Radar state

Options:
  --deep               resolve the dependency graph with scripts disabled and ask npm to verify signatures/provenance
  --registry <url>     HTTPS npm registry for inspect or explicit public-graph init
  --no-deep-candidates skip bounded transitive dependency graph checks for upgrade candidates
  --state <path>       persistent radar state (default: <config.json>.state.json)
  --osv-base-url <url> alternate HTTPS OSV API base URL
  --interval <seconds> watch interval from 300 to 86400 seconds (default: 1800)
  --once               run one watch cycle and exit (useful for CI and demos)
  --frozen             radar check/watch: use the reviewed graph in config without reading a local DSH profile
  --fail-on <value>    scan/inspect verdict or radar severity: unknown|info|low|medium|high|critical|never
  --fail-on-compatibility <value>  CI gate: never|breaking|any (default: never)
  --notes <path>       release notes used as untrusted compatibility evidence
  --profile <name>     DSH profile for init or doctor (init auto-selects the only candidate when omitted)
  --output <path>      init output path (default: ./upstream-radar.config.json)
  --dsh-patch <path>   write a self-contained DSH --patch overlay (optional)
  --patch <path>       DSH overlay to verify with doctor
  --force              allow init to replace an existing output file
  --json               emit the canonical JSON report

Exit codes:
  0  completed without an operational error or configured policy match
  1  operational, source, or input error
  2  configured policy threshold was reached
`
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
  if (subcommand !== 'check' && subcommand !== 'watch' && subcommand !== 'status' && subcommand !== 'compare') {
    throw new Error('radar requires check, watch, status or compare')
  }
  const configPath = args[1]
  if (configPath === undefined || configPath.startsWith('-')) throw new Error(`radar ${subcommand} requires a config file`)
  const positional: string[] = []
  let json = false
  let statePath: string | undefined
  let osvBaseUrl: string | undefined
  let registry: string | undefined
  let notesPath: string | undefined
  let intervalSeconds = 1_800
  let intervalProvided = false
  let once = false
  let deepCandidates = true
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
    } else if (argument === '--frozen') {
      frozen = true
    } else if (argument === '--state' || argument === '--osv-base-url' || argument === '--registry'
      || argument === '--notes' || argument === '--interval' || argument === '--fail-on'
      || argument === '--fail-on-compatibility') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--state') statePath = value
      else if (argument === '--osv-base-url') osvBaseUrl = value
      else if (argument === '--registry') registry = value
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
  if (subcommand === 'status') {
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided
      || osvBaseUrl !== undefined || registry !== undefined || !deepCandidates || frozen || statePath === ':memory:') {
      throw new Error('radar status only accepts --state, --fail-on, --fail-on-compatibility and --json options')
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
  const stateFile = statePath ?? `${resolve(configPath)}.state.json`
  const runCheck = async () => {
    const config = await readConfigForPoll()
    const state = statePath === ':memory:' ? emptyRadarState() : await loadRadarState(stateFile)
    const result = await pollRadar(config.projects, state, osv, new Date(), releases, releaseNotesSource, candidateGraphs)
    if (statePath !== ':memory:') await saveRadarState(stateFile, result.state)
    return result
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
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided) {
      throw new Error('radar check received an option meant for watch or compare')
    }
    const result = await runCheck()
    const policy = writeCheckResult(result)
    if (result.sourceErrors.length > 0) return 1
    return policy.status === 'fail' ? 2 : 0
  }

  if (subcommand === 'watch') {
    if (positional.length > 0 || notesPath !== undefined) throw new Error('radar watch received unexpected arguments')
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

  if (statePath !== undefined || osvBaseUrl !== undefined || registry !== undefined || once || intervalProvided || !deepCandidates || frozen || failOn !== 'never' || failOnCompatibility !== 'never') {
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

async function runInit(args: readonly string[]): Promise<number> {
  let profile: string | undefined
  let output = 'upstream-radar.config.json'
  let dshPatch: string | undefined
  let projectId: string | undefined
  let projectName: string | undefined
  let repository: string | undefined
  let workspace: string | undefined
  let registry: string | undefined
  let force = false
  let json = false
  const channels: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--force') force = true
    else if (argument === '--json') json = true
    else if (argument === '--profile' || argument === '--output' || argument === '--dsh-patch' || argument === '--project-id'
      || argument === '--project-name' || argument === '--repository' || argument === '--workspace'
      || argument === '--channel' || argument === '--registry') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--profile') profile = value
      else if (argument === '--output') output = value
      else if (argument === '--dsh-patch') dshPatch = value
      else if (argument === '--project-id') projectId = value
      else if (argument === '--project-name') projectName = value
      else if (argument === '--repository') repository = value
      else if (argument === '--workspace') workspace = value
      else if (argument === '--channel') channels.push(value)
      else registry = value
      index += 1
    } else {
      throw new Error(`unknown option for init: ${argument}`)
    }
  }
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
  const doctorCommand = `pnpm dlx --package=upstream-radar@${TOOL_VERSION} upstream-radar doctor ${shellQuote(outputPath)} --profile ${shellQuote(resolvedProfile)}${patchPath === undefined ? '' : ` --patch ${shellQuote(patchPath)}`}`
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
      process.stdout.write(`  ${plugin.package.name}@${plugin.package.version} (${plugin.graph.nodes.length} dependency nodes${plugin.graph.source === undefined ? '' : `, ${plugin.graph.source}`}${hostRuntime === 0 ? '' : `, ${hostRuntime} DSH host`}${requiredUnresolved === 0 ? '' : `, ${requiredUnresolved} required unresolved`}${optionalUnresolved === 0 ? '' : `, ${optionalUnresolved} optional absent`})\n`)
    }
    if (patchPath === undefined) {
      process.stdout.write(`\nReview the generated inventory, then verify the wiring:\n  ${doctorCommand}\n\nStart DSH (keep it running):\n  export UPSTREAM_RADAR_CONFIG=${shellQuote(outputPath)}\n  export UPSTREAM_RADAR_STATE=${shellQuote(statePath)}\n  ${startCommand}\n`)
    } else {
      process.stdout.write(`Created ${patchPath}\n\nReview the generated inventory and DSH overlay, then verify the wiring:\n  ${doctorCommand}\n\nStart DSH (keep it running):\n  ${startCommand}\n`)
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
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${TOOL_VERSION}\n`)
    return 0
  }
  if (command === 'init') return runInit(args.slice(1))
  if (command === 'doctor') return runDoctor(args.slice(1))
  if (command === 'probe') return runProbe(args.slice(1))
  if (command === 'benchmark') return runBenchmark(args.slice(1))
  if (command === 'radar') return runRadar(args.slice(1))
  if (command === 'task') return runTask(args.slice(1))
  if (command === 'analysis') return runAnalysis(args.slice(1))
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
