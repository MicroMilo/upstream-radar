import assert from 'node:assert/strict'
import { it } from 'node:test'
import { resolveDshActiveCaseLaunchStatus } from '../src/dsh-active-case-launch-state.js'

it('never mistakes an older summary for the newest active launch', () => {
  const launchId = 'a'.repeat(32)
  const previous = 'b'.repeat(32)
  assert.equal(resolveDshActiveCaseLaunchStatus({ running: false }), 'not-started')
  assert.equal(resolveDshActiveCaseLaunchStatus({ running: true, launchId, summaryLaunchId: previous }), 'running')
  assert.equal(resolveDshActiveCaseLaunchStatus({ running: false, launchId, summaryLaunchId: previous,
    exitLaunchId: launchId, exitCode: 2 }), 'failed')
  assert.equal(resolveDshActiveCaseLaunchStatus({ running: false, launchId, summaryLaunchId: previous }), 'interrupted')
  assert.equal(resolveDshActiveCaseLaunchStatus({ running: false, launchId, summaryLaunchId: launchId,
    exitLaunchId: launchId, exitCode: 2 }), 'finished', 'a complete report is available even when some cells failed')
})
