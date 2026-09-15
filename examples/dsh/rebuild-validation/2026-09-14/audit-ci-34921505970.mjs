// Read-only audit of the original downloaded CI files. The derived proof is
// separate; neither historical reports nor their stated coverage are rewritten.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = import.meta.dirname
const hashes = {}
const json = async path => {
  const bytes = await readFile(join(root, path))
  hashes[path] = createHash('sha256').update(bytes).digest('hex')
  return JSON.parse(bytes.toString('utf8'))
}
const base = 'ci-batch-34921505970'
const review = await json('ci-review-34921505970/recommendations.json')
assert.equal(review.entries.length, 8)
assert.deepEqual(review.pendingTasks, [])
assert.ok(review.entries.every(entry => entry.reviewContract === 'dsh-environment/v11'))
const first = await json(`${base}/batch-first-summary.json`)
const retry = await json(`${base}/batch-retry-summary.json`)
const unchanged = await json(`${base}/batch-output/summary.json`)
assert.equal(unchanged.executed, 0)
assert.deepEqual(unchanged.failedTasks, [])
assert.deepEqual(unchanged.orphanedRunningTasks, [])
for (const kind of ['Native', 'Surface', 'Adapter']) assert.deepEqual(unchanged[`next${kind}Plan`].matrix.include, [])
assert.deepEqual(unchanged.nextSurfacePlan.blocked, [])
assert.deepEqual(unchanged.nextAdapterPlan.blocked, [])
assert.equal(unchanged.authorScopes.length, 8)
const state = await json(`${base}/batch-output/state.json`)
assert.deepEqual([state.nativeLedger.entries.length, state.surfaceLedger.entries.length, state.adapterLedger.entries.length], [21, 25, 4])
assert.equal(new Set(state.nativeLedger.entries.map(entry => entry.targetId)).size, 8)
assert.ok(state.tasks.every(task => task.status === 'accepted'))
const executor = await json(`${base}/batch-output/executor-evidence.json`)
const recovery = await json('recovery-web-errors/recovery-proof.json')
assert.equal(executor.sourceIdentity, 'cb3d220d6f64e2567c394b9082f6b2e73b77ac3fb28f269835bf438788e4db00')
assert.equal(recovery.sourceIdentity, executor.sourceIdentity)
assert.equal(recovery.validationCommit, '18145360fb3fb536cd9726e1356b72bc8788893f')
assert.deepEqual(recovery.buildApprovalBindings.before, recovery.buildApprovalBindings.after)
const images = new Set(executor.images.map(image => image.id))
const checkedContainers = new Set()
async function checkReport(directory, plugin, dshVersion, expectedContainer) {
  const report = await json(`${directory}/report.json`)
  const container = await json(`${directory}/container.json`)
  assert.equal(report.probe === 'dsh-install' ? `${report.artifact.name}@${report.artifact.version}` : report.plugin, plugin)
  if (dshVersion !== undefined) assert.equal(report.dshVersion, dshVersion)
  if (report.probe === 'dsh-surface') assert.equal(report.executionContract, 'dsh-surface/v1alpha13')
  assert.equal(container.state.Running, false)
  assert.equal(container.state.OOMKilled, false)
  assert.equal(container.user, '10001:10001')
  assert.deepEqual(container.mounts, [])
  assert.equal(container.readonlyRootfs, true)
  assert.ok(images.has(container.image))
  if (expectedContainer !== undefined) assert.equal(container.id, expectedContainer)
  assert.ok(!checkedContainers.has(container.id), 'independent executions must not reuse a container id')
  checkedContainers.add(container.id)
}
for (const task of state.tasks) {
  await checkReport(`${base}/batch-output/reports/${task.kind}/${task.cell.id}/${task.key}-${task.attempts}`,
    task.cell.plugin, task.cell.dshVersion)
}
const changes = []
for (const phase of ['before', 'after']) {
  const directory = `${base}/input-change-${phase}`
  const proof = await json(`${directory}/execution-proof.json`)
  const old = await json(`${directory}/baseline/state.json`)
  const next = await json(`${directory}/batch/state.json`)
  assert.equal(proof.executed, 16)
  assert.equal(proof.unchangedPlugins, 7)
  assert.equal(proof.executorUnchanged, true)
  assert.equal(old.executorIdentity, next.executorIdentity)
  assert.deepEqual(old.nativeLedger.entries.filter(entry => entry.targetId !== 'context'),
    next.nativeLedger.entries.filter(entry => entry.targetId !== 'context'))
  const otherSources = new Set(old.nativeLedger.entries.filter(entry => entry.targetId !== 'context').map(entry => entry.caseId))
  assert.deepEqual(old.surfaceLedger.entries.filter(entry => otherSources.has(entry.sourceCaseId)),
    next.surfaceLedger.entries.filter(entry => otherSources.has(entry.sourceCaseId)))
  assert.deepEqual(old.adapterLedger, next.adapterLedger)
  for (const item of proof.reports) {
    assert.ok(item.caseId.startsWith('context-'))
    assert.ok(item.report.startsWith('batch/reports/') && !item.report.includes('..'))
    await checkReport(`${directory}/${item.report.slice(0, -'/report.json'.length)}`, proof.plugin, undefined, item.container)
  }
  changes.push({ revisions: proof.revisions, executed: proof.executed, unchangedPlugins: proof.unchangedPlugins })
}
assert.deepEqual(await json(`${base}/input-change-after/execution-state.json`), await json(`${base}/input-change-after/batch/state.json`))
const proof = { ciRun: 34921505970, commit: '18145360fb3fb536cd9726e1356b72bc8788893f', sourceIdentity: executor.sourceIdentity,
  firstExecuted: first.executed, retryExecuted: retry.executed, unchangedExecuted: unchanged.executed,
  acceptedCells: state.tasks.length, checkedIndependentContainers: checkedContainers.size, changes,
  compatibilityPass: false, currentWorktreeValidated: false,
  remainingScope: [...unchanged.unimplementedChecks, ...unchanged.nextNativePlan.blocked.map(item => item.reason),
    'Host-build approval/execution is not integrated; the stock DSH fs-ext failure remains a Radar setup gap.',
    'This audit covers commit 1814536, not the subsequent readiness and surface-review changes.'], hashes }
await writeFile(join(root, 'ci-34921505970-audit.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ ...proof, hashes: `${Object.keys(hashes).length} original files hashed; see the separate audit proof` }, null, 2))
