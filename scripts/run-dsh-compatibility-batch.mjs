#!/usr/bin/env node
import { execFile as callback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runDshCompatibilityBatch } from '../dist/src/dsh-batch.js'
import { dshBatchContainerArguments, dshBatchDockerObjectAbsent } from '../dist/src/dsh-batch-executor.js'
import { applyDshEnvironmentRecommendations } from '../dist/src/dsh-environment-recommendation.js'
import { selectDshProfileEnvironment } from '../dist/src/dsh-profile-environment.js'
import { buildDshCompatibilityIR } from '../dist/src/dsh-compatibility-ir.js'
import { buildDshSurfaceIR } from '../dist/src/dsh-surface.js'
import { observationNetworkEnvironment } from '../dist/src/dsh-observation-network.js'

const execFile = promisify(callback)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [targetsPath, reviewDirectory, outputDirectory, configPath, consent] = process.argv.slice(2)
if (!targetsPath || !reviewDirectory || !outputDirectory || !configPath || consent !== '--execute') {
  throw new Error('usage: run-dsh-compatibility-batch.mjs <install-targets.json> <review-directory> <output-directory> <executor.json> --execute')
}
const output = resolve(outputDirectory)
const digest = value => createHash('sha256').update(value).digest('hex')
async function readBytes(path, maximum = 64 * 1024 * 1024) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maximum) throw new Error('input is not a bounded regular file')
    const bytes = await handle.readFile()
    if (bytes.length !== metadata.size) throw new Error('input changed while reading')
    return bytes
  } finally { await handle.close() }
}
const readJson = async path => JSON.parse((await readBytes(path)).toString('utf8'))
async function optionalJson(path) {
  try { return await readJson(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
async function save(path, value) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, destination)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

const config = await readJson(configPath)
if (Object.keys(config).some(key => !['dockerContext', 'architecture', 'timeoutSeconds', 'maxTasks', 'networkProxy'].includes(key))
  || typeof config.dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(config.dockerContext)
  || !['arm64', 'x64'].includes(config.architecture)
  || !Number.isSafeInteger(config.timeoutSeconds) || config.timeoutSeconds < 30 || config.timeoutSeconds > 600
  || !Number.isSafeInteger(config.maxTasks) || config.maxTasks < 1 || config.maxTasks > 100) throw new Error('invalid operator-owned batch executor configuration')
const transport = observationNetworkEnvironment(config.networkProxy)
const docker = (args, timeout = 30_000) => execFile('docker', ['--context', config.dockerContext, ...args], {
  cwd: ROOT, timeout, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8',
})
await mkdir(output, { recursive: true })
const lockPath = join(output, 'runner-lock.json')
let lock
try { lock = await open(lockPath, 'wx', 0o600) }
catch (error) {
  if (error.code !== 'EEXIST') throw error
  const previous = await readJson(lockPath)
  if (!Number.isSafeInteger(previous.pid) || previous.pid <= 1) throw new Error('invalid batch runner lock; inspect before recovering')
  try { process.kill(previous.pid, 0); throw new Error(`batch runner process ${previous.pid} is still live; do not start another runner`) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
  await unlink(lockPath)
  lock = await open(lockPath, 'wx', 0o600)
}
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
await lock.close()

try {
  const installTargets = await readJson(targetsPath)
  const observations = await readJson(join(reviewDirectory, 'observations.json'))
  const recommendations = await readJson(join(reviewDirectory, 'recommendations.json'))
  const buildPlans = await optionalJson(join(reviewDirectory, 'build-plans.json'))
  const applied = applyDshEnvironmentRecommendations(installTargets, observations, recommendations)
  const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout)
  const architecture = ['aarch64', 'arm64'].includes(info.Architecture) ? 'arm64' : info.Architecture === 'x86_64' ? 'x64' : info.Architecture
  if (info.OSType !== 'linux' || architecture !== config.architecture) throw new Error('Docker daemon does not match the declared isolated runtime')
  const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'docker/dsh-surface-observer.Dockerfile']
  async function collectSource(path) {
    for (const entry of await readdir(join(ROOT, path), { withFileTypes: true })) {
      if (sourceFiles.length >= 2048 || entry.isSymbolicLink()) throw new Error('scanner build input is not a bounded regular source tree')
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) await collectSource(child)
      else if (entry.isFile()) sourceFiles.push(child)
    }
  }
  await collectSource('src')
  const sourceIdentity = digest(JSON.stringify(await Promise.all(sourceFiles.sort().map(async path => [path, digest(await readBytes(join(ROOT, path), 2 * 1024 * 1024))]))))
  const imageEnvironments = new Map()
  for (const target of applied.plugins) {
    if (!target.environmentRecommendation) continue
    for (const runtimeId of target.runtimeProfiles ?? []) {
      const nodeMajor = applied.runtimeProfiles.find(item => item.id === runtimeId)?.nodeMajor
      for (const profile of ['headless', 'web', ...target.environmentRecommendation.authorEnvironment.workflows
        .map(item => item.profile ?? (item.kind === 'sdk' || item.kind === 'acp' ? `dsh-lark-${item.kind}` : item.kind))]) {
        try {
          const { pnpmVersion } = selectDshProfileEnvironment(target.environmentRecommendation.authorEnvironment, profile)
          imageEnvironments.set(`${nodeMajor}:${pnpmVersion}`, { nodeMajor, pnpmVersion })
        } catch { /* The planner retains unsupported requirements as explicit gaps. */ }
      }
    }
  }
  if (imageEnvironments.size > 32) throw new Error('batch requires more than 32 isolated executor images')
  const images = new Map()
  for (const [key, environment] of imageEnvironments) {
    const tag = `upstream-radar-rebuild:${sourceIdentity.slice(0, 16)}-node${environment.nodeMajor}-pnpm${environment.pnpmVersion}`
    let inspected
    try { inspected = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0] }
    catch (error) { if (!dshBatchDockerObjectAbsent(error)) throw error }
    if (!inspected) {
      process.stdout.write(`building ${key}\n`)
      const result = await docker(['build', '--file', 'docker/dsh-surface-observer.Dockerfile',
        ...Object.entries(transport).filter(([name]) => /^(?:http|https)_proxy$/i.test(name)).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
        '--build-arg', `NODE_MAJOR=${environment.nodeMajor}`, '--build-arg', `PNPM_VERSION=${environment.pnpmVersion}`,
        '--label', `upstream-radar.scanner-source=${sourceIdentity}`, '--tag', tag, '.'], 900_000)
      await save(join(output, `build-node${environment.nodeMajor}-pnpm${environment.pnpmVersion}.log`), Buffer.from(`${result.stdout}\n${result.stderr}`))
      inspected = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0]
    }
    if (inspected.Config?.Labels?.['upstream-radar.scanner-source'] !== sourceIdentity || inspected.Architecture !== config.architecture.replace('x64', 'amd64')) throw new Error('executor image does not match scanner source and architecture')
    images.set(key, { ...environment, id: inspected.Id, tag })
    process.stdout.write(`ready ${key}: ${inspected.Id}\n`)
  }
  const executorIdentity = digest(JSON.stringify({ images: [...images], config, sourceIdentity }))
  await save(join(output, 'executor-evidence.json'), { sourceIdentity, executorIdentity, dockerContext: config.dockerContext,
    runtime: { platform: 'linux', architecture }, images: [...images.values()], hostMounts: [], inheritedHostCredentials: false })
  const statePath = join(output, 'state.json')
  async function inspectManaged(name, key) {
    let item
    try { item = JSON.parse((await docker(['inspect', name])).stdout)[0] }
    catch (error) { if (dshBatchDockerObjectAbsent(error)) return undefined; throw error }
    if (item.Config?.Labels?.['upstream-radar.task'] !== key || item.Mounts?.length > 0
      || item.HostConfig?.Privileged || item.HostConfig?.NetworkMode === 'host' || item.Config?.User !== '10001:10001'
      || item.HostConfig?.ReadonlyRootfs !== true) throw new Error('container ownership or isolation verification failed')
    return item
  }
  const result = await runDshCompatibilityBatch({ installTargets, observations, recommendations, buildPlans,
    state: await optionalJson(statePath), runtime: { platform: 'linux', architecture }, executorIdentity, maxTasks: config.maxTasks,
    checkpoint: async state => { await save(statePath, state) },
    execute: async task => {
      const { cell } = task
      const image = images.get(`${cell.nodeMajor}:${cell.profileEnvironment.pnpmVersion}`)
      if (!image) throw new Error('no exact executor image is available for the planned environment')
      const directory = join(output, 'reports', task.kind, cell.id, `${task.key}-${task.attempts}`)
      const reportPath = join(directory, 'report.json')
      const cached = await optionalJson(reportPath)
      if (cached) return cached // Crash after collection but before the ledger checkpoint.
      const name = `radar-batch-${task.key.slice(0, 24)}-${task.attempts}`
      process.stdout.write(`started ${task.kind} ${cell.id}: ${cell.plugin}\n`)
      let current = await inspectManaged(name, task.key)
      if (!current) {
        await docker(dshBatchContainerArguments({ name, key: task.key, image: image.id, kind: task.kind, cell,
          timeoutSeconds: config.timeoutSeconds, networkProxy: config.networkProxy }))
        current = await inspectManaged(name, task.key)
      }
      if (current.State.Status === 'created') await docker(['start', name])
      // A running saved handle is resumed, never duplicated because an observation timed out.
      try { await docker(['wait', name], (config.timeoutSeconds * 8 + 60) * 1000) }
      catch (error) {
        current = await inspectManaged(name, task.key)
        if (current?.State.Running) await docker(['stop', '--time', '2', name])
        await save(join(directory, 'runner-error.json'), { message: String(error).slice(0, 2048) })
      }
      current = await inspectManaged(name, task.key)
      const logs = await docker(['logs', name])
      await save(join(directory, 'container.json'), { id: current.Id, image: current.Image, state: current.State,
        user: current.Config.User, mounts: current.Mounts, readonlyRootfs: current.HostConfig.ReadonlyRootfs })
      await save(join(directory, 'stderr.log'), Buffer.from(logs.stderr))
      const collected = JSON.parse(logs.stdout)
      if (!collected.report || !Array.isArray(collected.attachments) || collected.attachments.length > 4) throw new Error('invalid bounded executor response')
      let bytes = 0
      const attachments = []
      for (const attachment of collected.attachments) {
        if (typeof attachment.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(attachment.name)
          || typeof attachment.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.base64)) throw new Error('invalid exported attachment')
        const data = Buffer.from(attachment.base64, 'base64')
        bytes += data.length
        if (bytes > 8 * 1024 * 1024) throw new Error('exported evidence exceeds its byte budget')
        await save(join(directory, attachment.name), data)
        attachments.push({ name: attachment.name, sha256: digest(data), bytes: data.length })
      }
      await save(join(directory, 'attachments.json'), { attachments, gaps: collected.attachmentGaps })
      await save(reportPath, collected.report)
      // Exact owned container is terminal; reports and attachments remain recoverable.
      if (!(await inspectManaged(name, task.key)).State.Running) await docker(['rm', name])
      process.stdout.write(`finished ${task.kind} ${cell.id}: ${collected.report.result}; ${collected.report.reason}\n`)
      return collected.report
    },
  })
  await save(join(output, 'compatibility-ledger.json'), result.state.nativeLedger)
  await save(join(output, 'surface-ledger.json'), result.state.surfaceLedger)
  await save(join(output, 'adapter-ledger.json'), result.state.adapterLedger)
  await save(join(output, 'compatibility-ir.json'), buildDshCompatibilityIR(result.state.nativeLedger))
  await save(join(output, 'surface-ir.json'), buildDshSurfaceIR(result.state.surfaceLedger))
  const summary = { executed: result.executed, nativeCells: result.state.nativeLedger.entries.length,
    surfaceCells: result.state.surfaceLedger.entries.length, adapterCells: result.state.adapterLedger.entries.length,
    nextNativePlan: result.nextNativePlan, nextSurfacePlan: result.nextSurfacePlan, nextAdapterPlan: result.nextAdapterPlan,
    failedTasks: result.state.tasks.filter(task => task.status === 'failed').map(({ key, kind, cell, error }) => ({ key, kind, id: cell.id, error })),
    orphanedRunningTasks: result.orphanedRunningTasks, transitions: result.transitions,
    authorScopes: applied.plugins.map(target => ({ id: target.id, recommendation: target.environmentRecommendation })),
    adapterScopes: result.state.adapterLedger.entries.map(({ cell, report }) => ({ id: cell.id, plugin: cell.plugin,
      dshVersion: cell.dshVersion, versionRole: cell.versionRole, nodeMajor: cell.nodeMajor, adapter: cell.adapter,
      profileEnvironment: cell.profileEnvironment, artifact: report.artifact, result: report.result, stages: report.stages,
      applicationGraphDigest: report.applicationGraph?.digest, profileGraphDigest: report.profileGraph?.digest,
      coverageGaps: report.coverageGaps, reason: report.reason })),
    unimplementedChecks: ['exact browser peer package versions', 'authenticated integrations and user tasks beyond bounded profile initialization'],
    note: 'Completed collection is not a global compatibility pass; inspect each result and its remaining coverage gaps.' }
  await save(join(output, 'summary.json'), summary)
  process.stdout.write(`${JSON.stringify({ executed: summary.executed, nativeCells: summary.nativeCells, surfaceCells: summary.surfaceCells,
    adapterCells: summary.adapterCells, failedTasks: summary.failedTasks.length, nextNative: summary.nextNativePlan.matrix.include.length,
    nextSurface: summary.nextSurfacePlan.matrix.include.length, nextAdapter: summary.nextAdapterPlan.matrix.include.length })}\n`)
  if (summary.failedTasks.length || summary.orphanedRunningTasks.length || summary.nextNativePlan.blocked.length
    || summary.nextSurfacePlan.blocked.length || summary.nextAdapterPlan.blocked.length) process.exitCode = 2
} finally { await unlink(lockPath) }
