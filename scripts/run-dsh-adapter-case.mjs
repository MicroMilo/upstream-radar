#!/usr/bin/env node
// One scheduled job in a disposable VM. The durable batch runner remains the
// entry point for attaching to interrupted work in a persistent executor.
import { execFile as callback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { emptyDshAdapterLedger, mergeDshAdapterLedger, parseDshAdapterExpectedCase } from '../dist/src/dsh-adapter.js'
import { dshBatchContainerArguments } from '../dist/src/dsh-batch-executor.js'
import { observationNetworkEnvironment } from '../dist/src/dsh-observation-network.js'

const execFile = promisify(callback), root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [casePath, outputPath, configPath, consent] = process.argv.slice(2)
if (!casePath || !outputPath || !configPath || consent !== '--execute' || process.argv.length !== 6) {
  throw new Error('usage: run-dsh-adapter-case.mjs <expected-case> <new-output-directory> <executor-config> --execute')
}
async function json(path) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('adapter job input is not a bounded regular file')
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size) throw new Error('adapter job input changed while reading')
    return JSON.parse(bytes.toString('utf8'))
  } finally { await handle.close() }
}
const cell = parseDshAdapterExpectedCase(await json(casePath)), config = await json(configPath)
if (Object.keys(config).some(key => !['dockerContext', 'architecture', 'timeoutSeconds', 'maxTasks', 'networkProxy'].includes(key))
  || typeof config.dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(config.dockerContext)
  || config.architecture !== cell.architecture || !Number.isSafeInteger(config.timeoutSeconds)
  || config.timeoutSeconds < 30 || config.timeoutSeconds > 600) throw new Error('invalid operator-owned adapter executor configuration')
const transport = observationNetworkEnvironment(config.networkProxy)
const output = resolve(outputPath)
await mkdir(output)
const save = (name, value) => writeFile(join(output, name), Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
await save('case.json', cell)
const docker = (args, timeout = 30_000) => execFile('docker', ['--context', config.dockerContext, ...args],
  { cwd: root, timeout, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' })
const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout)
const architecture = ['aarch64', 'arm64'].includes(info.Architecture) ? 'arm64' : info.Architecture === 'x86_64' ? 'x64' : info.Architecture
if (info.OSType !== 'linux' || architecture !== cell.architecture) throw new Error('Docker daemon differs from the scheduled adapter runtime')
const tag = `upstream-radar-adapter-job:node${cell.nodeMajor}-pnpm${cell.profileEnvironment.pnpmVersion}`
const build = await docker(['build', '--file', 'docker/dsh-surface-observer.Dockerfile',
  ...Object.entries(transport).filter(([name]) => /^(?:http|https)_proxy$/i.test(name)).flatMap(([name, value]) => ['--build-arg', `${name}=${value}`]),
  '--build-arg', `NODE_MAJOR=${cell.nodeMajor}`, '--build-arg', `PNPM_VERSION=${cell.profileEnvironment.pnpmVersion}`, '--tag', tag, '.'], 900_000)
await save('build.log', Buffer.from(`${build.stdout}\n${build.stderr}`))
const image = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0]
if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Architecture !== cell.architecture.replace('x64', 'amd64')) throw new Error('adapter image has an invalid identity or architecture')
const key = createHash('sha256').update(JSON.stringify({ cell, image: image.Id, timeoutSeconds: config.timeoutSeconds, networkProxy: config.networkProxy })).digest('hex')
const name = `radar-batch-adapter-${key.slice(0, 24)}`
await save('task.json', { key, name, image: image.Id, dockerContext: config.dockerContext, dispatchedAfter: new Date().toISOString() })
await docker(dshBatchContainerArguments({ name, key, image: image.Id, kind: 'adapter', cell,
  timeoutSeconds: config.timeoutSeconds, networkProxy: config.networkProxy }))
await docker(['start', name])
await docker(['wait', name], (config.timeoutSeconds * 8 + 60) * 1000)
const container = JSON.parse((await docker(['inspect', name])).stdout)[0]
if (container.Config?.Labels?.['upstream-radar.task'] !== key || container.Image !== image.Id || container.Mounts?.length !== 0
  || container.Config?.User !== '10001:10001' || container.HostConfig?.ReadonlyRootfs !== true || container.HostConfig?.Privileged
  || container.HostConfig?.NetworkMode === 'host' || container.State?.Running || container.State?.Status !== 'exited') {
  throw new Error('adapter container ownership, isolation or terminal state could not be verified')
}
await save('container.json', { id: container.Id, image: container.Image, state: container.State,
  user: container.Config.User, mounts: container.Mounts, readonlyRootfs: container.HostConfig.ReadonlyRootfs })
const logs = await docker(['logs', name])
await save('stderr.log', Buffer.from(logs.stderr))
const collected = JSON.parse(logs.stdout)
await save('report.json', collected.report)
if (container.State.ExitCode !== 0) throw new Error('adapter collector did not complete successfully')
mergeDshAdapterLedger(emptyDshAdapterLedger(), cell, collected.report)
// This exact job-created container is terminal; its evidence remains on disk.
await docker(['rm', name])
process.stdout.write(`${JSON.stringify({ caseId: cell.id, result: collected.report.result, image: image.Id, container: container.Id })}\n`)
