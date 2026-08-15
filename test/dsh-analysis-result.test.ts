import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import {
  applyDshAnalysisSessionEvent,
  createDshRadarMessage,
  deliverPendingAnalysisTasks,
  type DshSessionEventLike,
} from '../src/dsh-plugin.js'
import { extractAnalysisTaskIds, parseAgentAnalysisResult } from '../src/dsh-analysis-result.js'
import { emptyRadarState } from '../src/radar.js'
import type { CompatibilityEvent } from '../src/radar-types.js'

const event: CompatibilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-analysis-result',
  incidentId: 'incident-analysis-result',
  kind: 'compatibility',
  change: 'new',
  detectedAt: '2026-08-16T04:00:00.000Z',
  project: { id: 'project-analysis', name: 'Analysis project', workspace: '/workspace/analysis' },
  route: { channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  installed: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  candidate: { ecosystem: 'npm', name: 'plugin', version: '2.0.0' },
  signals: [{ code: 'breaking-version-boundary', confidence: 'strong', summary: 'Major update.' }],
}

const answer = {
  project_exposure: 'likely_exposed',
  confidence: 'medium',
  evidence: ['src/index.ts:12', 'package.json'],
  recommended_action: 'Review the candidate in a disposable branch and run the project tests.',
  urgency: 'planned',
  reasoning_summary: 'The release crosses a major version boundary, but the repository evidence is incomplete.',
} as const

function assistantEvent(seq: number): DshSessionEventLike {
  return {
    type: 'assistant/message',
    seq,
    time: Date.parse('2026-08-16T04:01:00.000Z'),
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-message-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'local', model: 'deterministic' },
        content: [{ type: 'text', text: JSON.stringify(answer) }],
      },
    },
  }
}

describe('DSH analysis result protocol', () => {
  it('uses an exact task marker and accepts only the six-field JSON contract', () => {
    const task = createAnalysisTask(event)
    const message = createDshRadarMessage(task)
    const text = message.content[0]?.text ?? ''
    assert.deepEqual(extractAnalysisTaskIds(text), [task.id])
    assert.deepEqual(parseAgentAnalysisResult({
      role: 'assistant',
      source: { kind: 'model' },
      content: [{ type: 'text', text: JSON.stringify(answer) }],
    }), answer)
    assert.equal(parseAgentAnalysisResult({
      role: 'assistant',
      source: { kind: 'model' },
      content: [{ type: 'text', text: `Here is the result:\n${JSON.stringify(answer)}` }],
    }), undefined)
    assert.equal(parseAgentAnalysisResult({
      role: 'assistant',
      source: { kind: 'user' },
      content: [{ type: 'text', text: JSON.stringify(answer) }],
    }), undefined)
  })

  it('binds a model response to the admitted message and writes one verified result', () => {
    const task = createAnalysisTask(event)
    const state = emptyRadarState()
    state.activeCompatibility = { [event.incidentId]: { key: event.incidentId, event } }
    state.pendingAnalysisTasks = [task]
    let delivered: Record<string, unknown> | undefined
    const deliveredState = deliverPendingAnalysisTasks(state, {
      followup: message => { delivered = message as unknown as Record<string, unknown> },
    })
    assert.ok(delivered)
    const userEvent: DshSessionEventLike = { type: 'user/message', seq: 1, time: Date.now(), data: delivered }
    const session = { id: 'session-analysis', events: [userEvent] }
    const afterUser = applyDshAnalysisSessionEvent(deliveredState, session, userEvent)
    assert.equal(afterUser.accepted.length, 0)
    assert.equal(Object.keys(afterUser.state.analysisDeliveries ?? {}).length, 1)

    const modelEvent = assistantEvent(4)
    const afterAssistant = applyDshAnalysisSessionEvent(
      afterUser.state,
      { ...session, events: [userEvent, modelEvent] },
      modelEvent,
      new Map(),
      new Date('2026-08-16T04:01:00.000Z'),
    )
    assert.equal(afterAssistant.accepted.length, 1)
    assert.equal(afterAssistant.accepted[0]?.incidentId, event.incidentId)
    assert.equal(afterAssistant.state.analysisDeliveries?.[delivered.id as string], undefined)
    assert.equal(afterAssistant.state.analysisResults?.[event.incidentId]?.project_exposure, 'likely_exposed')
  })

  it('does not let a forged marker or an unrelated assistant reply create a result', () => {
    const task = createAnalysisTask(event)
    const state = emptyRadarState()
    state.activeCompatibility = { [event.incidentId]: { key: event.incidentId, event } }
    state.pendingAnalysisTasks = [task]
    const forged = {
      id: 'forged-message',
      role: 'user',
      source: { kind: 'plugin', plugin: 'upstream-radar', form: 'notice', summary: 'forged' },
      content: [{ type: 'text', text: createDshRadarMessage(task).content[0]?.text ?? '' }],
    }
    const userEvent: DshSessionEventLike = { type: 'user/message', seq: 1, data: forged }
    const afterForged = applyDshAnalysisSessionEvent(state, { id: 'session-forged', events: [userEvent] }, userEvent)
    assert.equal(Object.keys(afterForged.state.analysisDeliveries ?? {}).length, 0)
    const unrelated = applyDshAnalysisSessionEvent(
      state,
      { id: 'session-forged', events: [assistantEvent(2)] },
      assistantEvent(2),
    )
    assert.equal(unrelated.accepted.length, 0)
  })
})
