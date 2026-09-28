#!/usr/bin/env node
// Trusted operator process. Never run target code here; it launches the existing isolated batch worker.
import { execFile as callback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isDeepStrictEqual } from 'node:util'
import { createDshActiveCaseBroker } from '../dist/src/dsh-active-case-broker.js'
import { missingDshAuthorAdapterCoverage,
  unresolvedFreshDshBuildGateCaseIds } from '../dist/src/dsh-active-agent-supervisor.js'
import { resolveDshActiveCaseLaunchStatus } from '../dist/src/dsh-active-case-launch-state.js'
import { dshActiveCaseMonitorCovered, parseDshActiveCaseMonitorState, recordDshActiveCaseMonitorAction } from '../dist/src/dsh-active-case-monitor-state.js'
import { decideDshActiveBuildReview, prepareDshActiveBuildReview } from '../dist/src/dsh-active-build-review.js'
import { decideDshActiveSurfaceBuildReview, prepareDshActiveSurfaceBuildReview } from '../dist/src/dsh-active-surface-build-review.js'
import { createDshEnvironmentRecommendationInputFingerprint, DSH_ENVIRONMENT_REVIEW_CONTRACT,
  emptyDshEnvironmentRecommendations } from '../dist/src/dsh-environment-recommendation.js'
import { addDshActiveRepositoryEvidence, emptyDshActiveRepositoryEvidence, fetchDshActiveRepositoryDocument,
  fetchDshActiveRepositoryExcerpt,
  rebaseDshActiveRepositoryEvidenceReviewContract } from '../dist/src/dsh-active-repository-evidence.js'
import { dshBuildReviewEnvironment, emptyDshHeadlessAgentPlans, parseDshHeadlessAgentPlans } from '../dist/src/dsh-headless-agent-plan.js'
import { parseDshCompatibilityLedger } from '../dist/src/dsh-compatibility-ledger.js'
import { createDshSurfaceSourceFingerprint, dshSurfaceDependencyGraphBinding, parseDshSurfaceLedger } from '../dist/src/dsh-surface.js'
import { emptyDshSurfaceAgentPlans, parseDshSurfaceAgentPlans } from '../dist/src/dsh-surface-agent-plan.js'
import { redactDshExternalAuthPrompt } from '../dist/src/dsh-auth-redaction.js'
import { createDshActiveCaseConclusionReceipt,
  validateDshActiveCaseConclusionVersions } from '../dist/src/dsh-active-case-conclusion.js'
import { parseDshLiveProgressLine } from '../dist/src/dsh-live-progress.js'
import { inspectDshActiveRunningContainer, summarizeDshActiveLiveProgress } from '../dist/src/dsh-active-runtime-inspection.js'
import { observationNetworkEnvironment } from '../dist/src/dsh-observation-network.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ACTIVE_STATE_MAX_BYTES = 32 * 1024 * 1024 // Includes bounded exact adapter dependency graphs.
const [targetId, candidatesPath, targetsPath, observationsPath, reviewDirectory, outputDirectory, configPath, controlDirectory, consent] = process.argv.slice(2)
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId ?? '') || [candidatesPath, targetsPath, observationsPath,
  reviewDirectory, outputDirectory, configPath, controlDirectory].some(value => !value) || consent !== '--execute') {
  throw new Error('usage: dsh-active-case-broker.mjs <target-id> <candidates.json> <targets.json> <observations.json> <review-dir> <output-dir> <executor.json> <control-dir> --execute')
}
const execFile = promisify(callback)
const output = resolve(outputDirectory), review = resolve(reviewDirectory), control = resolve(controlDirectory)
async function readBytes(path, maximum = 256 * 1024) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('broker input is not a bounded regular file')
    const bytes = await file.readFile()
    if (bytes.length !== stat.size) throw new Error('broker input changed while reading')
    return bytes
  } finally { await file.close() }
}
const readJson = async (path, maximum) => JSON.parse((await readBytes(path, maximum)).toString('utf8'))
async function optionalJson(path, maximum) {
  try { return await readJson(path, maximum) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
async function save(path, value) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() }
  finally { await file.close() }
  await rename(temporary, destination)
}
async function regularDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('agent control path must be a regular directory')
}
for (const path of [control, join(control, 'requests'), join(control, 'responses'), output, review]) await regularDirectory(path)
const monitorPath = join(output, 'agent-monitor.json')
let monitor = parseDshActiveCaseMonitorState(await optionalJson(monitorPath, 4096), targetId)
await save(monitorPath, monitor)
const candidates = await readJson(candidatesPath, 4 * 1024 * 1024)
if (!Array.isArray(candidates) || candidates.length > 100) throw new Error('bounded candidate array required')
const baseCandidate = candidates.find(item => item.targetId === targetId)
if (!baseCandidate) throw new Error('the exact plugin lacks a collected repository candidate')
// The isolated batch reads observations from the review checkpoint, not from the
// broker CLI input. Materialize the exact input before the Agent can launch.
const observations = await readJson(observationsPath, 8 * 1024 * 1024)
const stagedObservationsPath = join(review, 'observations.json')
const stagedObservations = await optionalJson(stagedObservationsPath, 8 * 1024 * 1024)
if (stagedObservations === undefined) await save(stagedObservationsPath, observations)
else if (JSON.stringify(stagedObservations) !== JSON.stringify(observations)) {
  throw new Error('review checkpoint observations differ from the exact broker input; use a new review directory')
}
const observationCheckpointModifiedAt = (await lstat(stagedObservationsPath)).mtimeMs
const supplementalEvidencePath = join(review, 'agent-evidence.json')
const savedSupplementalEvidence = await optionalJson(supplementalEvidencePath, 2 * 1024 * 1024)
const evidenceRebase = rebaseDshActiveRepositoryEvidenceReviewContract(
  savedSupplementalEvidence ?? emptyDshActiveRepositoryEvidence(baseCandidate), baseCandidate)
