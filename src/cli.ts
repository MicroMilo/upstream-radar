#!/usr/bin/env node

import process from 'node:process'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assessCompatibilityChange } from './compatibility.js'
import { createAnalysisTask, renderAgentAnalysisPrompt } from './dsh-analysis.js'
import { GitHubReleaseClient } from './github-release.js'
import { createRadarConfigFromDshProfile, discoverDshProfiles, resolveDshProfileDirectory, writeDshPatch, writeRadarConfig } from './init.js'
import { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
import { inspectNpmPackage } from './npm.js'
import { NpmReleaseClient } from './npm-release.js'
import { OsvClient } from './osv.js'
import { verdictAtLeast } from './policy.js'
import { emptyRadarState, pollRadar } from './radar.js'
import { renderRadarEvents } from './radar-render.js'
import { loadRadarState, saveRadarState } from './radar-state.js'
import { createRadarStatus, renderRadarStatus } from './radar-status.js'
import { renderTextReport } from './render.js'
import { scanDirectory } from './scan.js'
import type { Verdict } from './types.js'
import { TOOL_VERSION } from './version.js'

const VALID_THRESHOLDS = new Set<Verdict | 'never'>(['warn', 'review', 'block', 'never'])

function safeErrorMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  )).slice(0, 2_048)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function usage(): string {
  return `Upstream Radar — always-on dependency and compatibility monitoring for DSH plugins

Usage:
  upstream-radar init [--profile <name>] [options]
  upstream-radar scan <directory> [--json] [--fail-on <warn|review|block|never>]
  upstream-radar inspect npm:<package>@<exact-version> [--deep] [--json] [--fail-on <warn|review|block|never>]
  upstream-radar radar check <config.json> [--state <state.json>] [--json]
  upstream-radar radar watch <config.json> [--state <state.json>] [--interval <seconds>] [--once] [--json]
  upstream-radar radar status <config.json> [--state <state.json>] [--json]
  upstream-radar radar compare <config.json> <before.json> <candidate.json> [--notes <release-notes.txt>] [--json]
  upstream-radar task list <state.json> [--json]
  upstream-radar task show <state.json> [task-id] [--json]
  upstream-radar task ack <state.json> <task-id>
  upstream-radar version

Commands:
  init     discover third-party bundles in a DSH profile and write a reviewable inventory
  scan     bounded, read-only inspection of a local package directory
  inspect  fetch and verify the exact npm artifact before inspecting its contents
  radar    monitor vulnerability changes, watch continuously, inspect status, or assess a candidate compatibility change
  task     inspect or acknowledge the durable DSH analysis outbox

Options:
  --deep               resolve the dependency graph with scripts disabled and ask npm to verify signatures/provenance
  --registry <url>     HTTPS npm registry for inspect or explicit public-graph init
  --state <path>       persistent radar state (default: <config.json>.state.json)
  --osv-base-url <url> alternate HTTPS OSV API base URL
  --interval <seconds> watch interval from 300 to 86400 seconds (default: 1800)
  --once               run one watch cycle and exit (useful for CI and demos)
  --notes <path>       release notes used as untrusted compatibility evidence
  --profile <name>     DSH profile to inspect for init (auto-selects the only candidate when omitted)
  --output <path>      init output path (default: ./upstream-radar.config.json)
  --dsh-patch <path>   write a self-contained DSH --patch overlay (optional)
  --force              allow init to replace an existing output file
  --json               emit the canonical JSON report
  --fail-on <verdict>  CI threshold; default is review

Exit codes:
  0  scan completed and policy threshold was not reached
  1  operational or input error
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
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--once') {
      once = true
    } else if (argument === '--state' || argument === '--osv-base-url' || argument === '--registry'
      || argument === '--notes' || argument === '--interval') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--state') statePath = value
      else if (argument === '--osv-base-url') osvBaseUrl = value
      else if (argument === '--registry') registry = value
      else if (argument === '--notes') notesPath = value
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
  if (subcommand === 'status') {
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided
      || osvBaseUrl !== undefined || registry !== undefined || statePath === ':memory:') {
      throw new Error('radar status only accepts --state and --json options')
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
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderRadarStatus(report))
    return report.monitoring === 'degraded' || report.coverage === 'incomplete' ? 1 : 0
  }
  const osv = new OsvClient({
    ...(osvBaseUrl === undefined ? {} : { baseUrl: osvBaseUrl }),
  })
  const releases = new NpmReleaseClient({
    ...(registry === undefined ? {} : { registry }),
  })
  const releaseNotesSource = new GitHubReleaseClient()
  const stateFile = statePath ?? `${resolve(configPath)}.state.json`
  const runCheck = async () => {
    const config = await readConfig()
    const state = statePath === ':memory:' ? emptyRadarState() : await loadRadarState(stateFile)
    const result = await pollRadar(config.projects, state, osv, new Date(), releases, releaseNotesSource)
    if (statePath !== ':memory:') await saveRadarState(stateFile, result.state)
    return result
  }
  const writeCheckResult = (result: Awaited<ReturnType<typeof pollRadar>>, compactJson = false): void => {
    process.stdout.write(json
      ? `${JSON.stringify(result, null, compactJson ? 0 : 2)}\n`
      : `${renderRadarEvents(result.events)}${result.sourceErrors.map(error => `Source warning (${error.source}): ${safeErrorMessage(error.message)}\n`).join('')}Prepared ${result.analysisTasks.length} DSH analysis task(s); queried ${result.packagesQueried} exact package versions and ${result.releasePackagesQueried} release streams.\n`)
  }

  if (subcommand === 'check') {
    if (positional.length > 0 || notesPath !== undefined || once || intervalProvided) {
      throw new Error('radar check received an option meant for watch or compare')
    }
    const result = await runCheck()
    writeCheckResult(result)
    return result.sourceErrors.length === 0 ? 0 : 1
  }

  if (subcommand === 'watch') {
    if (positional.length > 0 || notesPath !== undefined) throw new Error('radar watch received unexpected arguments')
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
          writeCheckResult(result, true)
          if (once && result.sourceErrors.length > 0) return 1
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

  if (statePath !== undefined || osvBaseUrl !== undefined || registry !== undefined || once || intervalProvided) {
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
  const outputPath = await writeRadarConfig(config, { output: plannedOutputPath, force })
  const statePath = plannedStatePath
  const patchPath = dshPatch === undefined ? undefined : await writeDshPatch({
    output: dshPatch,
    configFile: outputPath,
    stateFile: statePath,
    profile: resolvedProfile,
    force,
  })
  const plugins = config.projects[0]?.plugins ?? []
  if (json) {
    process.stdout.write(`${JSON.stringify({ output: outputPath, profile: resolvedProfile, plugins: plugins.map(plugin => ({
      name: plugin.package.name,
      version: plugin.package.version,
      nodes: plugin.graph.nodes.length,
      edges: plugin.graph.edges.length,
      ...(plugin.graph.source === undefined ? {} : { source: plugin.graph.source }),
      ...(plugin.graph.unresolved === undefined ? {} : { unresolved: plugin.graph.unresolved.length }),
    })), state: statePath, ...(patchPath === undefined ? {} : { patch: patchPath }) }, null, 2)}\n`)
  } else {
    if (autoSelected) process.stdout.write(`Auto-selected DSH profile: ${resolvedProfile}\n`)
    process.stdout.write(`Created ${outputPath}\nDiscovered ${plugins.length} DSH plugin bundle(s):\n`)
    for (const plugin of plugins) {
      const unresolved = plugin.graph.unresolved?.length ?? 0
      process.stdout.write(`  ${plugin.package.name}@${plugin.package.version} (${plugin.graph.nodes.length} dependency nodes${plugin.graph.source === undefined ? '' : `, ${plugin.graph.source}`}${unresolved === 0 ? '' : `, ${unresolved} unresolved`})\n`)
    }
    if (patchPath === undefined) {
      process.stdout.write(`\nReview the generated inventory, then run:\n  export UPSTREAM_RADAR_CONFIG=${shellQuote(outputPath)}\n  export UPSTREAM_RADAR_STATE=${shellQuote(statePath)}\n  dsh --profile ${shellQuote(resolvedProfile)}\n`)
    } else {
      process.stdout.write(`Created ${patchPath}\n\nReview the generated inventory and DSH overlay, then run:\n  dsh --profile ${shellQuote(resolvedProfile)} --patch ${shellQuote(patchPath)}\n`)
    }
  }
  return 0
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
  if (command === 'radar') return runRadar(args.slice(1))
  if (command === 'task') return runTask(args.slice(1))
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
