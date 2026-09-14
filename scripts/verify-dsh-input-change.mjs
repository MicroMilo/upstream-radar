#!/usr/bin/env node
// Acceptance replay only: observations and reviews still come from the normal
// public collectors. This script never manufactures a changed snapshot or runs
// target code. Execution is a separate, secret-free batch step.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseObserverConfig } from '../dist/src/upstream-observer.js'
import { parseNpmSpec } from '../dist/src/npm.js'

const targetId = 'context', observerTargetId = 'dsh-context', repository = 'bowenliang123/dsh-context'
const [mode, ...args] = process.argv.slice(2)
async function json(path) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('acceptance input is not a bounded regular file')
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size) throw new Error('acceptance input changed while reading')
    return JSON.parse(bytes.toString('utf8'))
  } finally { await handle.close() }
}
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const withoutTarget = value => Object.fromEntries(Object.entries(value).filter(([id]) => id !== observerTargetId))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function artifactIdentity(value) {
  assert.equal(value?.name, 'dsh-context', 'replay package must remain Context')
  parseNpmSpec(`${value.name}@${value.version}`)
  return { name: value.name, version: value.version, integrity: value.integrity ?? null }
}
async function observationFacts(output) {
  const fixture = await json(join(output, 'fixture.json'))
  const before = await json(join(output, 'baseline/observations.json'))
  const after = await json(join(output, 'review/observations.json'))
  assert.equal(fixture.targetId, targetId)
  assert.equal(fixture.observerTargetId, observerTargetId)
  assert.equal(fixture.repository, repository)
  assert.deepEqual(withoutTarget(after.targets), withoutTarget(before.targets), 'unrelated observation changed')
  assert.equal(before.targets[observerTargetId].source.commit, fixture.revisions.from)
  assert.equal(before.targets[observerTargetId].source.repository, repository)
  assert.equal(after.targets[observerTargetId].source.commit, fixture.revisions.to)
  assert.equal(after.targets[observerTargetId].source.repository, repository)
  const previousArtifact = artifactIdentity(before.targets[observerTargetId].package)
  const artifact = artifactIdentity(after.targets[observerTargetId].package)
  const previousPlugin = `${previousArtifact.name}@${previousArtifact.version}`
  assert.equal(previousPlugin, fixture.plugin, 'fixture must bind the initial observed package')
  return { targetId, observerTargetId, repository, revisions: fixture.revisions, previousPlugin,
    plugin: `${artifact.name}@${artifact.version}`, previousArtifact, artifact,
    changeKind: digest(previousArtifact) === digest(artifact) ? 'repository-update' : 'repository-and-package-update',
    previousObservationDigest: digest(before), observationDigest: digest(after) }
}
async function acceptedObservation(output) {
  const accepted = await json(join(output, 'observed-change.json'))
  assert.deepEqual(accepted, await observationFacts(output), 'observed facts changed after acceptance')
  return accepted
}

