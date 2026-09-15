import assert from 'node:assert/strict'
import { execFile as callback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DSH_ENVIRONMENT_REVIEW_CONTRACT } from '../../../../../dist/src/dsh-environment-recommendation.js'

import { applyDshHeadlessAgentPlans } from '../../../../../dist/src/dsh-headless-agent-plan.js'

const execFile = promisify(callback)
const root = resolve(import.meta.dirname, '../../../../..')
const [reviewDirectory] = process.argv.slice(2)
assert.ok(reviewDirectory, 'Pass the downloaded, completed current review directory')
const validationCommit = (await execFile('git', ['rev-parse', 'refs/heads/codex/dsh-rebuild-validation'], { cwd: root })).stdout.trim()
assert.match(validationCommit, /^[a-f0-9]{40}$/)
const output = join(import.meta.dirname, 'batch')
const configPath = join(import.meta.dirname, '../recovery-current-executor.json')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const save = async (name, value) => writeFile(join(import.meta.dirname, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const config = await json(configPath)
assert.equal(config.maxTasks, 1)
const review = await json(join(reviewDirectory, 'recommendations.json'))
assert.equal(review.entries.length, 8)
assert.equal(review.pendingTasks.length, 0)
assert.ok(review.entries.every(entry => entry.reviewContract === DSH_ENVIRONMENT_REVIEW_CONTRACT && entry.status === 'recommended'))
const docker = async args => (await execFile('docker', ['--context', config.dockerContext, ...args], { cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout
assert.equal((await docker(['ps', '--quiet', '--filter', 'label=upstream-radar.task'])).trim(), '', 'Another target container is already running')
const defaultContext = (await execFile('docker', ['context', 'show'])).stdout.trim()
const tree = (await execFile('git', ['ls-tree', '-r', validationCommit, '--', 'src', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'docker/dsh-surface-observer.Dockerfile'], { cwd: root })).stdout.trim().split('\n')
const entries = tree.map(line => { const [metadata, path] = line.split('\t'); const [mode, type, blob] = metadata.split(' '); assert.ok(['100644', '100755'].includes(mode) && type === 'blob'); return { path, blob } }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
// Use the executor's code-point path order, and compare every local input with
// its immutable Git blob before starting any new collector.
entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const currentBlobs = (await execFile('git', ['hash-object', '--', ...entries.map(entry => entry.path)], { cwd: root })).stdout.trim().split('\n')
assert.deepEqual(currentBlobs, entries.map(entry => entry.blob))
const sourceIdentity = hash(JSON.stringify(await Promise.all(entries.map(async entry => [entry.path, hash(await readFile(join(root, entry.path)))]))))
const runnerPath = 'scripts/run-dsh-compatibility-batch.mjs'
assert.equal((await execFile('git', ['hash-object', '--', runnerPath], { cwd: root })).stdout.trim(),
  (await execFile('git', ['rev-parse', `${validationCommit}:${runnerPath}`], { cwd: root })).stdout.trim())
const runnerSha256 = hash(await readFile(join(root, runnerPath)))
await mkdir(output) // Refuse to restart or overwrite an existing experiment.
await copyFile(join(import.meta.dirname, '../recovery-immutable-evidence/state.json'), join(output, 'state.json'))
const initialState = await json(join(output, 'state.json'))
await save('initial-state.json', initialState)
const installTargets = await json(join(root, 'examples/dsh/rebuild-batch/install-targets.json'))
const buildPlans = await json(join(reviewDirectory, 'build-plans.json'))
const approvalBindings = ledger => applyDshHeadlessAgentPlans(installTargets, buildPlans, ledger).plugins
  .flatMap(target => (target.buildApprovals ?? []).map(approval => ({ targetId: target.id, ...approval })))
const initialBindings = approvalBindings(initialState.buildReviewEvidence)
assert.ok(initialBindings.length > 0, 'The recovery fixture must have a real byte-bound build approval')
assert.ok(initialState.buildReviewEvidence.entries.length > 0)
const args = ['scripts/run-dsh-compatibility-batch.mjs', 'examples/dsh/rebuild-batch/install-targets.json', resolve(reviewDirectory), output, configPath, '--execute']
async function runner(logName) {
  const log = await open(join(import.meta.dirname, logName), 'wx')
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', log.fd, log.fd] })
  let terminal
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { terminal = { code, signal }; resolve(terminal) })
  }).finally(() => log.close())
  return { child, completion, terminal: () => terminal }
}
const first = await runner('interrupted-run.log')
console.log(JSON.stringify({ stage: 'started-owned-runner', pid: first.child.pid, sourceIdentity, sourceFiles: entries.length }))
let before
while (!first.terminal()) {
  const state = await json(join(output, 'state.json'))
  const task = state.tasks.find(task => task.status === 'running')
  if (task) {
    const lock = await json(join(output, 'runner-lock.json'))
    assert.equal(lock.pid, first.child.pid)
    const name = `radar-batch-${task.key.slice(0, 24)}-${task.attempts}`
    let container
    try { container = JSON.parse(await docker(['inspect', name]))[0] }
    catch (error) { if (!/No such (?:object|container)/i.test(error.stderr ?? '')) throw error }
    if (container?.State.Running) {
      assert.equal(container.Config.Labels['upstream-radar.task'], task.key)
      assert.equal(container.Config.User, '10001:10001')
      assert.equal(container.Mounts.length, 0)
      assert.equal(container.HostConfig.ReadonlyRootfs, true)
      before = { observedAt: new Date().toISOString(), runnerPid: first.child.pid, caseId: task.cell.id, kind: task.kind,
        taskKey: task.key, attempts: task.attempts, containerId: container.Id, containerStartedAt: container.State.StartedAt,
        executorIdentity: state.executorIdentity, defaultDockerContext: defaultContext }
      for (const entry of initialState.buildReviewEvidence.entries) assert.ok(state.buildReviewEvidence.entries.some(current => JSON.stringify(current) === JSON.stringify(entry)), 'Build evidence was lost before a new observation existed')
      assert.ok(task.cell.allowedBuilds && task.cell.expectedArtifactSha256, 'The interrupted task must actually use its retained byte-bound build approval')
      await save('state-before-interruption.json', state)
      assert.equal(first.child.kill('SIGTERM'), true) // Only the child created above, never the target container.
      break
    }
  }
  await new Promise(resolve => setTimeout(resolve, 200))
}
assert.ok(before, 'The owned runner finished before a live container could be interrupted; do not claim a recovery')
before.runnerTerminal = await first.completion
assert.equal(before.runnerTerminal.signal, 'SIGTERM')
await save('interruption-before.json', before)
console.log(JSON.stringify({ stage: 'owned-runner-interrupted', ...before }))
const resumed = await runner('resumed-run.log')
const terminal = await resumed.completion
await save('resumed-runner-terminal.json', terminal)
assert.ok([0, 2].includes(terminal.code) && terminal.signal === null)
const [state, summary, executor] = await Promise.all(['state.json', 'summary.json', 'executor-evidence.json'].map(file => json(join(output, file))))
assert.equal(executor.sourceIdentity, sourceIdentity)
assert.equal(state.executorIdentity, before.executorIdentity)
assert.equal(summary.executed, 1)
assert.deepEqual(summary.failedTasks, [])
assert.deepEqual(summary.orphanedRunningTasks, [])
const task = state.tasks.find(task => task.key === before.taskKey)
assert.equal(task.status, 'accepted')
assert.equal(task.attempts, before.attempts)
const directory = join('reports', task.kind, task.cell.id, `${task.key}-${task.attempts}`)
const [container, report] = await Promise.all(['container.json', 'report.json'].map(file => json(join(output, directory, file))))
assert.equal(container.id, before.containerId)
assert.equal(container.state.StartedAt, before.containerStartedAt)
assert.equal(container.state.Running, false)
assert.equal(container.user, '10001:10001')
assert.equal(container.readonlyRootfs, true)
assert.equal(container.mounts.length, 0)
// The latest observation may refresh observedAt and temporary-path lockfile
// bytes. Keep the original snapshot, and verify actual approval applicability
// through the same public entry point used by the runner, not byte equality of
// the entire old and newly collected reports.
const finalBindings = approvalBindings(state.buildReviewEvidence)
for (const binding of initialBindings) assert.ok(finalBindings.some(current => JSON.stringify(current) === JSON.stringify(binding)), 'A retained exact build approval no longer applies')
assert.deepEqual(await json(join(import.meta.dirname, 'initial-state.json')), initialState)
assert.ok(initialBindings.some(binding => binding.targetId === task.cell.targetId && binding.artifactSha256 === task.cell.expectedArtifactSha256 && binding.packages.join(',') === task.cell.allowedBuilds))
assert.deepEqual(report.boundary.approvedDependencyBuilds, task.cell.allowedBuilds.split(','))
assert.equal((await docker(['ps', '--quiet', '--filter', 'label=upstream-radar.task'])).trim(), '')
assert.equal((await execFile('docker', ['context', 'show'])).stdout.trim(), defaultContext)
const proof = { validationCommit, verifiedAt: new Date().toISOString(), sourceIdentity, sourceFiles: entries.length, runnerSha256,
  buildApprovalBindings: { before: initialBindings, after: finalBindings },
  historicalEvidenceSnapshot: 'initial-state.json', beforeDeliverySnapshot: 'state-before-interruption.json',
  executorIdentity: state.executorIdentity, before, resumedRunnerTerminal: terminal, executed: summary.executed,
  reportPath: join('batch', directory, 'report.json'), result: report.result, reason: report.reason,
  verified: { sameContainer: true, sameAttempt: true, sameStartTime: true, acceptedAfterResume: true,
    historicalBuildEvidenceRetained: true, exactBuildApprovalsStillApplicable: true, noRunningTargetContainers: true, defaultDockerContextUnchanged: true },
  reviewContract: DSH_ENVIRONMENT_REVIEW_CONTRACT,
  scope: 'A real Linux arm64 one-task recovery using the current review and exact scanner source. This is not the full eight-plugin execution or a global compatibility pass.' }
await save('recovery-proof.json', proof)
console.log(JSON.stringify({ stage: 'recovery-verified', ...proof }))
