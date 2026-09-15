import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dshBatchContainerArguments } from '../../../../../dist/src/dsh-batch-executor.js'
import { DSH_SURFACE_EXECUTION_CONTRACT } from '../../../../../dist/src/dsh-surface-observation.js'
import { createDshHostBuildApproval, parseDshHostBuildApproval } from '../../../../../dist/src/dsh-host-build-policy.js'
import { parseDshHostBuildExecution } from '../../../../../dist/src/dsh-host-build-execution.js'
import { parseDshHostBuildInventory, parseDshHostNativeLoadFailures } from '../../../../../dist/src/dsh-host-builds.js'

const execFile = promisify(callback)
const root = import.meta.dirname
const project = resolve(root, '../../../../..')
const priorDirectory = join(root, '../../2026-09-14/host-build-surface-real/56a6c378189cb1329bf6f15045118fc556139956178d3636df84051ba44c9428')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const config = await json(join(root, '../../2026-09-14/recovery-current-executor.json'))
assert.equal(config.dockerContext, 'colima-upstream-radar-review-20260913')
const docker = async (args, timeout = 30_000, maxBuffer = 16 * 1024 * 1024) => execFile('docker',
  ['--context', config.dockerContext, ...args], { cwd: project, timeout, maxBuffer })
assert.equal((await docker(['ps', '--quiet'])).stdout.trim(), '', 'a previous target is still live')

const prior = await json(join(priorDirectory, 'report.json'))
const priorCell = (await json(join(priorDirectory, 'handle.json'))).cell
assert.equal(prior.result, 'environment-unsupported')
assert.equal(prior.stages.host.status, 'failed')
assert.equal(prior.plugin, 'dsh-context@0.52.2')
assert.equal(prior.dshVersion, '0.1.3-alpha.2')
assert.equal(prior.artifact.sha256, priorCell.artifactSha256)
const inventory = parseDshHostBuildInventory(prior.hostBuildInventory)
const failures = parseDshHostNativeLoadFailures(prior.hostBuildFailures, inventory)
assert.deepEqual(inventory.coverageGaps, [])
assert.deepEqual([...new Set(failures.map(failure => failure.packageSpec))], ['fs-ext@2.1.1'])

const sources = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'docker/dsh-surface-observer.Dockerfile']
const collect = async directory => {
  for (const entry of await readdir(join(project, directory), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink() && sources.length < 2048)
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) await collect(path)
    else if (entry.isFile()) sources.push(path)
  }
}
await collect('src'); await collect('test')
const identities = () => Promise.all(sources.sort().map(async path => [path, sha(await readFile(join(project, path)))]))
const before = await identities()
const sourceIdentity = sha(JSON.stringify(before))
const output = join(root, sourceIdentity)
await mkdir(output) // A repeated invocation must not overwrite or restart evidence.
const save = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
await save('source-inputs.json', before)

const tag = `upstream-radar-host-build-retry:${sourceIdentity.slice(0, 16)}`
console.log(JSON.stringify({ stage: 'building-current-observer', sourceIdentity, output }))
const build = await docker(['build', '--file', 'docker/dsh-surface-observer.Dockerfile', '--build-arg', 'NODE_MAJOR=24',
  '--build-arg', 'PNPM_VERSION=11.7.0', '--build-arg', `https_proxy=${config.networkProxy}`, '--build-arg', `http_proxy=${config.networkProxy}`,
  '--label', `upstream-radar.scanner-source=${sourceIdentity}`, '--tag', tag, '.'], 900_000)
await writeFile(join(output, 'build.log'), build.stdout + build.stderr, { flag: 'wx' })
assert.deepEqual(await identities(), before, 'the observer changed while its image was building')
const image = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0]
assert.equal(image.Architecture, 'arm64')
assert.equal(image.Config.Labels['upstream-radar.scanner-source'], sourceIdentity)
const nodeVersion = (await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001',
  '--entrypoint', 'node', image.Id, '--version'])).stdout.trim().replace(/^v/, '')
assert.match(nodeVersion, /^24\.\d+\.\d+$/)

// The previous natural host failure is the reviewed trigger. A new image may
// have a different full Node version; record and bind that exact runtime.
const context = { caseId: prior.caseId, plugin: prior.plugin, artifactSha256: prior.artifact.sha256,
  sourceFingerprint: prior.sourceFingerprint, dshVersion: prior.dshVersion, plane: prior.plane, profile: prior.profile,
  runtime: { ...prior.runtime, nodeVersion }, profileEnvironment: prior.profileEnvironment,
  ...(prior.startupConfiguration === undefined ? {} : { startupConfiguration: prior.startupConfiguration }) }
