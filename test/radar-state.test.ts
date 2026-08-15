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
})
