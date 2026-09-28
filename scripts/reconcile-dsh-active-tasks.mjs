#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseDshActiveTaskState, reconcileDshActiveTaskResults } from '../dist/src/dsh-active-task-state.js'

const [statePath, matrixPath, artifactsPath, reportsPath, runId] = process.argv.slice(2)
if ([statePath, matrixPath, artifactsPath, reportsPath, runId].some(value => !value)
  || !/^[0-9]{1,32}$/.test(runId)) {
  throw new Error('usage: reconcile-dsh-active-tasks.mjs <task-state.json> <matrix.json> <artifacts-dir> <reports-dir> <run-id>')
}

const MAX_JSON_BYTES = 32 * 1024 * 1024
const roots = { artifacts: resolve(artifactsPath), reports: resolve(reportsPath) }

async function readJson(path, maximum = MAX_JSON_BYTES) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error(`${basename(path)} is not a bounded regular file`)
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

async function optionalJson(path, maximum) {
  try { return await readJson(path, maximum) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

async function save(path, value) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); await file.sync() }
  finally { await file.close() }
  await rename(temporary, destination)
}

async function listFiles(root, path = root, files = []) {
  if (files.length > 4_096) throw new Error('active task artifact contains too many files')
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) throw new Error('active task artifact contains a symlink')
    if (entry.isDirectory()) await listFiles(root, child, files)
    else if (entry.isFile()) files.push(relative(root, child))
    else throw new Error('active task artifact contains an unsupported filesystem object')
  }
  return files
}

function exactCoordinate(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.name === 'string' && typeof value.version === 'string'
    ? { name: value.name, version: value.version,
        ...(typeof value.integrity === 'string' ? { integrity: value.integrity } : {}) }
    : undefined
}

function coordinateMatches(observed, expected) {
  const coordinate = exactCoordinate(observed?.package)
  return coordinate?.name === expected.name && coordinate.version === expected.version
    && (expected.integrity === undefined || coordinate.integrity === expected.integrity)
    && observed?.source?.commit === expected.sourceCommit
}

function commandEvidence(report) {
  const commands = []
  for (const phase of ['install', 'load']) {
    for (const process of report?.observations?.[phase]?.processes ?? []) {
      if (typeof process?.executable === 'string' && Array.isArray(process.arguments)) {
        commands.push({ phase, executable: process.executable,
          arguments: process.arguments.filter(value => typeof value === 'string').slice(0, 64),
          succeeded: process.succeeded === true, count: process.count })
      }
    }
  }
  for (const command of report?.commands ?? []) {
    if (typeof command?.command === 'string' && Array.isArray(command.args)) {
      commands.push({ phase: command.phase, executable: command.command,
        arguments: command.args.filter(value => typeof value === 'string').slice(0, 64),
        code: command.code, timedOut: command.timedOut === true })
    }
  }
  return commands.slice(0, 64)
}

