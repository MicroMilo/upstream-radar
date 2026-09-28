import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  inspectDshActiveRunningContainer,
  summarizeDshActiveLiveProgress,
} from '../src/dsh-active-runtime-inspection.js'
import type { DshLiveProgress } from '../src/dsh-live-progress.js'

const caseId = 'fixture-node22'
const targetId = 'fixture'
const taskKey = 'a'.repeat(64)
const task = { key: taskKey, status: 'running', attempts: 1,
  cell: { id: caseId, targetId } }
const containerName = `radar-batch-${taskKey.slice(0, 24)}-1`
const container = { Name: `/${containerName}`,
  Config: { Labels: { 'upstream-radar.task': taskKey }, User: '10001:10001' },
  Mounts: [], HostConfig: { Privileged: false, NetworkMode: 'bridge', ReadonlyRootfs: true },
  State: { Status: 'running', Running: true, OOMKilled: false, ExitCode: 0,
    StartedAt: '2026-09-16T00:00:00.000Z' } }

it('turns repeated healthy worker heartbeats into a bounded no-output hint, never a failure verdict', () => {
  const event = (seconds: number, kind: DshLiveProgress['kind'], stdoutBytes: number): DshLiveProgress => ({
    schema: 'upstream-radar.dsh-live-progress/v1alpha1', caseId,
    observedAt: `2026-09-16T00:00:${String(seconds).padStart(2, '0')}.000Z`,
    phase: 'install', kind, elapsedMs: seconds * 1000, stdoutBytes, stderrBytes: 0,
  })
  const signals = summarizeDshActiveLiveProgress([event(0, 'started', 0),
    event(15, 'heartbeat', 0), event(30, 'heartbeat', 0)], [caseId],
  '2026-09-16T00:00:35.000Z')
  assert.equal(signals.length, 1)
  assert.equal(signals[0]?.phase, 'install')
  assert.equal(signals[0]?.outputIdleMs, 35_000)
  assert.equal(signals[0]?.heartbeatAgeMs, 5_000)
  assert.equal(signals[0]?.signalTrust, 'untrusted-worker-stderr-hint')
  assert.ok(!('pluginFailed' in signals[0]!))
  const progress = summarizeDshActiveLiveProgress([event(0, 'started', 0),
    event(15, 'heartbeat', 20), event(30, 'heartbeat', 20)], [caseId],
  '2026-09-16T00:00:35.000Z')
  assert.equal(progress[0]?.outputIdleMs, 20_000)
  assert.deepEqual(summarizeDshActiveLiveProgress([event(0, 'started', 0)], ['other-target-node22'],
    '2026-09-16T00:00:35.000Z'), [])
})

it('inspects only the exact running isolated task handle before it can guide a cancellation', () => {
  const observed = inspectDshActiveRunningContainer(task, containerName, container, targetId)
  assert.deepEqual(observed, { caseId, taskKey, containerName, status: 'running', running: true,
    oomKilled: false, startedAt: '2026-09-16T00:00:00.000Z',
    trust: 'docker-exact-owned-container-state' })
  for (const changed of [
    { ...container, Config: { ...container.Config, Labels: { 'upstream-radar.task': 'b'.repeat(64) } } },
    { ...container, Mounts: [{ Destination: '/host' }] },
    { ...container, HostConfig: { ...container.HostConfig, NetworkMode: 'host' } },
    { ...container, Config: { ...container.Config, User: '0:0' } },
  ]) assert.throws(() => inspectDshActiveRunningContainer(task, containerName, changed, targetId),
    /ownership|isolation|exact/i)
  assert.throws(() => inspectDshActiveRunningContainer({ ...task,
    cell: { ...task.cell, targetId: 'another-target' } }, containerName, container, targetId), /exact/i)
})
