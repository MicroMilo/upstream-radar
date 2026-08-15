import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import {
  createDshRadarMessage,
  deliverPendingAnalysisTasks,
  deliverPendingAnalysisTasksToAgents,
  groupPendingAnalysisTasks,
  selectDshAgentForProject,
} from '../src/dsh-plugin.js'
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

  it('routes multiple projects by exact DSH session workspace', () => {
    const secondEvent: CompatibilityEvent = {
      ...event,
      id: 'event-compat-second',
      incidentId: 'incident-compat-second',
      project: { id: 'project-b', name: 'Project B', workspace: '/workspace/project-b' },
    }
    const firstTask = createAnalysisTask(event)
    const secondTask = createAnalysisTask(secondEvent)
    const firstMessages: unknown[] = []
    const secondMessages: unknown[] = []
    const firstAgent = {
      session: { header: { cwd: '/workspace/project-a' } },
      followup: (message: unknown) => firstMessages.push(message),
    }
    const secondAgent = {
      session: { header: { cwd: '/workspace/project-b' } },
      followup: (message: unknown) => secondMessages.push(message),
    }

    assert.equal(selectDshAgentForProject(event.project, [firstAgent, secondAgent]), firstAgent)
    assert.equal(selectDshAgentForProject(secondEvent.project, [firstAgent, secondAgent]), secondAgent)
    const state = emptyRadarState()
    state.pendingAnalysisTasks.push(firstTask, secondTask)
    const remaining = deliverPendingAnalysisTasksToAgents(state, [firstAgent, secondAgent])

    assert.equal(remaining.pendingAnalysisTasks.length, 0)
    assert.equal(firstMessages.length, 1)
    assert.equal(secondMessages.length, 1)
    assert.match(JSON.stringify(firstMessages[0]), /Project A/)
    assert.match(JSON.stringify(secondMessages[0]), /Project B/)
  })

  it('keeps a multi-project task queued when no workspace match is trustworthy', () => {
    const state = emptyRadarState()
    state.pendingAnalysisTasks.push(createAnalysisTask(event))
    const messages: unknown[] = []
    const otherAgent = {
      session: { header: { cwd: '/workspace/other' } },
      followup: (message: unknown) => messages.push(message),
    }

    const remaining = deliverPendingAnalysisTasksToAgents(state, [otherAgent, {
      session: { header: { cwd: '/workspace/another' } },
      followup: (message: unknown) => messages.push(message),
    }])

    assert.equal(remaining.pendingAnalysisTasks.length, 1)
    assert.equal(messages.length, 0)
  })

  it('does not guess when two roots advertise the same workspace', () => {
    const matches = [
      { session: { header: { cwd: '/workspace/project-a' } }, followup: () => undefined },
      { session: { header: { cwd: '/workspace/project-a' } }, followup: () => undefined },
    ]
    assert.equal(selectDshAgentForProject(event.project, matches), undefined)
  })

  it('preserves single-root compatibility even without session metadata', () => {
    const state = emptyRadarState()
    state.pendingAnalysisTasks.push(createAnalysisTask(event))
    const messages: unknown[] = []
    const remaining = deliverPendingAnalysisTasksToAgents(state, [{ followup: message => messages.push(message) }])

    assert.equal(remaining.pendingAnalysisTasks.length, 0)
    assert.equal(messages.length, 1)
  })
})
