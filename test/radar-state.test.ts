import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyRadarState } from '../src/radar.js'
import { parseRadarState } from '../src/radar-state.js'

describe('radar state parsing', () => {
  it('accepts the current empty state shape', () => {
    assert.deepEqual(parseRadarState(emptyRadarState()), emptyRadarState())
  })

  it('accepts a state written before source health fields existed', () => {
    const legacy = structuredClone(emptyRadarState()) as unknown as Record<string, unknown>
    delete legacy.sourceHealth
    delete legacy.activeSourceHealth
    assert.deepEqual(parseRadarState(legacy), legacy)
  })

  it('accepts a state written before the transition history field existed', () => {
    const legacy = structuredClone(emptyRadarState()) as unknown as Record<string, unknown>
    delete legacy.history
    assert.deepEqual(parseRadarState(legacy), legacy)
  })

  it('rejects malformed transition history instead of exposing it to the renderer', () => {
    const state = emptyRadarState() as unknown as Record<string, unknown>
    state.history = [{ schema: 'upstream-radar.event/v1alpha1', id: 'event-invalid' }]
    assert.throws(() => parseRadarState(state), /invalid event history/)
  })

  it('accepts a 0.17 compatibility path without the later OSV status field', () => {
    const legacy = emptyRadarState() as unknown as Record<string, any>
    legacy.activeCompatibility = {
      'incident-legacy': {
        key: 'incident-legacy',
        event: {
          schema: 'upstream-radar.event/v1alpha1',
          id: 'event-legacy',
          incidentId: 'incident-legacy',
          kind: 'compatibility',
          upgradePath: {
            evaluated: 1,
            blockedCount: 0,
            firstCandidate: {
              candidate: { ecosystem: 'npm', name: 'plugin', version: '1.1.0' },
              signals: [],
              vulnerabilityRemediation: [{
                incidentId: 'incident-legacy-vulnerability',
                advisoryId: 'GHSA-legacy',
                affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
                status: 'removed',
                reason: 'The checked candidate graph has no matching finding.',
              }],
            },
            remediationCoverage: 'checked',
            firstCandidateRemovingAllPaths: {
              candidate: { ecosystem: 'npm', name: 'plugin', version: '1.1.0' },
              signals: [],
              vulnerabilityRemediation: [{
                incidentId: 'incident-legacy-vulnerability',
                advisoryId: 'GHSA-legacy',
                affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
                status: 'removed',
                reason: 'The checked candidate graph has no matching finding.',
              }],
            },
            blocked: [],
          },
        },
      },
    }
    assert.doesNotThrow(() => parseRadarState(legacy))
  })

  it('accepts a webhook delivery ledger without storing the endpoint URL', () => {
    const state = emptyRadarState() as unknown as Record<string, unknown>
    state.webhook = {
      schema: 'upstream-radar.webhook-delivery/v1alpha1',
      endpointHash: 'a'.repeat(64),
      deliveredEventIds: { 'event-1': '2026-08-16T01:00:00.000Z' },
    }
    assert.doesNotThrow(() => parseRadarState(state))
  })

  it('accepts a bounded pending webhook event for a later retry', () => {
    const state = emptyRadarState() as unknown as Record<string, any>
    state.webhook = {
      schema: 'upstream-radar.webhook-delivery/v1alpha1',
      endpointHash: 'a'.repeat(64),
      deliveredEventIds: {},
      pendingEvents: [{
        schema: 'upstream-radar.event/v1alpha1',
        id: 'event-pending',
        incidentId: 'incident-pending',
        kind: 'compatibility',
        change: 'new',
        detectedAt: '2026-08-16T01:00:00.000Z',
        project: { id: 'project-pending', name: 'Pending project' },
        route: { channels: ['stdout'] },
        plugin: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
        installed: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
        candidate: { ecosystem: 'npm', name: 'plugin', version: '2.0.0' },
        signals: [{ code: 'major', confidence: 'strong', summary: 'Major update.' }],
      }],
    }
    assert.doesNotThrow(() => parseRadarState(state))
  })

  it('rejects a webhook ledger that contains the endpoint instead of its hash', () => {
    const state = emptyRadarState() as unknown as Record<string, any>
    state.webhook = {
      schema: 'upstream-radar.webhook-delivery/v1alpha1',
      endpointHash: 'https://hooks.example.test/incoming',
      deliveredEventIds: {},
    }
    assert.throws(() => parseRadarState(state), /invalid webhook delivery state/)
  })

  it('rejects a queued task without a stable incident identity', () => {
    const state = emptyRadarState() as unknown as Record<string, unknown>
    state.pendingAnalysisTasks = [{
      schema: 'upstream-radar.analysis-task/v1alpha1',
      id: 'analysis-stale',
      createdAt: '2026-08-14T01:00:00.000Z',
      event: {
        schema: 'upstream-radar.event/v1alpha1',
        id: 'event-stale',
        kind: 'compatibility',
      },
    }]
    assert.throws(() => parseRadarState(state), /invalid pending analysis task/)
  })

  it('rejects an oversized persisted source error', () => {
    const state = emptyRadarState() as unknown as Record<string, unknown>
    state.sourceHealth = {
      osv: {
        lastAttemptedAt: '2026-08-14T01:00:00.000Z',
        consecutiveFailures: 3,
        lastError: 'x'.repeat(2_049),
      },
    }
    assert.throws(() => parseRadarState(state), /invalid source health status/)
  })

  it('rejects an analysis result with extra fields', () => {
    const state = emptyRadarState() as unknown as Record<string, any>
    state.analysisResults = {
      'incident-analysis': {
        schema: 'upstream-radar.analysis-result/v1alpha1',
        taskId: 'analysis-1',
        incidentId: 'incident-analysis',
        eventId: 'event-analysis',
        deliveryId: 'delivery-analysis',
        receivedAt: '2026-08-16T01:00:00.000Z',
        sessionId: 'session-analysis',
        userMessageId: 'message-analysis',
        assistantMessageId: 'assistant-analysis',
        project_exposure: 'unknown',
        confidence: 'low',
        evidence: [],
        recommended_action: 'Review the project.',
        urgency: 'monitor',
        reasoning_summary: 'No direct evidence.',
        extra: 'must not be persisted',
      },
    }
    assert.throws(() => parseRadarState(state), /invalid analysis result/)
  })
})
