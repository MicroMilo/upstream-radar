import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { buildDshSurfaceIR, emptyDshSurfaceLedger, mergeDshSurfaceLedger } from '../../../../../dist/src/dsh-surface.js'

const [directory] = process.argv.slice(2)
assert.ok(directory, 'Pass one completed focused regression directory')
const output = resolve(directory)
const project = resolve(import.meta.dirname, '../../../../..')
const json = async name => JSON.parse(await readFile(join(output, name), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const [inputs, handle, report, container, attachments] = await Promise.all(
  ['source-inputs.json', 'handle.json', 'report.json', 'container.json', 'attachments.json'].map(json))
assert.ok(inputs.length < 2048)
for (const [path, expected] of inputs) {
  assert.ok(typeof path === 'string' && !path.split('/').some(part => part === '..' || part === '.' || part === ''))
  assert.ok(/^(src\/|test\/)/.test(path) || ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'docker/dsh-surface-observer.Dockerfile'].includes(path))
  assert.equal(sha(await readFile(join(project, path))), expected, `Source changed after this regression: ${path}`)
}
assert.equal(sha(JSON.stringify(inputs)), handle.sourceIdentity)
assert.equal(basename(output), handle.sourceIdentity)
assert.equal(container.id, handle.id)
assert.equal(container.imageId, handle.imageId)
assert.equal(container.state.Running, false)
assert.equal(container.state.ExitCode, 0)
assert.equal(report.executionContract, handle.executionContract)
assert.equal(report.result, 'environment-unsupported')
const log = attachments.attachments.find(item => item.name === report.evidence.hostLog)
assert.ok(log)
const hostLogSha256 = sha(Buffer.from(log.base64, 'base64'))
assert.ok(report.hostBuildFailures.length > 0)
for (const failure of report.hostBuildFailures) assert.equal(failure.outputSha256, hostLogSha256)
assert.deepEqual(attachments.gaps, [])
const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [{ ...handle.cell, reasons: ['operator-owned focused observer regression'] }], reports: [report] })
assert.deepEqual(merged.rejectedReports, [])
assert.deepEqual(merged.acceptedCaseIds, [handle.cell.id])
const ir = buildDshSurfaceIR(merged.ledger)
assert.deepEqual(ir.cells[0].observation.hostBuildInventory, report.hostBuildInventory)
assert.deepEqual(ir.cells[0].observation.hostBuildFailures, report.hostBuildFailures)
assert.equal(merged.ledger.entries[0].requiredDependencyBuilds, undefined)
assert.equal(merged.ledger.entries[0].approvedDependencyBuilds, undefined)
await writeFile(join(output, 'reconciliation-proof.json'), JSON.stringify({ sourceIdentity: handle.sourceIdentity, sourceFiles: inputs.length,
  containerId: handle.id, imageId: handle.imageId, executionContract: report.executionContract, hostLogSha256,
  acceptedCaseIds: merged.acceptedCaseIds, result: report.result,
  verified: { currentSourceMatchesImageInputs: true, failureBoundToSavedLog: true, reportAccepted: true, hostFactsPreservedInIR: true,
    pluginBuildPermissionsUnchanged: true },
  scope: 'Focused real observer and report-ingestion regression, not repository inference, a native arm64 verdict, the whole batch or a recovery test.' }, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ sourceIdentity: handle.sourceIdentity, accepted: merged.acceptedCaseIds, result: report.result, hostLogSha256 }))
