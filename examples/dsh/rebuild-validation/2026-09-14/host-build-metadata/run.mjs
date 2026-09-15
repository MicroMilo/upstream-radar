import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
const execFile = promisify(callback)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const config = await json(join(import.meta.dirname, '../recovery-current-executor.json'))
const executor = await json(join(import.meta.dirname, '../recovery-web-errors/batch/executor-evidence.json'))
assert.equal(config.dockerContext, 'colima-upstream-radar-review-20260913')
assert.equal(executor.dockerContext, config.dockerContext)
const image = executor.images.find(image => image.nodeMajor === 24 && image.pnpmVersion === '11.7.0')
assert.match(image.id, /^sha256:[a-f0-9]{64}$/)
const docker = async (args, timeout = 30_000) => execFile('docker', ['--context', config.dockerContext, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 })
assert.equal((await docker(['ps', '--quiet'])).stdout.trim(), '', 'The dedicated executor must be idle before this diagnostic')
const code = await readFile(join(import.meta.dirname, 'probe.mjs'), 'utf8')
const save = (path, text) => writeFile(join(import.meta.dirname, path), text, { flag: 'wx' })
await mkdir(join(import.meta.dirname, 'evidence')) // No overwrite or automatic restart.
const outcomes = []
for (const mode of ['no-build']) {
  const key = createHash('sha256').update(code + mode + image.id).digest('hex')
  const name = `radar-host-build-${mode}-${key.slice(0, 12)}`
  const args = ['create', '--name', name, '--label', `upstream-radar.task=${key}`,
    '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--pids-limit', '256', '--memory', '3g', '--cpus', '1.5', '--ulimit', 'nofile=4096:4096',
    '--tmpfs', '/sandbox:rw,exec,nosuid,nodev,size=3g,mode=1777', '--env', 'TMPDIR=/sandbox',
    '--entrypoint', 'node', image.id, '--input-type=module', '-e', code, JSON.stringify({ mode, networkProxy: config.networkProxy })]
  const id = (await docker(args)).stdout.trim()
  const before = JSON.parse((await docker(['inspect', id])).stdout)[0]
  assert.equal(before.Config.User, '10001:10001')
  assert.equal(before.Mounts.length, 0)
  assert.equal(before.HostConfig.ReadonlyRootfs, true)
  await save(`evidence/${mode}-handle.json`, JSON.stringify({ mode, name, id, imageId: image.id, sourceIdentity: executor.sourceIdentity }, null, 2))
  await docker(['start', id])
  console.log(JSON.stringify({ stage: 'diagnostic-started', mode, id }))
  await docker(['wait', id], 300_000)
  const container = JSON.parse((await docker(['inspect', id])).stdout)[0]
  assert.equal(container.State.Running, false)
  const logs = await docker(['logs', id])
  await save(`evidence/${mode}-stdout.log`, logs.stdout)
  await save(`evidence/${mode}-stderr.log`, logs.stderr)
  await save(`evidence/${mode}-container.json`, JSON.stringify({ id, imageId: container.Image, state: container.State,
    user: container.Config.User, mounts: container.Mounts, readonlyRootfs: container.HostConfig.ReadonlyRootfs }, null, 2))
  assert.equal(container.State.ExitCode, 0, `Diagnostic ${mode} did not complete; preserve its evidence`)
  const report = JSON.parse(logs.stdout.trim())
  await save(`evidence/${mode}-report.json`, JSON.stringify(report, null, 2))
  const outcome = { mode, containerId: id, nodeVersion: report.nodeVersion, prepareCode: report.prepare.terminal?.code,
    naturalHostTerminal: report.host?.naturalTerminal, aliveAtEndOfObservation: report.host?.aliveAtEndOfObservation,
    missingFsExtBinary: report.host?.missingFsExtBinary, statuses: report.host?.statuses }
  outcomes.push(outcome)
  console.log(JSON.stringify({ stage: 'diagnostic-completed', ...outcome }))
}
await save('diagnostic-summary.json', JSON.stringify({ scope: 'stock-dsh-only-two-policy-comparison', pluginInstalled: false,
  policyExperiment: true, productionPolicyChanged: false, executor, outcomes }, null, 2))