const approval = parseDshHostBuildApproval(createDshHostBuildApproval({ inventory, failures, context, packages: ['fs-ext@2.1.1'] }))
await save('reviewed-permission.json', { context, approval, priorReport: join(priorDirectory, 'report.json'),
  priorNodeVersion: prior.runtime.nodeVersion, selectedFailure: failures[0] })
const cell = { ...priorCell, sourceFingerprint: prior.sourceFingerprint,
  contractFingerprint: `sha256:${sha(JSON.stringify({ sourceIdentity, priorArtifact: prior.artifact.sha256, scope: 'focused host rebuild retry' }))}`,
  hostBuildApproval: approval }
const key = sha(JSON.stringify({ image: image.Id, cell }))
const args = dshBatchContainerArguments({ name: `radar-batch-host-retry-${key.slice(0, 16)}`, key, image: image.Id,
  kind: 'surface', cell, timeoutSeconds: 180, networkProxy: config.networkProxy })
const id = (await docker(args)).stdout.trim()
await save('handle.json', { id, imageId: image.Id, sourceIdentity, executionContract: DSH_SURFACE_EXECUTION_CONTRACT,
  reviewedFrom: join(priorDirectory, 'report.json'), cell })
await docker(['start', id])
console.log(JSON.stringify({ stage: 'surface-started', id, imageId: image.Id }))
await docker(['wait', id], 600_000)
const container = JSON.parse((await docker(['inspect', id])).stdout)[0]
assert.equal(container.State.Running, false)
assert.equal(container.Config.User, '10001:10001')
assert.deepEqual(container.Mounts, [])
assert.equal(container.HostConfig.ReadonlyRootfs, true)
await save('container.json', { id, imageId: image.Id, state: container.State,
  hostMounts: false, user: container.Config.User })
const logs = await docker(['logs', id])
await writeFile(join(output, 'stdout.log'), logs.stdout, { flag: 'wx' })
await writeFile(join(output, 'stderr.log'), logs.stderr, { flag: 'wx' })
assert.equal(container.State.ExitCode, 0, 'the isolated observer must produce a report')
const observed = JSON.parse(logs.stdout.trim())
await save('report.json', observed.report)
await save('attachments.json', { attachments: observed.attachments, gaps: observed.attachmentGaps })
const report = observed.report
assert.equal(report.executionContract, DSH_SURFACE_EXECUTION_CONTRACT)
assert.equal(report.artifact.sha256, prior.artifact.sha256)
assert.equal(report.runtime.nodeVersion, nodeVersion)
assert.equal(report.runtime.architecture, 'arm64')
assert.deepEqual(report.boundary.requestedHostBuildApproval, approval)
const fresh = parseDshHostBuildInventory(report.hostBuildInventory)
const execution = parseDshHostBuildExecution(report.hostBuildExecution, { inventory: fresh,
  context: { ...context, runtime: report.runtime, profileEnvironment: report.profileEnvironment } })
assert.equal(execution.requestedApproval.contextFingerprint, approval.contextFingerprint)
if (execution.command) assert.equal(execution.command.outputSha256, sha(Buffer.from(execution.command.output)))
const finalFailures = parseDshHostNativeLoadFailures(report.hostBuildFailures ?? [], fresh)
const proof = { id, imageId: image.Id, sourceIdentity, exactArtifactSha256: report.artifact.sha256,
  plugin: report.plugin, dshVersion: report.dshVersion, nodeVersion, priorNodeVersion: prior.runtime.nodeVersion,
  buildStatus: execution.status, buildBindingVerified: execution.bindingVerified, buildCommand: execution.command,
  hostStatus: report.stages.host.status, result: report.result, reason: report.reason, finalHostNativeFailures: finalFailures,
  scope: 'Focused operator-reviewed real-plugin host rebuild and following Web observation; not a full automatic batch.' }
await save('proof.json', proof)
assert.deepEqual(await identities(), before, 'the observer source changed during the target run')
console.log(JSON.stringify({ stage: 'verified', output, id, buildStatus: execution.status,
  hostStatus: report.stages.host.status, result: report.result, finalFailures }))
