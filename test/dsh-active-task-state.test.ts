import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyDshActiveTaskState,
  planDshActiveTasks,
  reconcileDshActiveTaskResults,
} from '../src/dsh-active-task-state.js'

const checkedAt = new Date('2026-09-28T08:00:00.000Z')
const cohort = {
  plugins: [
    { id: 'context', spec: 'dsh-context@0.25.3', observerTargetId: 'dsh-context' },
    { id: 'dsh-tui', spec: '@deepseek-harness-tui/dsh-tui@0.9.0', observerTargetId: 'dsh-tui' },
  ],
}
const observations = {
  targets: {
    'deepseek-harness': {
      source: { repository: 'deepseek-ai/deepseek-harness', commit: 'd'.repeat(40) },
      package: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', distTag: 'next', integrity: 'sha512-dsh' },
    },
    'dsh-context': {
      source: { repository: 'bowenliang123/dsh-context', commit: 'c'.repeat(40) },
      package: { name: 'dsh-context', version: '0.57.0', distTag: 'latest', integrity: 'sha512-context' },
    },
    'dsh-tui': {
      source: { repository: 'ccch1mneyyy/dsh-TUI', commit: 'e'.repeat(40) },
      package: { name: '@deepseek-harness-tui/dsh-tui', version: '1.2.0', distTag: 'latest', integrity: 'sha512-tui' },
    },
  },
}

function change(targetId: string, before: string, after: string) {
  return {
    targetId,
    meaningful: true,
    source: { beforeCommit: 'a'.repeat(40), afterCommit: 'b'.repeat(40) },
    previous: { commit: 'a'.repeat(40), manifest: { name: targetId, version: before } },
    current: { commit: 'b'.repeat(40), manifest: { name: targetId, version: after } },
  }
}

describe('durable active Agent task state', () => {
  it('routes one real plugin change, persists it before dispatch, and deduplicates only after completion', () => {
    const first = planDshActiveTasks(cohort, observations, { changes: [change('dsh-context', '0.56.2', '0.57.0')] },
      emptyDshActiveTaskState(), checkedAt)
    assert.equal(first.created, 1)
    assert.equal(first.matrix.include.length, 1)
    assert.equal(first.matrix.include[0]?.targetId, 'context')
    assert.equal(first.matrix.include[0]?.dshChannel, 'next')
    assert.equal(first.state.tasks[0]?.status, 'pending')
    assert.equal(first.state.tasks[0]?.attempts, 1)
    assert.deepEqual(first.state.tasks[0]?.input.plugin, {
      name: 'dsh-context', version: '0.57.0', integrity: 'sha512-context', sourceCommit: 'c'.repeat(40),
    })

    const completed = reconcileDshActiveTaskResults(first.state, first.matrix, [{
      taskId: first.matrix.include[0]!.taskId,
      inputFingerprint: first.matrix.include[0]!.inputFingerprint,
      status: 'completed',
      reportPath: 'examples/dsh/active-agent/reports/result.json',
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
    }], new Date('2026-09-28T09:00:00.000Z'), '123')
    const repeated = planDshActiveTasks(cohort, observations,
      { changes: [change('dsh-context', '0.56.2', '0.57.0')] }, completed, checkedAt)
    assert.equal(repeated.created, 0)
    assert.deepEqual(repeated.matrix.include, [])
    assert.equal(repeated.deduplicated, 1)
  })

  it('fans one exact DSH change out to the configured plugin cohort', () => {
    const plan = planDshActiveTasks(cohort, observations,
      { changes: [change('deepseek-harness', '0.1.7-rc.1', '0.1.7-rc.2')] },
      emptyDshActiveTaskState(), checkedAt)
    assert.deepEqual(plan.matrix.include.map(item => item.targetId), ['context', 'dsh-tui'])
    assert.ok(plan.state.tasks.every(task => task.trigger.kind === 'dsh'))
  })

  it('keeps executor failures pending so the next observer cycle retries the same exact input', () => {
    const first = planDshActiveTasks(cohort, observations, { changes: [change('dsh-context', '0.56.2', '0.57.0')] },
      emptyDshActiveTaskState(), checkedAt)
    const failed = reconcileDshActiveTaskResults(first.state, first.matrix, [{
      taskId: first.matrix.include[0]!.taskId,
      inputFingerprint: first.matrix.include[0]!.inputFingerprint,
      status: 'retryable',
      error: 'runner interrupted',
    }], new Date('2026-09-28T09:00:00.000Z'), '124')
    const retry = planDshActiveTasks(cohort, observations, { changes: [] }, failed,
      new Date('2026-09-28T10:00:00.000Z'))
    assert.equal(retry.matrix.include[0]?.taskId, first.matrix.include[0]?.taskId)
    assert.equal(retry.state.tasks[0]?.attempts, 2)
    assert.equal(retry.state.tasks[0]?.lastFailure, 'runner interrupted')
  })

  it('keeps an interrupted exact task retryable when the live observation point has already advanced', () => {
    const first = planDshActiveTasks(cohort, observations, { changes: [change('dsh-context', '0.56.2', '0.57.0')] },
      emptyDshActiveTaskState(), checkedAt)
    const failed = reconcileDshActiveTaskResults(first.state, first.matrix, [],
      new Date('2026-09-28T09:00:00.000Z'), '124')
    const advanced = structuredClone(observations)
    advanced.targets['deepseek-harness'].source.commit = 'f'.repeat(40)
    advanced.targets['dsh-context'].source.commit = '1'.repeat(40)
    advanced.targets['dsh-context'].package.version = '0.59.0'
    const retry = planDshActiveTasks(cohort, advanced, { changes: [] }, failed,
      new Date('2026-09-28T10:00:00.000Z'))
    assert.equal(retry.matrix.include[0]?.taskId, first.matrix.include[0]?.taskId)
    assert.equal(retry.state.tasks[0]?.status, 'pending')
    assert.equal(retry.state.tasks[0]?.input.plugin.version, '0.57.0')
    assert.equal(retry.state.tasks[0]?.attempts, 2)
  })

  it('supersedes an older pending input only while persisting its newer replacement', () => {
    const first = planDshActiveTasks(cohort, observations, { changes: [change('dsh-context', '0.56.2', '0.57.0')] },
      emptyDshActiveTaskState(), checkedAt)
    const advanced = structuredClone(observations)
    advanced.targets['dsh-context'].source.commit = '1'.repeat(40)
    advanced.targets['dsh-context'].package.version = '0.59.0'
    const next = planDshActiveTasks(cohort, advanced,
      { changes: [change('dsh-context', '0.57.0', '0.59.0')] }, first.state,
      new Date('2026-09-28T10:00:00.000Z'))
    assert.equal(next.created, 1)
    assert.equal(next.state.tasks.find(task => task.id === first.state.tasks[0]?.id)?.status, 'superseded')
    assert.equal(next.matrix.include.length, 1)
    assert.notEqual(next.matrix.include[0]?.taskId, first.matrix.include[0]?.taskId)
    assert.equal(next.state.tasks.find(task => task.id === next.matrix.include[0]?.taskId)?.input.plugin.version, '0.59.0')
  })
})
