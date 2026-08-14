#!/usr/bin/env node

import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assessCompatibilityChange } from './compatibility.js'
import { createAnalysisTask, renderAgentAnalysisPrompt } from './dsh-analysis.js'
import { parsePackageManifestSnapshot, parseRadarConfig } from './inventory.js'
import { inspectNpmPackage } from './npm.js'
import { NpmReleaseClient } from './npm-release.js'
import { OsvClient } from './osv.js'
import { verdictAtLeast } from './policy.js'
import { emptyRadarState, pollRadar } from './radar.js'
import { renderRadarEvents } from './radar-render.js'
import { loadRadarState, saveRadarState } from './radar-state.js'
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

function usage(): string {
  return `Upstream Radar — always-on dependency and compatibility monitoring for DSH plugins

Usage:
  upstream-radar scan <directory> [--json] [--fail-on <warn|review|block|never>]
  upstream-radar inspect npm:<package>@<exact-version> [--deep] [--json] [--fail-on <warn|review|block|never>]
  upstream-radar radar check <config.json> [--state <state.json>] [--json]
  upstream-radar radar compare <config.json> <before.json> <candidate.json> [--notes <release-notes.txt>] [--json]
  upstream-radar task list <state.json> [--json]
  upstream-radar task show <state.json> [task-id] [--json]
  upstream-radar task ack <state.json> <task-id>
  upstream-radar version

Commands:
  scan     bounded, read-only inspection of a local package directory
  inspect  fetch and verify the exact npm artifact before inspecting its contents
  radar    monitor vulnerability changes or assess a candidate compatibility change
  task     inspect or acknowledge the durable DSH analysis outbox

Options:
  --deep               resolve the dependency graph with scripts disabled and ask npm to verify signatures/provenance
  --registry <url>     HTTPS npm registry (default: https://registry.npmjs.org/)
  --state <path>       persistent radar state (default: <config.json>.state.json)
  --osv-base-url <url> alternate HTTPS OSV API base URL
  --notes <path>       release notes used as untrusted compatibility evidence
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

async function runRadar(args: readonly string[]): Promise<number> {
  const subcommand = args[0]
  if (subcommand !== 'check' && subcommand !== 'compare') {
    throw new Error('radar requires check or compare')
  }
  const configPath = args[1]
  if (configPath === undefined || configPath.startsWith('-')) throw new Error(`radar ${subcommand} requires a config file`)
  const positional: string[] = []
  let json = false
  let statePath: string | undefined
  let osvBaseUrl: string | undefined
  let notesPath: string | undefined
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--state' || argument === '--osv-base-url' || argument === '--notes') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--state') statePath = value
      else if (argument === '--osv-base-url') osvBaseUrl = value
      else notesPath = value
      index += 1
    } else if (argument?.startsWith('-')) {
      throw new Error(`unknown option for radar ${subcommand}: ${argument}`)
    } else if (argument !== undefined) {
      positional.push(argument)
    }
  }

  const config = parseRadarConfig(await readJson(configPath))
  if (subcommand === 'check') {
    if (positional.length > 0 || notesPath !== undefined) throw new Error('radar check received unexpected arguments')
    const stateFile = statePath ?? `${resolve(configPath)}.state.json`
    const state = statePath === ':memory:' ? emptyRadarState() : await loadRadarState(stateFile)
    const result = await pollRadar(config.projects, state, new OsvClient({
      ...(osvBaseUrl === undefined ? {} : { baseUrl: osvBaseUrl }),
    }), new Date(), new NpmReleaseClient())
    if (statePath !== ':memory:') await saveRadarState(stateFile, result.state)
    process.stdout.write(json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${renderRadarEvents(result.events)}${result.sourceErrors.map(error => `Source warning (${error.source}): ${safeErrorMessage(error.message)}\n`).join('')}Prepared ${result.analysisTasks.length} DSH analysis task(s); queried ${result.packagesQueried} exact package versions and ${result.releasePackagesQueried} release streams.\n`)
    return 0
  }

  if (statePath !== undefined || osvBaseUrl !== undefined) throw new Error('radar compare does not accept --state or --osv-base-url')
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
