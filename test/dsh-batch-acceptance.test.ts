import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { unresolvedDshHostBuildGates } from '../src/dsh-batch-acceptance.js'

it('does not call an unchanged batch closed while a known host native dependency still blocks use', () => {
  const entries = [
    { caseId: 'context-node22-web', result: 'environment-unsupported',
      hostBuildFailures: [{ packageSpec: 'fs-ext@2.1.1' }] },
    { caseId: 'context-node24-web', result: 'compatible', hostBuildFailures: [] },
    { caseId: 'other-node22-web', result: 'unknown', hostBuildFailures: [] },
  ]
  assert.deepEqual(unresolvedDshHostBuildGates(entries), [
    { caseId: 'context-node22-web', packages: ['fs-ext@2.1.1'], reason: 'native-load-failure' },
  ])
  assert.deepEqual(unresolvedDshHostBuildGates(entries.slice(1)), [])
})

it('retains a failed bound host-build attempt as an unresolved dependency gate', () => {
  const entries = [{ caseId: 'context-node22-web', result: 'unknown', hostBuildFailures: [],
    hostBuildExecution: { status: 'failed', requestedApproval: { packages: ['fs-ext@2.1.1'] } } }]
  assert.deepEqual(unresolvedDshHostBuildGates(entries), [
    { caseId: 'context-node22-web', packages: ['fs-ext@2.1.1'], reason: 'host-build-failed' },
  ])
})

it('checks host build gates before the batch validation workflow claims collection closure', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/dsh-rebuild-validation.yml', import.meta.url), 'utf8')
  assert.match(workflow, /unresolvedDshHostBuildGates\(state\.surfaceLedger\.entries\)/)
  assert.match(workflow, /DSH host native build gates remain unresolved/)
  const firstRetry = workflow.indexOf('Retry the batch with its own exact build decisions')
  const refreshedReview = workflow.indexOf('Review refreshed host and surface build facts after retry')
  const refreshedRetry = workflow.indexOf('Retry once more with refreshed exact host facts')
  const unchangedGate = workflow.indexOf('Verify the completed batch does not execute unchanged cells')
  assert.ok(firstRetry >= 0 && firstRetry < refreshedReview && refreshedReview < refreshedRetry && refreshedRetry < unchangedGate,
    'a changed pnpm DLX graph needs a new bounded review before another permission-bound retry')
})
