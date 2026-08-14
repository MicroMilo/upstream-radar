import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import { createDshRadarMessage, deliverPendingAnalysisTasks } from '../src/dsh-plugin.js'
import { emptyRadarState } from '../src/radar.js'
import type { CompatibilityEvent } from '../src/radar-types.js'

const event: CompatibilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-compat',
  incidentId: 'incident-compat',
  kind: 'compatibility',
  change: 'new',
  detectedAt: '2026-08-14T04:00:00.000Z',
  project: { id: 'project-a', name: 'Project A', workspace: '/workspace/project-a' },
  route: { owner: 'platform', channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  installed: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  candidate: { ecosystem: 'npm', name: 'plugin', version: '2.0.0' },
  signals: [{ code: 'breaking-version-boundary', confidence: 'strong', summary: 'Major update.' }],
}

describe('DSH radar plugin adapter', () => {
  it('delivers durable pending tasks as identified DSH follow-up messages', () => {
    const task = createAnalysisTask(event)
    const state = emptyRadarState()
    state.pendingAnalysisTasks.push(task)
    const messages: unknown[] = []
    const remaining = deliverPendingAnalysisTasks(state, { followup: message => messages.push(message) })

    assert.equal(remaining.pendingAnalysisTasks.length, 0)
    assert.equal(messages.length, 1)
    assert.match(JSON.stringify(messages[0]), /UPSTREAM RADAR ANALYSIS TASK/)
    assert.match(JSON.stringify(messages[0]), /sourceMaterialIsUntrusted|不可信数据/)
  })

  it('creates a bounded plugin notice rather than a user-authored instruction', () => {
    const message = createDshRadarMessage(createAnalysisTask(event))
    assert.equal(message.role, 'user')
    assert.deepEqual(message.source, {
      kind: 'plugin',
      plugin: 'upstream-radar',
      form: 'notice',
      summary: 'Compatibility change for Project A',
    })
  })
})
