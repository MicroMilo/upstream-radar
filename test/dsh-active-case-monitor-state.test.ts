import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createDshActiveCaseMonitorState,
  dshActiveCaseMonitorCovered,
  recordDshActiveCaseMonitorAction,
} from '../src/dsh-active-case-monitor-state.js'

describe('trusted proactive-agent monitoring receipt', () => {
  it('counts only online watches and events for the exact current launch', () => {
    let state = createDshActiveCaseMonitorState('cloudflare-browser')
    state = recordDshActiveCaseMonitorAction(state, 'launch', {
      started: true, status: 'running', launchId: 'a'.repeat(32),
    })
    state = recordDshActiveCaseMonitorAction(state, 'watch', {
      status: 'running', launchId: 'b'.repeat(32), events: [{ phase: 'install' }],
    })
    state = recordDshActiveCaseMonitorAction(state, 'watch', {
      status: 'finished', launchId: 'a'.repeat(32), events: [{ phase: 'load' }],
    })
    assert.equal(state.runningWatches, 0)
    assert.equal(state.runningEvents, 0)
    state = recordDshActiveCaseMonitorAction(state, 'watch', {
      status: 'running', launchId: 'a'.repeat(32), events: [{ phase: 'install' }, { phase: 'load' }],
    })
    assert.equal(state.runningWatches, 1)
    assert.equal(state.runningEvents, 2)
    state = recordDshActiveCaseMonitorAction(state, 'launch', {
      started: true, status: 'running', launchId: 'c'.repeat(32),
    })
    assert.equal(state.launchId, 'c'.repeat(32))
    assert.equal(state.runningWatches, 0)
    assert.equal(state.runningEvents, 0)
  })

  it('does not count a rejected, idle or malformed watch as proactive observation', () => {
    let state = createDshActiveCaseMonitorState('context')
    state = recordDshActiveCaseMonitorAction(state, 'launch', {
      started: true, status: 'running', launchId: 'd'.repeat(32),
    })
    for (const response of [
      { status: 'idle', launchId: 'd'.repeat(32), events: [] },
      { status: 'running', launchId: 'd'.repeat(32), events: 'not-an-array' },
      { status: 'running', launchId: 'not-a-valid-id', events: [{ phase: 'install' }] },
    ]) state = recordDshActiveCaseMonitorAction(state, 'watch', response)
    assert.equal(state.runningWatches, 0)
    assert.equal(state.runningEvents, 0)
  })

  it('rejects one early watch of a long healthy run and accepts repeated live monitoring', () => {
    const launchId = 'e'.repeat(32)
    let state = createDshActiveCaseMonitorState('context')
    state = recordDshActiveCaseMonitorAction(state, 'launch', {
      started: true, status: 'running', launchId,
    }, '2026-09-16T00:00:00.000Z')
    state = recordDshActiveCaseMonitorAction(state, 'watch', {
      status: 'running', launchId, events: [{ phase: 'install' }],
    }, '2026-09-16T00:00:10.000Z')
    assert.equal(dshActiveCaseMonitorCovered(state, launchId, '2026-09-16T00:02:00.000Z', 45_000), false)
    for (const second of [25, 40, 55, 70, 85, 100, 115]) {
      state = recordDshActiveCaseMonitorAction(state, 'watch', {
        status: 'running', launchId, events: [{ phase: 'install' }],
      }, `2026-09-16T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`)
    }
    assert.equal(state.runningWatches, 8)
    assert.equal(dshActiveCaseMonitorCovered(state, launchId, '2026-09-16T00:02:00.000Z', 45_000), true)
  })

  it('does not let a stale launch monitor receipt satisfy a new case', () => {
    const launchId = 'f'.repeat(32)
    let state = createDshActiveCaseMonitorState('context')
    state = recordDshActiveCaseMonitorAction(state, 'launch', {
      started: true, status: 'running', launchId,
    }, '2026-09-16T00:00:00.000Z')
    state = recordDshActiveCaseMonitorAction(state, 'watch', {
      status: 'running', launchId, events: [{ phase: 'load' }],
    }, '2026-09-16T00:00:10.000Z')
    assert.equal(dshActiveCaseMonitorCovered(state, 'a'.repeat(32), '2026-09-16T00:00:20.000Z', 45_000), false)
    assert.equal(dshActiveCaseMonitorCovered(state, launchId, '2026-09-16T00:00:20.000Z', 45_000), true)
  })
})