async function providerActions(artifact, files) {
  const path = files.find(file => file.endsWith('.provider.jsonl'))
  if (!path) return []
  const file = await open(join(artifact, path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('provider event log is not bounded')
    const lines = (await file.readFile('utf8')).split('\n').filter(Boolean)
    if (lines.length > 4_096) throw new Error('provider event log has too many records')
    return lines.map(line => JSON.parse(line)).filter(event => event?.type === 'tool-result')
      .map(event => ({ sequence: event.sequence, at: event.at, action: event.action,
        ok: event.ok === true, status: event.status })).slice(0, 1_024)
  } finally { await file.close() }
}

const [stateInput, matrix] = await Promise.all([
  readJson(statePath, 2 * 1024 * 1024),
  readJson(matrixPath, 128 * 1024),
])
const state = parseDshActiveTaskState(stateInput)
if (!Array.isArray(matrix.include) || matrix.include.length > 8) throw new Error('invalid active task reconciliation matrix')
await mkdir(roots.reports, { recursive: true })
let artifactDirectories = []
try { artifactDirectories = (await readdir(roots.artifacts, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name) }
catch (error) { if (error.code !== 'ENOENT') throw error }

const results = []
for (const entry of matrix.include) {
  const task = state.tasks.find(item => item.id === entry.taskId && item.inputFingerprint === entry.inputFingerprint)
  if (!task) throw new Error('scheduled active task is absent from the durable state')
  const prefix = `dsh-active-agent-${task.targetId}-${task.dshChannel}-${task.id}-${runId}`
  const artifactName = artifactDirectories.find(name => name === prefix)
  if (!artifactName) {
    results.push({ taskId: task.id, inputFingerprint: task.inputFingerprint,
      status: 'retryable', error: 'the isolated Agent job produced no artifact' })
    continue
  }
  const artifact = join(roots.artifacts, artifactName)
  try {
    const files = (await listFiles(artifact)).sort()
    const required = [
      'review/observations.json', 'review/recommendations.json',
      'batch/agent-launch.json', 'batch/agent-launch-result.json', 'batch/agent-monitor.json',
      'batch/agent-session-supervisor.json', 'batch/agent-provider.json',
      'batch/agent-reasoning-input.json', 'batch/agent-conclusion.json',
      'batch/summary.json', 'batch/state.json', 'batch/acceptance.json',
      'reuse/summary.json', 'reuse/state.json',
    ]
    if (required.some(path => !files.includes(path))) throw new Error('the isolated Agent artifact is incomplete')
    const [observations, recommendations, launch, launchResult, monitor, supervisor, provider,
      reasoningInput, conclusion, summary, batchState, acceptance, reuseSummary, reuseState] = await Promise.all([
      readJson(join(artifact, 'review/observations.json')),
      readJson(join(artifact, 'review/recommendations.json')),
      readJson(join(artifact, 'batch/agent-launch.json'), 16 * 1024),
      readJson(join(artifact, 'batch/agent-launch-result.json'), 16 * 1024),
      readJson(join(artifact, 'batch/agent-monitor.json'), 16 * 1024),
      readJson(join(artifact, 'batch/agent-session-supervisor.json'), 16 * 1024),
      readJson(join(artifact, 'batch/agent-provider.json'), 16 * 1024),
      readJson(join(artifact, 'batch/agent-reasoning-input.json'), 16 * 1024),
      readJson(join(artifact, 'batch/agent-conclusion.json'), 64 * 1024),
      readJson(join(artifact, 'batch/summary.json')),
      readJson(join(artifact, 'batch/state.json')),
      readJson(join(artifact, 'batch/acceptance.json'), 64 * 1024),
      readJson(join(artifact, 'reuse/summary.json')),
      readJson(join(artifact, 'reuse/state.json')),
    ])
    const dshObserved = observations?.targets?.['deepseek-harness']
    const pluginMatches = Object.values(observations?.targets ?? {})
      .filter(value => coordinateMatches(value, task.input.plugin))
    if (!coordinateMatches(dshObserved, task.input.dsh) || dshObserved?.package?.distTag !== task.dshChannel
      || pluginMatches.length !== 1) throw new Error('artifact observations do not match the persisted exact task input')
    const recommendation = recommendations?.entries?.find(item => item?.targetId === task.targetId
      && item?.plugin === `${task.input.plugin.name}@${task.input.plugin.version}`
      && item?.dshVersion === task.input.dsh.version)
    if (!recommendation || reasoningInput?.targetId !== task.targetId
      || recommendation.inputFingerprint !== reasoningInput.inputFingerprint) {
      throw new Error('artifact lacks the exact repository reasoning decision')
    }
    if (provider?.modelSecretsReachPluginContainers !== false || supervisor?.status !== 'closed'
      || supervisor?.targetId !== task.targetId || !Number.isSafeInteger(supervisor?.turns)
      || supervisor.turns < 1 || launch?.targetId !== task.targetId
      || supervisor.lastLaunchId !== launch.id || launchResult?.id !== launch.id
      || monitor?.launchId !== launch.id || conclusion?.activeLaunchId !== launch.id
      || conclusion?.targetId !== task.targetId || conclusion?.modelAuthored !== true
      || conclusion?.compatibilityPass !== false || typeof conclusion?.evidenceDigest !== 'string'
      || summary?.activeLaunchId !== launch.id || acceptance?.collectionClosed !== true
      || acceptance?.agentAttributionReceipt !== true || acceptance?.unchangedSecondBatchExecuted !== 0
      || reuseSummary?.executed !== 0
      || JSON.stringify(reuseState?.nativeLedger) !== JSON.stringify(batchState?.nativeLedger)
      || JSON.stringify(reuseState?.surfaceLedger) !== JSON.stringify(batchState?.surfaceLedger)
      || JSON.stringify(reuseState?.adapterLedger) !== JSON.stringify(batchState?.adapterLedger)) {
      throw new Error('artifact did not pass the exact closed-case and unchanged-reuse acceptance checks')
    }
    const reportFiles = files.filter(path => path.startsWith('batch/reports/') && path.endsWith('/report.json'))
    const executionReports = []
    for (const path of reportFiles.slice(0, 128)) {
      const report = await readJson(join(artifact, path), 4 * 1024 * 1024)
      executionReports.push({ path, probe: report.probe, caseId: report.caseId,
        plugin: report.plugin ?? report.artifact?.spec, dshVersion: report.dshVersion,
        plane: report.plane ?? 'headless', profile: report.profile ?? 'headless',
        runtime: report.runtime, profileEnvironment: report.profileEnvironment,
        stages: report.stages, result: report.result, reason: report.reason,
        commands: commandEvidence(report), boundary: report.boundary })
    }
    const actions = await providerActions(artifact, files)
    const durable = {
      schema: 'upstream-radar.dsh-active-analysis-report/v1alpha1',
      generatedAt: new Date().toISOString(),
      task: { id: task.id, inputFingerprint: task.inputFingerprint, trigger: task.trigger,
        targetId: task.targetId, dshChannel: task.dshChannel, input: task.input, attempts: task.attempts },
      github: { runId, runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? 'MicroMilo/upstream-radar'}/actions/runs/${runId}`,
        artifact: artifactName },
      recommendation,
      execution: { launch, launchResult, monitor, supervisor, provider, toolActions: actions,
        reports: executionReports, unchangedReuse: acceptance },
      outcome: { conclusion, summary,
        native: (batchState?.nativeLedger?.entries ?? []).filter(item => item?.targetId === task.targetId),
        surface: (batchState?.surfaceLedger?.entries ?? []).filter(item => String(item?.caseId ?? '').startsWith(`${task.targetId}-`)),
        adapter: (batchState?.adapterLedger?.entries ?? []).filter(item => item?.cell?.targetId === task.targetId),
        remainingBlocked: {
          native: summary?.nextNativePlan?.blocked ?? [],
          surface: summary?.nextSurfacePlan?.blocked ?? [],
          adapter: summary?.nextAdapterPlan?.blocked ?? [],
        } },
      artifactFiles: files,
    }
    const reportPath = join(roots.reports, `${task.id}.json`)
    await save(reportPath, durable)
    results.push({ taskId: task.id, inputFingerprint: task.inputFingerprint, status: 'completed',
      reportPath: relative(resolve(dirname(statePath), '..', '..', '..'), reportPath).replaceAll('\\', '/'),
      evidenceDigest: conclusion.evidenceDigest })
  } catch (error) {
    results.push({ taskId: task.id, inputFingerprint: task.inputFingerprint,
      status: 'retryable', error: String(error instanceof Error ? error.message : error).slice(0, 1_024) })
  }
}

const reconciled = reconcileDshActiveTaskResults(state, matrix, results, new Date(), runId)
await save(statePath, reconciled)
const durableReports = []
for (const task of reconciled.tasks.filter(item => item.status === 'completed')) {
  const report = await optionalJson(join(roots.reports, `${task.id}.json`), MAX_JSON_BYTES)
  if (report) durableReports.push(report)
}
const lines = ['# DSH active Agent analysis', '',
  'Every row is bound to exact plugin/DSH source and package identities. Completed means the analysis closed; it does not mean compatible.', '',
  '| Task | Plugin | DSH | Node / profile reasoning | Analysis outcome | GitHub run |',
  '| --- | --- | --- | --- | --- | --- |']
for (const report of durableReports.sort((left, right) => left.task.targetId.localeCompare(right.task.targetId))) {
  const recommendation = report.recommendation
  const environment = `${(recommendation.nodeMajors ?? []).map(value => `Node ${value}`).join(', ') || 'unknown'} / ${(recommendation.executionProfiles ?? []).join(', ') || 'unknown'}`
  const resultsSummary = [...(report.outcome.native ?? []), ...(report.outcome.surface ?? []), ...(report.outcome.adapter ?? [])]
    .map(item => item.result ?? item.report?.result).filter(Boolean)
  const outcome = [...new Set(resultsSummary)].join(', ') || 'coverage gap recorded'
  lines.push(`| \`${report.task.id}\` | \`${report.task.input.plugin.name}@${report.task.input.plugin.version}\` | \`${report.task.input.dsh.name}@${report.task.input.dsh.version}\` (\`${report.task.dshChannel}\`) | ${environment.replaceAll('|', '\\|')} | ${outcome.replaceAll('|', '\\|')} | [${report.github.runId}](${report.github.runUrl}) |`)
}
lines.push('', `Pending/retryable: ${reconciled.tasks.filter(task => task.status === 'pending').length}; completed: ${reconciled.tasks.filter(task => task.status === 'completed').length}.`, '')
await save(join(roots.reports, 'README.md'), `${lines.join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ results, pending: reconciled.tasks.filter(task => task.status === 'pending').length,
  completed: reconciled.tasks.filter(task => task.status === 'completed').length }, null, 2)}\n`)
