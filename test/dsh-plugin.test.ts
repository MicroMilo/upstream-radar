import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import { createDshRadarMessage, deliverPendingAnalysisTasks, groupPendingAnalysisTasks } from '../src/dsh-plugin.js'
import { emptyRadarState } from '../src/radar.js'
import type { CompatibilityEvent, SourceHealthEvent } from '../src/radar-types.js'

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

const sourceHealthEvent: SourceHealthEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-source-health',
  incidentId: 'project-a\u0000osv',
  kind: 'source-health',
  change: 'new',
  detectedAt: '2026-08-14T04:00:00.000Z',
  project: { id: 'project-a', name: 'Project A', workspace: '/workspace/project-a' },
  route: { owner: 'platform', channels: ['stdout'] },
  source: 'osv',
  status: 'degraded',
  failureCount: 3,
  lastAttemptedAt: '2026-08-14T04:00:00.000Z',
  error: 'OSV timeout',
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

  it('routes a source-health incident as a useful DSH notice', () => {
    const message = createDshRadarMessage(createAnalysisTask(sourceHealthEvent))
    assert.equal(message.source.summary, 'Monitoring source degraded for Project A')
    assert.match(message.content[0]?.text ?? '', /监控源当前不可用/)
  })

  it('groups one project\'s DSH runtime updates without merging unrelated incidents', () => {
    const dshAgent = createAnalysisTask({
      ...event,
      id: 'event-dsh-agent',
      incidentId: 'incident-dsh-agent',
      installed: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' },
      candidate: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.2.0' },
    })
    const dshSession = createAnalysisTask({
      ...event,
      id: 'event-dsh-session',
      incidentId: 'incident-dsh-session',
      installed: { ecosystem: 'npm', name: '@deepseek-ai/dsh-session', version: '0.1.0-rc.6' },
      candidate: { ecosystem: 'npm', name: '@deepseek-ai/dsh-session', version: '0.2.0' },
    })
    const unrelated = createAnalysisTask(sourceHealthEvent)
    const groups = groupPendingAnalysisTasks([dshAgent, unrelated, dshSession])
    assert.deepEqual(groups.map(group => group.length), [2, 1])

    const state = emptyRadarState()
    state.pendingAnalysisTasks.push(dshAgent, unrelated, dshSession)
    const messages: Array<{ content: Array<{ text: string }>; source: { summary: string } }> = []
    const remaining = deliverPendingAnalysisTasks(state, { followup: message => messages.push(message) })
    assert.equal(remaining.pendingAnalysisTasks.length, 0)
    assert.equal(messages.length, 2)
    assert.match(messages[0]?.content[0]?.text ?? '', /@deepseek-ai\/dsh-agent/)
    assert.match(messages[0]?.content[0]?.text ?? '', /@deepseek-ai\/dsh-session/)
    assert.match(messages[0]?.source.summary ?? '', /DSH runtime compatibility changes \(2\)/)
  })
})