let supplementalEvidence = evidenceRebase.state
if (evidenceRebase.migratedFrom !== undefined) {
  const migratedVersion = evidenceRebase.migratedFrom
    === createDshEnvironmentRecommendationInputFingerprint(baseCandidate, 'dsh-environment/v13') ? 'v13' : 'v12'
  const migrationPath = join(review, `agent-evidence-contract-migration-${migratedVersion}.json`)
  const priorMigration = await optionalJson(migrationPath, 2 * 1024 * 1024)
  if (priorMigration !== undefined
    && JSON.stringify(priorMigration.previousState) !== JSON.stringify(savedSupplementalEvidence)) {
    throw new Error('supplemental evidence migration history differs from the exact prior state')
  }
  await save(migrationPath, { schema: 'upstream-radar.dsh-active-evidence-contract-migration/v1alpha1',
    targetId, fromBaseInputFingerprint: evidenceRebase.migratedFrom,
    toBaseInputFingerprint: supplementalEvidence.baseInputFingerprint,
    sourceFingerprint: baseCandidate.sourceFingerprint, sourceCommit: baseCandidate.sourceCommit,
    previousState: savedSupplementalEvidence, migratedAt: new Date().toISOString() })
  await save(supplementalEvidencePath, supplementalEvidence)
}
let candidate = { ...baseCandidate, documents: [...baseCandidate.documents,
  ...supplementalEvidence.extraDocuments.map(({ path, text }) => ({ path, text }))] }
const installTargets = await readJson(targetsPath)
if (!Array.isArray(installTargets.plugins)) throw new Error('invalid install targets')
const scopedTargets = { ...installTargets, plugins: installTargets.plugins.filter(item => item.id === targetId) }
if (scopedTargets.plugins.length !== 1) throw new Error('the exact plugin must occur once in install targets')
const scopedTargetsPath = join(output, 'scoped-install-targets.json')
await save(scopedTargetsPath, scopedTargets)
const executor = await readJson(configPath)
if (Object.keys(executor).some(key => !['dockerContext', 'architecture', 'timeoutSeconds', 'maxTasks', 'networkProxy', 'recoveryNetworkProxy'].includes(key))) {
  throw new Error('active case executor has unsupported operator configuration')
}
observationNetworkEnvironment(executor.networkProxy)
observationNetworkEnvironment(executor.recoveryNetworkProxy)
const networkFingerprint = createHash('sha256').update(JSON.stringify(executor)).digest('hex')
const routePath = join(output, 'agent-network-route.json')
const activeExecutorPath = join(output, 'agent-executor.json')
const previousRoute = await optionalJson(routePath)
let networkRoute = previousRoute?.configFingerprint === networkFingerprint
  && ['direct', 'configured-proxy', 'recovery-proxy'].includes(previousRoute.route)
  ? previousRoute.route : executor.networkProxy ? 'configured-proxy' : 'direct'
