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
})
