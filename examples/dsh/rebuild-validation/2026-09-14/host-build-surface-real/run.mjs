import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dshBatchContainerArguments } from '../../../../../dist/src/dsh-batch-executor.js'
import { DSH_SURFACE_EXECUTION_CONTRACT } from '../../../../../dist/src/dsh-surface-observation.js'
import { parseDshHostBuildInventory, parseDshHostNativeLoadFailures } from '../../../../../dist/src/dsh-host-builds.js'

const execFile = promisify(callback)
const root = import.meta.dirname
const project = resolve(root, '../../../../..')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const config = await json(join(root, '../recovery-current-executor.json'))
assert.equal(config.dockerContext, 'colima-upstream-radar-review-20260913')
const docker = async (args, timeout = 30_000, maxBuffer = 16 * 1024 * 1024) => execFile('docker',
  ['--context', config.dockerContext, ...args], { cwd: project, timeout, maxBuffer })
assert.equal((await docker(['ps', '--quiet'])).stdout.trim(), '')
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
await mkdir(output) // No overwrite or automatic restart.
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' })
await save('source-inputs.json', before)
const tag = `upstream-radar-host-build-surface:${sourceIdentity.slice(0, 16)}`
console.log(JSON.stringify({ stage: 'building-current-observer', sourceIdentity, output }))
const build = await docker(['build', '--file', 'docker/dsh-surface-observer.Dockerfile', '--build-arg', 'NODE_MAJOR=24',
  '--build-arg', 'PNPM_VERSION=11.7.0', '--build-arg', `https_proxy=${config.networkProxy}`, '--build-arg', `http_proxy=${config.networkProxy}`,
  '--label', `upstream-radar.scanner-source=${sourceIdentity}`, '--tag', tag, '.'], 900_000)
await writeFile(join(output, 'build.log'), build.stdout + build.stderr, { flag: 'wx' })
assert.deepEqual(await identities(), before, 'Source changed during the build; do not execute the mixed image')
const image = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0]
assert.equal(image.Architecture, 'arm64')
assert.equal(image.Config.Labels['upstream-radar.scanner-source'], sourceIdentity)
// Exact artifact and author baseline from the real batch. This is a focused
// observer regression on arm64, not a fabricated native pass or a batch result.
const historical = await json(join(root, '../ci-batch-34921505970/batch-output/surface-ledger.json'))
const prior = historical.entries.find(entry => entry.plugin === 'dsh-context@0.52.2' && entry.dshVersion === '0.1.3-alpha.2' && entry.runtime.nodeMajor === 24)
assert.ok(prior)
const cell = { id: 'context-host-build-regression', sourceCaseId: prior.sourceCaseId, plugin: prior.plugin, dshVersion: prior.dshVersion,
  nodeMajor: 24, platform: 'linux', architecture: 'arm64', plane: 'web', profile: 'web', runtimeId: 'dsh-context',
  artifactSha256: prior.artifact.sha256, allowedBuilds: '', profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} },
  sourceFingerprint: `sha256:${sha(JSON.stringify({ historicalArtifact: prior.artifact, scope: 'isolated surface regression only' }))}`,
  contractFingerprint: `sha256:${sourceIdentity}` }
const key = sha(JSON.stringify({ image: image.Id, cell }))
const args = dshBatchContainerArguments({ name: `radar-batch-host-build-${key.slice(0, 16)}`, key, image: image.Id,
  kind: 'surface', cell, timeoutSeconds: 180, networkProxy: config.networkProxy })
const id = (await docker(args)).stdout.trim()
await save('handle.json', { id, imageId: image.Id, sourceIdentity, executionContract: DSH_SURFACE_EXECUTION_CONTRACT, cell })
await docker(['start', id])
console.log(JSON.stringify({ stage: 'surface-started', id, imageId: image.Id }))
await docker(['wait', id], 600_000)
const container = JSON.parse((await docker(['inspect', id])).stdout)[0]
assert.equal(container.State.Running, false)
assert.equal(container.Config.User, '10001:10001')
assert.deepEqual(container.Mounts, [])
assert.equal(container.HostConfig.ReadonlyRootfs, true)
await save('container.json', { id, imageId: image.Id, state: container.State, hostMounts: false, user: container.Config.User })
const logs = await docker(['logs', id])
await writeFile(join(output, 'stdout.log'), logs.stdout, { flag: 'wx' })
await writeFile(join(output, 'stderr.log'), logs.stderr, { flag: 'wx' })
assert.equal(container.State.ExitCode, 0)
const observed = JSON.parse(logs.stdout.trim())
await save('report.json', observed.report)
await save('attachments.json', { attachments: observed.attachments, gaps: observed.attachmentGaps })
const report = observed.report
assert.equal(report.executionContract, DSH_SURFACE_EXECUTION_CONTRACT)
assert.equal(report.artifact.sha256, prior.artifact.sha256)
assert.equal(report.runtime.architecture, 'arm64')
const inventory = parseDshHostBuildInventory(report.hostBuildInventory)
assert.deepEqual(inventory.coverageGaps, [])
const failures = parseDshHostNativeLoadFailures(report.hostBuildFailures, inventory)
assert.equal(report.result, 'environment-unsupported')
assert.equal(report.stages.host.status, 'failed')
assert.deepEqual([...new Set(failures.map(item => item.packageSpec))], ['fs-ext@2.1.1'])
assert.deepEqual(report.boundary.approvedDependencyBuilds, [])
assert.deepEqual(report.boundary.requiredDependencyBuilds, [])
await save('proof.json', { id, imageId: image.Id, sourceIdentity, executionContract: report.executionContract,
  plugin: report.plugin, dshVersion: report.dshVersion, runtime: report.runtime, result: report.result,
  hostBuildPackages: inventory.packages.map(item => item.spec), hostNativeFailures: failures,
  scope: 'Current-code real-plugin host failure attribution regression; no host build permission and not the full batch.' })
console.log(JSON.stringify({ stage: 'verified', id, plugin: report.plugin, result: report.result, reason: report.reason, failures }))
