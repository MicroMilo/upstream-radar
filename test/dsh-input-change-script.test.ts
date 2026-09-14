import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it } from 'node:test'

const execFile = promisify(callback)
const script = fileURLToPath(new URL('../../scripts/verify-dsh-input-change.mjs', import.meta.url))
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

it('prepares an isolated real-revision replay without editing the completed batch or inventing observation evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-input-change-'))
  const review = join(root, 'review'), batch = join(root, 'batch'), output = join(root, 'replay')
  const from = 'a'.repeat(40), to = 'b'.repeat(40)
  const observations = { targets: {
    'dsh-context': { source: { repository: 'bowenliang123/dsh-context', commit: from, packagePath: 'package.json', lockfile: 'pnpm-lock.yaml' },
      package: { name: 'dsh-context', version: '0.52.0', distTag: 'latest' } },
    untouched: { source: { commit: 'c'.repeat(40) } },
  } }
  try {
    await mkdir(review); await mkdir(batch)
    await writeFile(join(review, 'observations.json'), JSON.stringify(observations))
    await writeFile(join(review, 'recommendations.json'), JSON.stringify({ entries: [{ targetId: 'context' }, { targetId: 'untouched' }] }))
    await writeFile(join(review, 'build-plans.json'), JSON.stringify({ entries: [] }))
    await writeFile(join(batch, 'state.json'), JSON.stringify({ executorIdentity: 'same-executor', tasks: [] }))
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ executed: 0 }))
    await execFile(process.execPath, [script, 'prepare', review, batch, output, to])
    assert.deepEqual(await json(join(review, 'observations.json')), observations)
    assert.deepEqual(await json(join(output, 'review/observations.json')), observations, 'only the real observer may create a changed snapshot')
    assert.deepEqual(await json(join(output, 'batch/state.json')), await json(join(batch, 'state.json')))
    const configuration = await json(join(output, 'observer-targets.json'))
    assert.equal(configuration.targets.length, 1)
    assert.equal(configuration.targets[0].ref, to)
    assert.equal(configuration.targets[0].id, 'dsh-context')
    assert.equal(configuration.targets[0].repository, 'bowenliang123/dsh-context')
    assert.deepEqual((await json(join(output, 'fixture.json'))).revisions, { from, to })
    await assert.rejects(execFile(process.execPath, [script, 'prepare', review, batch, output, to]), /already exists|EEXIST/)

    const changed = structuredClone(observations)
    changed.targets['dsh-context'].source.commit = to
    await writeFile(join(output, 'review/observations.json'), JSON.stringify(changed))
    await writeFile(join(output, 'review/observer-report.json'), JSON.stringify({ errors: [], changes: [{ targetId: 'dsh-context' }] }))
    await execFile(process.execPath, [script, 'observation', output])
    await writeFile(join(output, 'review/observer-report.json'), JSON.stringify({ errors: [], changes: [] }))
    await execFile(process.execPath, [script, 'observation', output])
    changed.targets.untouched.source.commit = 'd'.repeat(40)
    await writeFile(join(output, 'review/observations.json'), JSON.stringify(changed))
    await assert.rejects(execFile(process.execPath, [script, 'observation', output]), /unrelated observation/)
    await assert.rejects(execFile(process.execPath, [script, 'prepare', review, batch, join(root, 'bad'), '../main']), /exact commit/)

    await writeFile(join(output, 'review/review-summary.json'), JSON.stringify({ attempted: 1, planned: 1, failed: 0, deferred: 0 }))
    const reviewed = { entries: [{ targetId: 'context', sourceCommit: to }, { targetId: 'untouched' }], pendingTasks: [] }
    await writeFile(join(output, 'review/recommendations.json'), JSON.stringify(reviewed))
    await execFile(process.execPath, [script, 'review', output])
    await writeFile(join(output, 'review/review-summary.json'), JSON.stringify({ attempted: 2, planned: 2, failed: 0, deferred: 0 }))
    await assert.rejects(execFile(process.execPath, [script, 'review', output]), /exactly one repository review/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires fresh isolated Context execution and byte-stable unrelated results before accepting a selective replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-input-execution-'))
  const from = 'a'.repeat(40), to = 'b'.repeat(40)
  const plan = { matrix: { include: [] }, blocked: [] }
  const summary = { executed: 2, failedTasks: [], orphanedRunningTasks: [], nextNativePlan: plan, nextSurfacePlan: plan, nextAdapterPlan: plan }
  const original = { executorIdentity: 'same-executor', tasks: [],
    nativeLedger: { entries: [{ caseId: 'context-node22', targetId: 'context', marker: 'before' }, { caseId: 'untouched-node22', targetId: 'untouched' }] },
    surfaceLedger: { entries: [{ caseId: 'context-web', sourceCaseId: 'context-node22', marker: 'before' }, { caseId: 'untouched-web', sourceCaseId: 'untouched-node22' }] },
    adapterLedger: { entries: [] },
  }
  const tasks = [
    { key: 'd'.repeat(64), kind: 'native', cell: { id: 'context-node22', targetId: 'context', plugin: 'dsh-context@0.52.0' }, attempts: 1, status: 'accepted' },
    { key: 'e'.repeat(64), kind: 'surface', cell: { id: 'context-web', sourceCaseId: 'context-node22', plugin: 'dsh-context@0.52.0' }, attempts: 1, status: 'accepted' },
  ]
  const after = { ...structuredClone(original), tasks }
  after.nativeLedger.entries[0]!.marker = 'after'
  after.surfaceLedger.entries[0]!.marker = 'after'
  try {
    await mkdir(join(root, 'baseline')); await mkdir(join(root, 'batch'))
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ targetId: 'context', observerTargetId: 'dsh-context', repository: 'bowenliang123/dsh-context', revisions: { from, to } }))
    await writeFile(join(root, 'baseline/state.json'), JSON.stringify(original))
    await writeFile(join(root, 'baseline/summary.json'), JSON.stringify({ ...summary, executed: 0 }))
    await writeFile(join(root, 'batch/state.json'), JSON.stringify(after))
    await writeFile(join(root, 'batch/summary.json'), JSON.stringify(summary))
    for (const task of tasks) {
      const directory = join(root, 'batch/reports', task.kind, task.cell.id, `${task.key}-${task.attempts}`)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'container.json'), JSON.stringify({ id: 'f'.repeat(64), image: `sha256:${'a'.repeat(64)}`,
        user: '10001:10001', mounts: [], readonlyRootfs: true, state: { Running: false, Status: 'exited', ExitCode: 0 } }))
      await writeFile(join(directory, 'report.json'), JSON.stringify({ caseId: task.cell.id, plugin: task.cell.plugin }))
    }
    await execFile(process.execPath, [script, 'execution', root])
    assert.equal((await json(join(root, 'execution-proof.json'))).executed, 2)
    assert.equal((await json(join(root, 'execution-proof.json'))).unchangedPlugins, 1)
    await writeFile(join(root, 'batch/summary.json'), JSON.stringify({ ...summary, executed: 0 }))
    await execFile(process.execPath, [script, 'unchanged', root])
    assert.equal((await json(join(root, 'unchanged-proof.json'))).executed, 0)
    after.nativeLedger.entries[1]!.marker = 'silently changed'
    await writeFile(join(root, 'batch/state.json'), JSON.stringify(after))
    await assert.rejects(execFile(process.execPath, [script, 'execution', root]), /unrelated native evidence/)
    await assert.rejects(execFile(process.execPath, [script, 'unchanged', root]), /unchanged replay altered/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
