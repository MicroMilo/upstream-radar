import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { recordDshWebObservationError } from '../../../../../dist/src/dsh-surface-observation.js'
import { emptyDshSurfaceLedger, mergeDshSurfaceLedger } from '../../../../../dist/src/dsh-surface.js'

// Offline producer/receiver regression using preserved CI observations. This
// does not execute the plugin, rewrite its historical reports, or create new
// runtime compatibility evidence.
const root = resolve(import.meta.dirname, '../../../../..')
const batch = join(import.meta.dirname, '../ci-batch-34847607310/batch-output')
const key = 'aaff13b0d8a4126b85e861442c837c877feb2fcc0beac0bbf845871a34da19af'
const state = JSON.parse(await readFile(join(batch, 'state.json'), 'utf8'))
const task = state.tasks.find(task => task.key === key)
assert.equal(task.kind, 'surface')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const cases = []
for (const attempt of [1, 2, 3]) {
  const path = join(batch, 'reports/surface', task.cell.id, `${key}-${attempt}/report.json`)
  const original = await readFile(path)
  const report = JSON.parse(original.toString('utf8'))
  assert.equal(report.result, 'unknown')
  assert.equal(report.evidence.httpStatus, 404)
  assert.equal(report.stages.host.code, null)
  const before = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [task.cell], reports: [report] })
  if (attempt < 3) assert.match(before.rejectedReports.join('\n'), /stages.host.detail/)
  else assert.deepEqual(before.rejectedReports, [])
  const derived = structuredClone(report)
  // The historical report preserves the HTTP observation and no observed exit.
  // Its raw browser exception is unavailable and is not invented: that text is
  // immaterial to the HTTP-failure branch exercised here.
  const evaluation = recordDshWebObservationError(derived, '',
    { exited: false, code: null, output: report.stages.host.detail })
  derived.result = evaluation.result
  derived.reason = evaluation.reason
  assert.equal(derived.result, report.result)
  assert.equal(derived.reason, report.reason)
  assert.equal(derived.stages.surface.status, 'skipped')
  const after = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [task.cell], reports: [derived] })
  assert.deepEqual(after.rejectedReports, [])
  assert.deepEqual(after.acceptedCaseIds, [task.cell.id])
  if (attempt === 3) assert.deepEqual(derived, report, 'An already valid historical report must not change')
  assert.deepEqual(await readFile(path), original, 'Original CI bytes must remain unchanged')
  cases.push({ attempt, report: path.slice(root.length + 1), originalSha256: sha256(original),
    originalDetailLength: report.stages.host.detail.length, originalAccepted: before.acceptedCaseIds.length === 1,
    derivedDetailLength: derived.stages.host.detail.length, derivedAccepted: true, result: derived.result,
    changes: attempt < 3 ? ['stages.host.detail'] : [] })
}
const proof = { scope: 'offline-producer-and-report-receiver-regression', runtimeExecution: false,
  originalRun: 'https://github.com/MicroMilo/upstream-radar/actions/runs/34847607310',
  collectorSourceSha256: sha256(await readFile(join(root, 'src/dsh-surface-observation.ts'))), cases }
await writeFile(join(import.meta.dirname, 'revalidation-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(proof, null, 2))