function proxyFor(route) {
  if (route === 'direct') return undefined
  const value = route === 'configured-proxy' ? executor.networkProxy : executor.recoveryNetworkProxy
  if (!value) throw new Error('that network route was not preconfigured by the operator')
  return value
}
async function persistNetworkRoute(route) {
  const proxy = proxyFor(route)
  const prior = await optionalJson(routePath)
  const selectedAt = prior?.route === route && prior?.configFingerprint === networkFingerprint
    && Number.isFinite(Date.parse(prior.selectedAt)) ? prior.selectedAt : new Date().toISOString()
  await save(routePath, { targetId, route, configFingerprint: networkFingerprint, selectedAt })
  await save(activeExecutorPath, { dockerContext: executor.dockerContext, architecture: executor.architecture,
    timeoutSeconds: executor.timeoutSeconds, maxTasks: executor.maxTasks,
    ...(proxy === undefined ? {} : { networkProxy: proxy }) })
  networkRoute = route
  return { route, configured: proxy !== undefined, note: 'only operator-preconfigured transport was selected; artifact and dependency evidence will be re-keyed' }
}
await persistNetworkRoute(networkRoute)
const recommendationsPath = join(review, 'recommendations.json')
const buildPlansPath = join(review, 'build-plans.json')
const surfaceBuildPlansPath = join(review, 'surface-build-plans.json')
const conclusionPath = join(output, 'agent-conclusion.json')
const finalInspectionPath = join(output, 'agent-final-inspection.json')
const reasoningInputPath = join(output, 'agent-reasoning-input.json')
async function saveCurrentReasoningInput(value = candidate) {
  const inputFingerprint = createDshEnvironmentRecommendationInputFingerprint(value)
  await save(reasoningInputPath, { targetId, inputFingerprint })
  return inputFingerprint
}
let batchProcess, batchExit
const launchPath = join(output, 'agent-launch.json')
const launchResultPath = join(output, 'agent-launch-result.json')
async function activeLaunchView(running, summary) {
  const launch = await optionalJson(launchPath)
  const result = await optionalJson(launchResultPath)
  const status = resolveDshActiveCaseLaunchStatus({ running,
    launchId: launch?.id, summaryLaunchId: summary?.activeLaunchId,
    exitLaunchId: result?.id, exitCode: result?.exitCode })
  let failureHint
  const checkpointChangedSinceLaunch = (status === 'failed' || status === 'interrupted')
    && !summary && Number.isFinite(Date.parse(launch?.requestedAt ?? ''))
    && observationCheckpointModifiedAt > Date.parse(launch.requestedAt)
  if (status === 'failed' || status === 'interrupted') {
    const filename = launch?.log
    if (typeof filename === 'string' && /^agent-batch-[a-f0-9]{32}\.log$/.test(filename)) {
      let file
      try { file = await open(join(output, filename), constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (file) {
        try {
          const stat = await file.stat()
          if (!stat.isFile()) throw new Error('active launch log is not a regular file')
          const bytes = Buffer.alloc(Math.min(stat.size, 4096))
          if (bytes.length) await file.read(bytes, 0, bytes.length, stat.size - bytes.length)
          failureHint = redactDshExternalAuthPrompt(bytes.toString('utf8')
            .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 4096))
        } finally { await file.close() }
      }
    }
  }
  return { status, launchId: launch?.id, exitCode: result?.id === launch?.id ? result?.exitCode : undefined,
    ...(failureHint === undefined ? {} : { failureHint, failureHintTrust: 'untrusted-build-and-worker-log' }),
    ...(checkpointChangedSinceLaunch ? { recoveryHint: 'trusted broker staged the previously missing observation checkpoint after this failed launch; create a new launch to test whether preflight is now repaired',
      recoveryHintTrust: 'trusted-broker-checkpoint' } : {}),
    currentSummary: status === 'finished' ? summary : undefined }
}
async function batchRunning() {
  if (batchProcess && batchExit === undefined) return true
  const lock = await optionalJson(join(output, 'runner-lock.json'))
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 1) return false
  try { process.kill(lock.pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function progressEvents(expectedLaunchId) {
  if (typeof expectedLaunchId !== 'string' || !/^[a-f0-9]{32}$/.test(expectedLaunchId)) return []
  const reportsRoot = join(output, 'reports')
  const events = new Map()
  let files = 0
  async function visit(path, depth) {
    if (depth > 5) throw new Error('report hierarchy exceeded its bound')
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('agent watch never follows a report symlink')
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child, depth + 1)
      else if (entry.isFile() && entry.name === 'progress.jsonl') {
        if (++files > 64) throw new Error('agent watch report-file bound exceeded')
        // This exact file is append-only while the worker runs. Read the size
        // observed at open, not an unbounded readFile that races the next beat.
        const file = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW)
        let snapshot
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('progress file exceeds its regular-file bound')
          snapshot = Buffer.alloc(stat.size)
          let offset = 0
          while (offset < snapshot.length) {
            const read = await file.read(snapshot, offset, snapshot.length - offset, offset)
            if (read.bytesRead === 0) throw new Error('progress file changed before its observed prefix could be read')
            offset += read.bytesRead
          }
        } finally { await file.close() }
        const lines = snapshot.toString('utf8').split('\n')
        for (const line of lines) {
          if (!line) continue
          let raw
          try { raw = JSON.parse(line) } catch { continue }
          if (raw?.activeLaunchId !== expectedLaunchId) continue
          const event = parseDshLiveProgressLine(`RADAR_PROGRESS:${JSON.stringify(raw.event)}`, raw?.event?.caseId)
          if (event && event.caseId.startsWith(`${targetId}-`)) events.set(JSON.stringify(event), event)
        }
      }
    }
  }
  await visit(reportsRoot, 0)
  return [...events.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)
    || a.caseId.localeCompare(b.caseId) || a.elapsedMs - b.elapsedMs)
}
async function snapshot(cursor) {
  const state = await optionalJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const summary = await optionalJson(join(output, 'summary.json'), 2 * 1024 * 1024)
  const tasks = (state?.tasks ?? []).filter(task => task.cell?.targetId === targetId)
    .map(task => ({ key: task.key, kind: task.kind, caseId: task.cell.id, status: task.status,
      attempts: task.attempts, error: task.error,
      ...(task.status === 'running' ? { containerName: `radar-batch-${task.key.slice(0, 24)}-${task.attempts}` } : {}) }))
  const launch = await optionalJson(launchPath)
  const events = await progressEvents(launch?.id)
  const liveSignals = summarizeDshActiveLiveProgress(events,
    tasks.filter(task => task.status === 'running').map(task => task.caseId), new Date().toISOString())
  const running = await batchRunning()
  const active = await activeLaunchView(running, summary)
  return { cursor: Math.min(events.length, cursor + 16), totalEvents: events.length,
    events: events.slice(cursor, cursor + 16), status: active.status, launchId: active.launchId,
    tasks, liveSignals, tasksTrust: active.status === 'finished' ? 'current-launch-summary-backed-state'
      : 'durable-state-may-precede-current-launch',
    ...(active.exitCode === undefined ? {} : { exitCode: active.exitCode }),
    ...(active.failureHint === undefined ? {} : { failureHint: active.failureHint,
      failureHintTrust: active.failureHintTrust }),
    ...(active.recoveryHint === undefined ? {} : { recoveryHint: active.recoveryHint,
      recoveryHintTrust: active.recoveryHintTrust }),
    ...(active.currentSummary ? { summary: { executed: active.currentSummary.executed,
      failedTasks: active.currentSummary.failedTasks?.length,
      deferredTaskKeys: active.currentSummary.deferredTaskKeys?.length,
      nativeCells: active.currentSummary.nativeCells, surfaceCells: active.currentSummary.surfaceCells,
      adapterCells: active.currentSummary.adapterCells,
      nextNative: active.currentSummary.nextNativePlan?.matrix?.include?.length,
      nextSurface: active.currentSummary.nextSurfacePlan?.matrix?.include?.length,
      nextAdapter: active.currentSummary.nextAdapterPlan?.matrix?.include?.length,
      blockedNative: active.currentSummary.nextNativePlan?.blocked?.length,
      blockedSurface: active.currentSummary.nextSurfacePlan?.blocked?.length,
      blockedAdapter: active.currentSummary.nextAdapterPlan?.blocked?.length } } : {}) }
}
async function watch(cursor) {
  const deadline = Date.now() + 5000
  while (true) {
    const current = await snapshot(cursor)
    if (current.totalEvents > cursor || current.status !== 'running' || Date.now() >= deadline) return current
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
}
async function inspect(kind) {
  const state = await optionalJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const summary = await optionalJson(join(output, 'summary.json'), 2 * 1024 * 1024)
  const active = await activeLaunchView(await batchRunning(), summary)
  const runningTasks = (state?.tasks ?? []).filter(task => task.cell?.targetId === targetId
    && task.status === 'running' && (kind === undefined || task.kind === kind))
  const progress = await progressEvents(active.launchId)
  const liveSignals = summarizeDshActiveLiveProgress(progress,
    runningTasks.slice(0, 16).map(task => task.cell.id), new Date().toISOString())
  const liveHandles = await Promise.all(runningTasks.slice(0, 16).map(async task => {
    if (!/^[a-f0-9]{64}$/.test(task.key ?? '') || !Number.isSafeInteger(task.attempts)
      || task.attempts < 0 || task.attempts > 1000
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(task.cell?.id ?? '')) {
      throw new Error('running task has no exact bounded Docker handle')
    }
    const name = `radar-batch-${task.key.slice(0, 24)}-${task.attempts}`
    let container
    try {
      const observed = await execFile('docker', ['--context', executor.dockerContext, 'inspect', name],
        { timeout: 30_000, maxBuffer: 64 * 1024 })
      container = JSON.parse(observed.stdout)[0]
    } catch {
      return { caseId: task.cell.id, taskKey: task.key, containerName: name,
        status: 'inspection-unavailable', trust: 'diagnostic-incomplete',
        note: 'Docker inspect could not verify this exact handle; retry observation before changing route or stopping work' }
    }
    return inspectDshActiveRunningContainer(task, name, container, targetId)
  }))
  const safeStages = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([stage, result]) => [stage,
      result && typeof result === 'object' && typeof result.detail === 'string'
        ? { ...result, detail: redactDshExternalAuthPrompt(result.detail) } : result])) : value
  const entries = [
    ...(kind === undefined || kind === 'native' ? state?.nativeLedger?.entries ?? [] : []),
    ...(kind === undefined || kind === 'surface' ? state?.surfaceLedger?.entries ?? [] : []),
    ...(kind === undefined || kind === 'adapter' ? state?.adapterLedger?.entries ?? [] : []),
  ].filter(entry => entry.targetId === targetId || entry.cell?.targetId === targetId
    || (typeof entry.caseId === 'string' && entry.caseId.startsWith(`${targetId}-`))).slice(-32)
    .map(entry => ({ caseId: entry.caseId ?? entry.cell?.id,
      dshVersion: entry.dshVersion ?? entry.cell?.dshVersion ?? entry.report?.dshVersion,
      nodeMajor: entry.runtime?.nodeMajor ?? entry.cell?.nodeMajor ?? entry.report?.runtime?.nodeMajor,
      result: entry.result ?? entry.report?.result,
      reason: redactDshExternalAuthPrompt(entry.reason ?? entry.report?.reason ?? ''),
      stages: safeStages(entry.stages ?? entry.report?.stages),
      coverageGaps: entry.coverageGaps ?? entry.report?.coverageGaps,
      requiredDependencyBuilds: entry.requiredDependencyBuilds ?? entry.report?.requiredDependencyBuilds,
      approvedDependencyBuilds: entry.approvedDependencyBuilds ?? entry.report?.approvedDependencyBuilds,
      artifactSha256: entry.artifact?.sha256 ?? entry.report?.artifact?.sha256 }))
  const current = active.currentSummary
  if (kind === undefined && active.status === 'finished' && current && state && active.launchId) {
    const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary: current,
      nativeLedger: state.nativeLedger, surfaceLedger: state.surfaceLedger,
      adapterLedger: state.adapterLedger, executorIdentity: state.executorIdentity })).digest('hex')}`
    const counts = results => Object.fromEntries(results.reduce((seen, result) =>
      seen.set(result, (seen.get(result) ?? 0) + 1), new Map()))
    await save(finalInspectionPath, { targetId, activeLaunchId: active.launchId,
      evidenceDigest, inspectedAt: new Date().toISOString(),
      resultCounts: {
        native: counts((state.nativeLedger?.entries ?? []).filter(entry => entry.targetId === targetId).map(entry => entry.result)),
        surface: counts((state.surfaceLedger?.entries ?? []).filter(entry => entry.caseId?.startsWith(`${targetId}-`)).map(entry => entry.result)),
        adapter: counts((state.adapterLedger?.entries ?? []).filter(entry => entry.cell?.targetId === targetId).map(entry => entry.report?.result)),
      } })
  }
  return { status: active.status, launchId: active.launchId,
    ...(active.exitCode === undefined ? {} : { exitCode: active.exitCode }),
    ...(active.failureHint === undefined ? {} : { failureHint: active.failureHint,
      failureHintTrust: active.failureHintTrust }),
    ...(active.recoveryHint === undefined ? {} : { recoveryHint: active.recoveryHint,
      recoveryHintTrust: active.recoveryHintTrust }),
    summary: current ? { executed: current.executed, nativeCells: current.nativeCells,
      surfaceCells: current.surfaceCells, adapterCells: current.adapterCells,
      nextNative: current.nextNativePlan?.matrix?.include?.length,
      nextSurface: current.nextSurfacePlan?.matrix?.include?.length,
      nextAdapter: current.nextAdapterPlan?.matrix?.include?.length,
      blockedNative: current.nextNativePlan?.blocked?.length,
      blockedSurface: current.nextSurfacePlan?.blocked?.length,
      blockedAdapter: current.nextAdapterPlan?.blocked?.length,
      failedTasks: current.failedTasks?.length, deferredTaskKeys: current.deferredTaskKeys?.length } : undefined,
    entries, liveHandles, liveSignals,
    ...(runningTasks.length <= 16 ? {} : { liveHandleCoverageGap: 'more than 16 running handles; inspection is incomplete' }),
    entriesTrust: active.status === 'finished' ? 'current-launch-summary-backed-ledger'
      : 'durable-ledger-may-precede-current-launch' }
}
async function cancel(containerName, taskKey) {
  const state = await readJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const task = state.tasks?.find(item => item.key === taskKey && item.cell?.targetId === targetId && item.status === 'running')
  if (!task || containerName !== `radar-batch-${taskKey.slice(0, 24)}-${task.attempts}`) throw new Error('cancel requires the exact running case handle')
  const docker = args => execFile('docker', ['--context', executor.dockerContext, ...args], { timeout: 30_000, maxBuffer: 64 * 1024 })
  const container = JSON.parse((await docker(['inspect', containerName])).stdout)[0]
  const observed = inspectDshActiveRunningContainer(task, containerName, container, targetId)
  if (!observed.running) return { cancelled: false, reason: 'the exact worker is no longer running' }
  await docker(['kill', containerName])
  return { cancelled: true, containerName, taskKey, note: 'only the disposable worker was stopped; its bounded report remains a separate observation' }
}
function currentAuthorDshVersions(summary) {
  const scopes = summary?.authorScopes
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0]?.id !== targetId
    || scopes[0].recommendation?.inputFingerprint
      !== createDshEnvironmentRecommendationInputFingerprint(candidate)) {
    throw new Error('dependency-build review requires the current scoped repository recommendation')
  }
  const baselines = scopes[0].recommendation.authorEnvironment?.dshVersions
  if (!Array.isArray(baselines) || baselines.length > 16) {
    throw new Error('the current author DSH baseline list is not bounded')
  }
  return new Set([candidate.dshVersion, ...baselines.map(item => item.version)])
}
async function currentBuildCandidate(caseId) {
  const summary = await optionalJson(join(output, 'summary.json'), 2 * 1024 * 1024)
  const active = await activeLaunchView(await batchRunning(), summary)
  if (active.status !== 'finished' || !active.currentSummary) {
    throw new Error('dependency-build review waits for the exact current isolated batch to finish')
  }
  const allowedDshVersions = currentAuthorDshVersions(active.currentSummary)
  const launch = await readJson(launchPath)
  const state = await readJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const ledger = parseDshCompatibilityLedger(state.nativeLedger)
  const entry = ledger.entries.find(item => item.caseId === caseId && item.targetId === targetId
    && item.plugin === candidate.plugin && allowedDshVersions.has(item.dshVersion)
    && item.result === 'build-approval-required')
  if (!entry || entry.observedAt < launch.requestedAt || !entry.requiredDependencyBuilds?.length
    || !entry.artifact.sha256 || !/^[a-f0-9]{64}$/.test(entry.artifact.sha256)
    || !/^sha256:[a-f0-9]{64}$/.test(entry.resolution?.runtimeGraph?.digest ?? '')) {
    throw new Error('the exact current plugin artifact has no fresh isolated build gate and dependency-graph digest')
  }
  const buildManifest = candidate.publishedManifest ?? candidate.manifest
  return {
    caseId: entry.caseId, targetId, plugin: entry.plugin, dshVersion: entry.dshVersion,
    nodeMajor: entry.runtime.nodeMajor, executionEnvironment: dshBuildReviewEnvironment(entry),
    result: entry.result, reason: entry.reason,
    requiredDependencyBuilds: entry.requiredDependencyBuilds,
    previouslyApprovedBuilds: entry.approvedDependencyBuilds ?? [],
    artifactSha256: entry.artifact.sha256,
    ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
    ...(candidate.sourceCommit === undefined ? {} : { sourceCommit: candidate.sourceCommit }),
    ...(buildManifest === undefined ? {} : { manifest: buildManifest }),
    ...(entry.resolution === undefined ? {} : { dynamicEvidence: entry.resolution }),
    documents: candidate.documents,
    documentCoverageGaps: candidate.collectionGaps ?? [],
  }
}
async function reviewBuild(caseId) {
  const buildCandidate = await currentBuildCandidate(caseId)
  const previous = parseDshHeadlessAgentPlans(await optionalJson(buildPlansPath, 2 * 1024 * 1024)
    ?? emptyDshHeadlessAgentPlans())
  const prepared = prepareDshActiveBuildReview(previous, buildCandidate)
  await save(buildPlansPath, prepared.plans) // Persist task before model receives the build prompt.
  return { caseId, inputFingerprint: prepared.inputFingerprint, guidance: prepared.guidance,
    pending: true, observedBuilds: buildCandidate.requiredDependencyBuilds }
}
async function decideBuild(caseId, decision) {
  const buildCandidate = await currentBuildCandidate(caseId)
  const previous = await readJson(buildPlansPath, 2 * 1024 * 1024)
  const next = decideDshActiveBuildReview(previous, buildCandidate, decision)
  await save(buildPlansPath, next)
  const approved = next.entries.find(item => item.caseId === caseId)
  if (!approved) throw new Error('the exact dependency-build decision was not persisted')
  return { caseId, accepted: true, action: approved.action, approvedBuilds: approved.approvedBuilds,
    note: 'the next isolated launch will re-check the exact artifact and dependency-build gate' }
}
async function currentSurfaceBuildCandidate(caseId) {
  const summary = await optionalJson(join(output, 'summary.json'), 2 * 1024 * 1024)
  const active = await activeLaunchView(await batchRunning(), summary)
  if (active.status !== 'finished' || !active.currentSummary) {
    throw new Error('surface-build review waits for the exact current isolated batch to finish')
  }
  const allowedDshVersions = currentAuthorDshVersions(active.currentSummary)
  const launch = await readJson(launchPath)
  const state = await readJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const native = parseDshCompatibilityLedger(state.nativeLedger)
  const surface = parseDshSurfaceLedger(state.surfaceLedger)
  const entry = surface.entries.find(item => item.caseId === caseId && item.plugin === candidate.plugin
    && allowedDshVersions.has(item.dshVersion) && item.result === 'environment-unsupported')
  const source = native.entries.find(item => item.caseId === entry?.sourceCaseId && item.targetId === targetId)
  if (!entry || !source || entry.observedAt < launch.requestedAt
    || source.plugin !== entry.plugin || source.dshVersion !== entry.dshVersion
    || source.runtime.nodeMajor !== entry.runtime.nodeMajor
    || source.artifact.sha256 !== entry.artifact.sha256
    || createDshSurfaceSourceFingerprint(source) !== entry.sourceFingerprint
    || dshSurfaceDependencyGraphBinding(entry) === undefined
    || (entry.requiredDependencyBuilds?.length ?? 0) + (entry.hostBuildFailures?.length ?? 0) === 0) {
    throw new Error('the exact current Web/TUI cell lacks a fresh isolated build gate and graph-bound source artifact')
  }
  const hostBuild = entry.hostBuildInventory === undefined ? undefined : {
    inventory: entry.hostBuildInventory,
    failures: entry.hostBuildFailures ?? [],
    context: { caseId: entry.caseId, plugin: entry.plugin, artifactSha256: entry.artifact.sha256,
      sourceFingerprint: entry.sourceFingerprint, dshVersion: entry.dshVersion,
      plane: entry.plane, profile: entry.profile, runtime: entry.runtime,
      profileEnvironment: entry.profileEnvironment,
      ...(entry.startupConfiguration === undefined ? {} : { startupConfiguration: entry.startupConfiguration }) },
    ...(entry.hostBuildExecution?.status === 'command-completed' && entry.hostBuildExecution.bindingVerified
      ? { previousApproval: entry.hostBuildExecution.requestedApproval } : {}),
  }
  const buildManifest = candidate.publishedManifest ?? candidate.manifest
  return { caseId: entry.caseId, sourceCaseId: entry.sourceCaseId,
    plugin: entry.plugin, dshVersion: entry.dshVersion, nodeMajor: entry.runtime.nodeMajor,
    plane: entry.plane, profile: entry.profile, result: entry.result, reason: entry.reason,
    requiredDependencyBuilds: entry.requiredDependencyBuilds ?? [],
    previouslyApprovedBuilds: entry.approvedDependencyBuilds ?? [],
    sourceFingerprint: entry.sourceFingerprint, artifactSha256: entry.artifact.sha256,
    surfaceGraphDigest: dshSurfaceDependencyGraphBinding(entry).digest,
    surfaceGraphSource: dshSurfaceDependencyGraphBinding(entry).source,
    ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
    ...(candidate.sourceCommit === undefined ? {} : { sourceCommit: candidate.sourceCommit }),
    ...(buildManifest === undefined ? {} : { manifest: buildManifest }),
    dynamicEvidence: { stages: entry.stages, evidence: entry.evidence, reason: entry.reason,
      resolution: entry.resolution, hostBuildExecution: entry.hostBuildExecution },
    ...(hostBuild === undefined || (!hostBuild.failures.length && !hostBuild.previousApproval)
      ? {} : { hostBuild }),
    documents: candidate.documents }
}
async function reviewSurfaceBuild(caseId) {
  const buildCandidate = await currentSurfaceBuildCandidate(caseId)
  const previous = parseDshSurfaceAgentPlans(await optionalJson(surfaceBuildPlansPath, 2 * 1024 * 1024)
    ?? emptyDshSurfaceAgentPlans())
  const prepared = prepareDshActiveSurfaceBuildReview(previous, buildCandidate)
  await save(surfaceBuildPlansPath, prepared.plans) // Durable before the model receives the prompt.
  return { caseId, inputFingerprint: prepared.inputFingerprint, guidance: prepared.guidance,
    pending: true, observedBuilds: buildCandidate.requiredDependencyBuilds,
    observedHostBuilds: buildCandidate.hostBuild?.failures.map(item => item.packageSpec) ?? [] }
}
async function decideSurfaceBuild(caseId, decision) {
  const buildCandidate = await currentSurfaceBuildCandidate(caseId)
  const previous = await readJson(surfaceBuildPlansPath, 2 * 1024 * 1024)
  const next = decideDshActiveSurfaceBuildReview(previous, buildCandidate, decision)
  await save(surfaceBuildPlansPath, next)
  const approved = next.entries.find(item => item.caseId === caseId)
  if (!approved) throw new Error('the exact Web/TUI dependency-build decision was not persisted')
  return { caseId, accepted: true, action: approved.action, approvedBuilds: approved.approvedBuilds,
    approvedHostBuilds: approved.hostBuildApproval?.packages ?? [],
    note: 'the next isolated launch will re-check this exact Web/TUI build plan and artifact graph' }
}
async function conclude(input) {
  const summary = await readJson(join(output, 'summary.json'), 2 * 1024 * 1024)
  const reasoningInput = await readJson(reasoningInputPath, 4096)
  const recommendation = summary?.authorScopes?.find(scope => scope.id === targetId)?.recommendation
  const recommendations = await readJson(recommendationsPath, 4 * 1024 * 1024)
  const currentDecision = recommendations.entries.find(entry => entry.targetId === targetId
    && entry.inputFingerprint === reasoningInput.inputFingerprint && entry.status === 'recommended'
    && entry.reviewContract === DSH_ENVIRONMENT_REVIEW_CONTRACT)
  const decisionFields = ['sourceFingerprint', 'preferredNodeMajor', 'nodeMajors', 'executionProfiles',
    'authorEnvironment', 'coverageGaps', 'summary', 'evidence']
  if (reasoningInput.targetId !== targetId
    || reasoningInput.inputFingerprint !== createDshEnvironmentRecommendationInputFingerprint(candidate)
    || summary?.authorScopes?.length !== 1
    || recommendation?.inputFingerprint !== reasoningInput.inputFingerprint
    || !currentDecision
    || decisionFields.some(field => !isDeepStrictEqual(recommendation?.[field], currentDecision[field]))
    || recommendations.pendingTasks.some(task => task.targetId === targetId)) {
    throw new Error('the Agent must re-review and relaunch after its repository reasoning input changed')
  }
  const active = await activeLaunchView(await batchRunning(), summary)
  if (active.status !== 'finished' || !active.currentSummary) {
    throw new Error('the Agent may conclude only after this exact isolated batch has finished')
  }
  const launch = await readJson(launchPath)
  const selectedRoute = await readJson(routePath)
  if (selectedRoute.targetId !== targetId || selectedRoute.route !== networkRoute
    || !Number.isFinite(Date.parse(selectedRoute.selectedAt))
    || Date.parse(selectedRoute.selectedAt) > Date.parse(launch.requestedAt)) {
    throw new Error('the Agent must fresh launch after selecting a different operator-preconfigured network route; old artifact and dependency evidence cannot certify the new route')
  }
  const launchResult = await optionalJson(launchResultPath)
  if (summary.executed > 0 && (launchResult?.id !== launch.id
    || !dshActiveCaseMonitorCovered(monitor, launch.id, launchResult.finishedAt, 45_000))) {
    throw new Error('the Agent cannot conclude an executed case without repeated live observation through its exact finish')
  }
  const state = await readJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const artifactUnavailable = (state.nativeLedger?.entries ?? []).filter(entry => entry.targetId === targetId
    && entry.result === 'unknown'
    && entry.reason === 'the exact npm artifact could not be established before execution')
  if (networkRoute === 'configured-proxy' && artifactUnavailable.length > 0) {
    throw new Error('the configured proxy could not establish the exact npm artifact: use action=network route=direct and a fresh launch before concluding coverage; unknown is not a compatibility result')
  }
  const missingAuthorAdapters = missingDshAuthorAdapterCoverage(targetId, summary, state)
  if (missingAuthorAdapters.length > 0
    && !summary.nextAdapterPlan?.blocked?.some(entry => entry.targetId === targetId)) {
    throw new Error(`author adapter evidence is incomplete: ${missingAuthorAdapters.join(', ')}. A native headless install cannot substitute for the author adapter; repair the exact planner and launch independent cells before conclude`)
  }
  const nativeGates = (state.nativeLedger?.entries ?? []).filter(entry => entry.targetId === targetId
    && entry.result === 'build-approval-required' && Array.isArray(entry.requiredDependencyBuilds)
    && entry.requiredDependencyBuilds.length > 0)
  const buildPlans = await optionalJson(buildPlansPath, 2 * 1024 * 1024)
  const unresolvedNativeGates = nativeGates.filter(entry => !buildPlans?.entries?.some(plan =>
    plan.caseId === entry.caseId && plan.targetId === targetId && plan.action === 'stop-headless'
    && plan.artifactSha256 === entry.artifact?.sha256
    && plan.dependencyGraphDigest === entry.resolution?.runtimeGraph?.digest
    && JSON.stringify(plan.observedRequiredBuilds) === JSON.stringify(entry.requiredDependencyBuilds)))
  if (unresolvedNativeGates.length > 0) {
    throw new Error(`accepted worker tasks are not compatible results: native dependency-build gate(s) ${unresolvedNativeGates.map(entry => entry.caseId).join(', ')} need build-review/build decisions, then a fresh launch or an exact graph-bound stop-headless decision before conclude`)
  }
  const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary,
    nativeLedger: state.nativeLedger, surfaceLedger: state.surfaceLedger,
    adapterLedger: state.adapterLedger, executorIdentity: state.executorIdentity })).digest('hex')}`
  const finalInspection = await optionalJson(finalInspectionPath, 16 * 1024)
  if (finalInspection?.targetId !== targetId || finalInspection.activeLaunchId !== launch.id
    || finalInspection.evidenceDigest !== evidenceDigest) {
    throw new Error('the Agent must inspect this exact finished launch and read native/surface/adapter ledger results before conclude; task=accepted is not compatibility proof')
  }
  const firstClause = String(input?.statement ?? '').split(/[。；;，,]/, 1)[0]
  const unqualifiedAllPassed = /^(?:all\b|全部|所有|整体).{0,48}(?:passed|compatible|通过|兼容|成功)/i.test(firstClause)
    && !/(?:不兼容|未通过|失败|未能|failed|incompatible|not compatible)/i.test(firstClause)
  if (Object.values(finalInspection.resultCounts ?? {}).some(counts =>
    Object.entries(counts ?? {}).some(([result, count]) =>
      result !== 'compatible' && result !== 'initialize-compatible' && count > 0))
    && unqualifiedAllPassed) {
    throw new Error('the Agent statement claims all results passed although the inspected exact ledger has non-compatible results; correct the per-plane attribution')
  }
  const inspectedDshVersions = [
    ...(state.nativeLedger?.entries ?? []).filter(entry => entry.targetId === targetId),
    ...(state.surfaceLedger?.entries ?? []).filter(entry => entry.caseId?.startsWith(`${targetId}-`)),
    ...(state.adapterLedger?.entries ?? []).filter(entry => entry.cell?.targetId === targetId),
  ].map(entry => entry.dshVersion ?? entry.cell?.dshVersion ?? entry.report?.dshVersion)
  validateDshActiveCaseConclusionVersions(input?.statement, inspectedDshVersions)
  const receipt = createDshActiveCaseConclusionReceipt(targetId, launch.id, evidenceDigest, input)
  await save(conclusionPath, receipt)
  return { accepted: true, activeLaunchId: receipt.activeLaunchId, evidenceDigest,
    modelAuthored: true, compatibilityPass: false }
}
let broker
async function addEvidence({ path, offset }) {
  const collected = candidate.documents.find(document => {
    if (offset === undefined) return document.path === path
    if (!document.path.startsWith(`${path}#bytes=`)) return false
    const start = Number(document.path.slice(`${path}#bytes=`.length).split('-')[0])
    return Number.isSafeInteger(start) && start >= offset && start <= offset + 3
  })
  if (collected) return { path: collected.path, text: collected.text,
    inputFingerprint: createDshEnvironmentRecommendationInputFingerprint(candidate),
    alreadyCollected: true, pendingReview: false,
    note: 'this exact pinned file or byte range was already in the bounded review input; its fingerprint did not change' }
  if (await batchRunning()) throw new Error('supplemental repository evidence cannot change while this isolated batch is running')
  const fetched = offset === undefined
    ? await fetchDshActiveRepositoryDocument(candidate, path)
    : await fetchDshActiveRepositoryExcerpt(candidate, path, offset)
  const next = addDshActiveRepositoryEvidence(supplementalEvidence, baseCandidate, fetched)
  await saveCurrentReasoningInput(next.candidate) // Invalidate old conclusions before publishing the new document.
  await save(supplementalEvidencePath, next.state)
  supplementalEvidence = next.state
  candidate = next.candidate
  broker = await makeBroker()
  await broker.initialize() // New exact input must have a durable task before returning to the model.
  return { path: fetched.path, text: fetched.text,
    ...(offset === undefined ? {} : { sourcePath: fetched.sourcePath,
      totalBytes: fetched.totalBytes, startByte: fetched.startByte, endByte: fetched.endByte }),
    inputFingerprint: next.inputFingerprint,
    pendingReview: true, note: 'the preceding Node/profile conclusion is stale; call review and recommend again' }
}
async function resetUnobservedExecutionBeforeRetry() {
  const previousLaunch = await optionalJson(launchPath, 4096)
  const previousResult = await optionalJson(launchResultPath, 4096)
  const previousSummary = await optionalJson(join(output, 'summary.json'), 2 * 1024 * 1024)
  if (!previousLaunch || !previousResult || !previousSummary
    || previousLaunch.id !== previousResult.id
    || previousSummary?.activeLaunchId !== previousLaunch?.id
    || !Number.isSafeInteger(previousSummary.executed) || previousSummary.executed < 1
    || typeof previousResult.finishedAt !== 'string'
    || dshActiveCaseMonitorCovered(monitor, previousLaunch.id, previousResult.finishedAt, 45_000)) return false
  // A zero-execution reuse of unobserved reports would fake proactive coverage.
  // Move the old exact state and cached reports to a recoverable archive, then
  // require the next launch to really execute each intended cell again.
  const history = join(output, 'agent-history')
  await mkdir(history, { recursive: true, mode: 0o700 })
  const historyStat = await lstat(history)
  if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) {
    throw new Error('unobserved case history is not a regular directory')
  }
  const archive = join(history, `unobserved-${previousLaunch.id}`)
  await mkdir(archive, { mode: 0o700, recursive: false })
  await save(join(archive, 'agent-launch.json'), previousLaunch)
  await save(join(archive, 'agent-launch-result.json'), previousResult)
  await save(join(archive, 'agent-monitor.json'), monitor)
  await save(join(archive, 'summary.json'), previousSummary)
  await readJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
  const reportsPath = join(output, 'reports')
  const reportsStat = await lstat(reportsPath)
  if (!reportsStat.isDirectory() || reportsStat.isSymbolicLink()) {
    throw new Error('unobserved case reports are not a regular directory; inspect before retry')
  }
  await rename(join(output, 'state.json'), join(archive, 'state.json'))
  await rename(reportsPath, join(archive, 'reports'))
  await save(join(archive, 'coverage-reset.json'), { targetId, previousLaunchId: previousLaunch.id,
    reason: 'the active Agent did not observe its executed launch through the exact finish; cached reports cannot certify a new proactive run',
    resetAt: new Date().toISOString() })
  return true
}
async function makeBroker() { return createDshActiveCaseBroker({ candidate,
  state: await optionalJson(recommendationsPath, 4 * 1024 * 1024) ?? emptyDshEnvironmentRecommendations(),
  save: state => save(recommendationsPath, state),
  fetchEvidence: addEvidence,
  selectNetworkRoute: async route => {
    if (await batchRunning()) throw new Error('network route cannot change while an isolated batch is running')
    return persistNetworkRoute(route)
  },
  launch: async () => {
    if (await batchRunning()) return { started: false, status: 'running' }
    const previousLaunch = await optionalJson(launchPath, 4096)
    if (previousLaunch) {
      const previousResult = await optionalJson(launchResultPath, 4096)
      const previousSummary = await optionalJson(join(output, 'summary.json'), 2 * 1024 * 1024)
      if (previousResult?.id !== previousLaunch.id || previousSummary?.activeLaunchId !== previousLaunch.id) {
        throw new Error('the previous isolated launch has not produced its exact terminal state; watch before relaunch')
      }
      const previousState = await readJson(join(output, 'state.json'), ACTIVE_STATE_MAX_BYTES)
      const unresolvedGates = unresolvedFreshDshBuildGateCaseIds(targetId, previousState,
        await optionalJson(buildPlansPath, 2 * 1024 * 1024), previousLaunch.requestedAt)
      if (unresolvedGates.length > 0) {
        throw new Error(`resolve every fresh native dependency-build gate before relaunch: ${unresolvedGates.join(', ')}; call build-review/build for each exact caseId`)
      }
    }
    const replayRequired = await resetUnobservedExecutionBeforeRetry()
    const id = randomUUID().replace(/-/g, '')
    const logName = `agent-batch-${id}.log`
    await save(launchPath, { id, targetId, requestedAt: new Date().toISOString(), log: logName })
    const log = await open(join(output, logName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    batchExit = undefined
    const command = spawn(process.execPath, [join(ROOT, 'scripts/run-dsh-compatibility-batch.mjs'), scopedTargetsPath,
      review, output, activeExecutorPath, '--execute'], { cwd: ROOT, stdio: ['ignore', log.fd, log.fd], shell: false,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GITHUB_TOKEN'
        && !/^(?:OPENAI|CODEX|ISSUE_LOCATOR_LLM)/.test(key))),
        RADAR_ACTIVE_LAUNCH_ID: id } })
    batchProcess = command
    let launchError
    command.once('error', error => { launchError = String(error).slice(0, 512) })
    command.once('close', code => {
      batchExit = code ?? -1
      void log.close()
      void save(launchResultPath, { id, exitCode: batchExit, finishedAt: new Date().toISOString(),
        ...(launchError === undefined ? {} : { launchError }) }).catch(error => {
        process.stderr.write(`active case launch result persistence failed: ${String(error).slice(0, 512)}\n`)
      })
    })
    return { started: true, status: 'running', launchId: id, pid: command.pid,
      ...(replayRequired ? { replayReason: 'previous executed launch was not actively observed through finish; its state and cached reports were archived for a real fresh replay' } : {}) }
  }, watch, inspect, cancel, reviewBuild, decideBuild, reviewSurfaceBuild, decideSurfaceBuild, conclude }) }
broker = await makeBroker()
await saveCurrentReasoningInput()
await broker.initialize() // Persist the analysis task before the YOLO container is dispatched.
let stopping = false
process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })
let served = 0
while (!stopping && served < 2000) {
  const requests = (await readdir(join(control, 'requests'), { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^[a-f0-9]{32}\.json$/.test(entry.name)).slice(0, 32)
  if (requests.length === 0) { await new Promise(resolveWait => setTimeout(resolveWait, 100)); continue }
  for (const entry of requests) {
    const path = join(control, 'requests', entry.name)
    let request, response
    try {
      request = await readJson(path, 64 * 1024)
      const value = await broker.handle(request)
      response = { id: request.id, ok: true, value }
      const updated = recordDshActiveCaseMonitorAction(monitor, request.action, value)
      if (updated !== monitor) {
        monitor = updated
        await save(monitorPath, monitor)
      }
    } catch (error) {
      response = { id: entry.name.slice(0, 32), ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 1024) }
    }
    if (Buffer.byteLength(JSON.stringify(response)) > 512 * 1024) response = { id: response.id, ok: false, error: 'broker response exceeded its byte budget' }
    await save(join(control, 'responses', entry.name), response)
    await unlink(path)
    served += 1
  }
}