if (mode === 'prepare') {
  const [review, batch, output, commit] = args
  if (args.length !== 4 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('prepare requires review, batch, new output directory and an exact commit')
  const observations = await json(join(review, 'observations.json'))
  const recommendations = await json(join(review, 'recommendations.json'))
  const buildPlans = await json(join(review, 'build-plans.json'))
  let evidenceCache
  try { evidenceCache = await json(join(review, 'recommendations.json.evidence.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const state = await json(join(batch, 'state.json'))
  const summary = await json(join(batch, 'summary.json'))
  const source = observations.targets?.[observerTargetId]
  if (source?.source?.repository !== repository || !/^[a-f0-9]{40}$/.test(source.source.commit)
    || source.source.commit === commit || source.package?.name !== 'dsh-context') throw new Error('replay requires a distinct observed Context repository revision')
  const config = parseObserverConfig({ targets: [{ id: observerTargetId, ecosystem: 'dsh', repository, ref: commit,
    packageName: source.package.name, packageTag: source.package.distTag ?? 'latest', packagePath: source.source.packagePath,
    lockfile: source.source.lockfile }] })
  await mkdir(output)
  for (const directory of ['baseline', 'review', 'batch']) await mkdir(join(output, directory))
  for (const [name, value] of Object.entries({ observations, recommendations, 'build-plans': buildPlans })) {
    await save(join(output, 'review', `${name}.json`), value)
    await save(join(output, 'baseline', `${name}.json`), value)
  }
  if (evidenceCache !== undefined) {
    for (const directory of ['review', 'baseline']) await save(join(output, directory, 'recommendations.json.evidence.json'), evidenceCache)
  }
  await save(join(output, 'batch/state.json'), state)
  await save(join(output, 'baseline/state.json'), state)
  await save(join(output, 'baseline/summary.json'), summary)
  await save(join(output, 'observer-targets.json'), config)
  await save(join(output, 'fixture.json'), { targetId, observerTargetId, repository,
    revisions: { from: source.source.commit, to: commit }, plugin: `${source.package.name}@${source.package.version}`,
    note: 'Replay of real immutable repository revisions; not an invented release or a live upstream notification.' })
} else if (mode === 'observation') {
  const [output] = args
  if (args.length !== 1) throw new Error('observation requires one replay directory')
  const facts = await observationFacts(output)
  const report = await json(join(output, 'review/observer-report.json'))
  assert.deepEqual(report.errors, [], 'real repository collection was incomplete')
  // Documentation updates refresh repository intent without fabricating a
  // runtime/advisory event. The changed immutable snapshot above is the proof.
  assert.ok(report.changes.length <= 1 && report.changes.every(change => change.targetId === observerTargetId), 'an unrelated upstream event was emitted')
  let accepted
  try { accepted = await json(join(output, 'observed-change.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (accepted !== undefined) assert.deepEqual(accepted, facts, 'observed facts changed after acceptance')
  if (facts.changeKind === 'repository-and-package-update') {
    const event = report.changes[0]
    if (event === undefined) assert.ok(accepted, 'a package change requires a matching meaningful event')
    else {
      assert.equal(event.meaningful, true, 'a package change requires a matching meaningful event')
      assert.deepEqual(artifactIdentity(event.previous?.package), facts.previousArtifact, 'previous event package identity does not match observations')
      assert.deepEqual(artifactIdentity(event.current?.package), facts.artifact, 'current event package identity does not match observations')
      assert.equal(event.source?.beforeCommit, facts.revisions.from)
      assert.equal(event.source?.afterCommit, facts.revisions.to)
    }
  }
  if (accepted === undefined) await save(join(output, 'observed-change.json'), facts)
} else if (mode === 'review') {
  const [output] = args
  if (args.length !== 1) throw new Error('review requires one replay directory')
  await acceptedObservation(output)
  const fixture = await json(join(output, 'fixture.json'))
  const before = await json(join(output, 'baseline/recommendations.json'))
  const after = await json(join(output, 'review/recommendations.json'))
  const summary = await json(join(output, 'review/review-summary.json'))
  assert.equal(summary.attempted, 1, 'expected exactly one repository review')
  assert.equal(summary.planned, 1)
  assert.equal(summary.failed, 0)
  assert.equal(summary.deferred, 0)
  assert.deepEqual(after.pendingTasks, [])
  assert.deepEqual(after.entries.filter(entry => entry.targetId !== targetId), before.entries.filter(entry => entry.targetId !== targetId), 'unrelated repository was reviewed again')
  assert.equal(after.entries.find(entry => entry.targetId === targetId)?.sourceCommit, fixture.revisions.to)
} else if (mode === 'execution') {
  const [output] = args
  if (args.length !== 1) throw new Error('execution requires one replay directory')
  const observed = await acceptedObservation(output)
  const fixture = await json(join(output, 'fixture.json'))
  const before = await json(join(output, 'baseline/state.json'))
  const after = await json(join(output, 'batch/state.json'))
  const baselineSummary = await json(join(output, 'baseline/summary.json'))
  const summary = await json(join(output, 'batch/summary.json'))
  const sourceCases = new Set([...before.nativeLedger.entries, ...after.nativeLedger.entries]
    .filter(entry => entry.targetId === targetId).map(entry => entry.caseId))
  assert.equal(after.executorIdentity, before.executorIdentity, 'the replay changed its executor instead of only repository evidence')
  assert.deepEqual(after.nativeLedger.entries.filter(entry => entry.targetId !== targetId), before.nativeLedger.entries.filter(entry => entry.targetId !== targetId), 'unrelated native evidence changed')
  assert.deepEqual(after.surfaceLedger.entries.filter(entry => !sourceCases.has(entry.sourceCaseId)), before.surfaceLedger.entries.filter(entry => !sourceCases.has(entry.sourceCaseId)), 'unrelated surface evidence changed')
  assert.deepEqual(after.adapterLedger.entries.filter(entry => entry.cell.targetId !== targetId), before.adapterLedger.entries.filter(entry => entry.cell.targetId !== targetId), 'unrelated adapter evidence changed')
  assert.deepEqual(summary.failedTasks, [])
  assert.deepEqual(summary.orphanedRunningTasks, [])
  for (const plane of ['Native', 'Surface', 'Adapter']) {
    assert.deepEqual(summary[`next${plane}Plan`].matrix.include, [])
    assert.deepEqual(summary[`next${plane}Plan`].blocked, baselineSummary[`next${plane}Plan`].blocked, 'the replay introduced another uncovered environment')
  }
  const executed = after.tasks.filter(task => task.status === 'accepted' && !before.tasks.some(old => old.key === task.key && old.attempts === task.attempts))
  assert.ok(executed.some(task => task.kind === 'native') && executed.some(task => task.kind === 'surface'), 'the changed repository needs actual native and surface execution')
  assert.equal(summary.executed, executed.length, 'not every execution was accepted')
  const reports = []
  for (const task of executed) {
    assert.ok(task.kind === 'surface' ? sourceCases.has(task.cell.sourceCaseId) : task.cell.targetId === targetId, 'an unrelated plugin executed again')
    assert.equal(task.cell.plugin, observed.plugin, 'scheduled cell package does not match the accepted observation')
    assert.match(task.key, /^[a-f0-9]{64}$/)
    assert.match(task.cell.id, /^[a-z0-9][a-z0-9._-]{0,63}$/)
    assert.ok(Number.isSafeInteger(task.attempts) && task.attempts > 0)
    const directory = join('batch/reports', task.kind, task.cell.id, `${task.key}-${task.attempts}`)
    const container = await json(join(output, directory, 'container.json'))
    const report = await json(join(output, directory, 'report.json'))
    assert.equal(container.state.Running, false)
    assert.equal(container.state.Status, 'exited')
    assert.equal(container.state.ExitCode, 0)
    assert.equal(container.user, '10001:10001')
    assert.equal(container.readonlyRootfs, true)
    assert.deepEqual(container.mounts, [])
    assert.match(container.id, /^[a-f0-9]{64}$/)
    assert.match(container.image, /^sha256:[a-f0-9]{64}$/)
    assert.equal(report.caseId, task.cell.id)
    const observedPlugin = task.kind === 'native' ? `${report.artifact?.name}@${report.artifact?.version}` : report.plugin
    assert.equal(observedPlugin, task.cell.plugin, 'isolated report package does not match its scheduled cell')
    if (task.kind === 'native') assert.equal(report.artifact?.spec, `npm:${task.cell.plugin}`)
    reports.push({ kind: task.kind, caseId: task.cell.id, container: container.id, report: join(directory, 'report.json') })
  }
  await save(join(output, 'execution-state.json'), after)
  await save(join(output, 'execution-proof.json'), { ...fixture, ...observed, executed: executed.length, reports,
    unchangedPlugins: new Set(after.nativeLedger.entries.filter(entry => entry.targetId !== targetId).map(entry => entry.targetId)).size,
    executorUnchanged: true, compatibilityPass: false })
} else if (mode === 'unchanged') {
  const [output] = args
  if (args.length !== 1) throw new Error('unchanged requires one replay directory')
  const before = await json(join(output, 'execution-state.json'))
  const after = await json(join(output, 'batch/state.json'))
  const summary = await json(join(output, 'batch/summary.json'))
  assert.deepEqual(after, before, 'unchanged replay altered its durable execution evidence')
  assert.equal(summary.executed, 0)
  assert.deepEqual(summary.failedTasks, [])
  assert.deepEqual(summary.orphanedRunningTasks, [])
  for (const plane of ['Native', 'Surface', 'Adapter']) assert.deepEqual(summary[`next${plane}Plan`].matrix.include, [])
  await save(join(output, 'unchanged-proof.json'), { executed: 0, durableEvidenceUnchanged: true, compatibilityPass: false })
} else throw new Error('unsupported input-change verification mode')

console.log(JSON.stringify({ mode, verified: true }))
