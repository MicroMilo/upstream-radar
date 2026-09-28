import assert from 'node:assert/strict'
import { it } from 'node:test'
import { consumeDshLiveProgress, parseDshLiveProgressLine } from '../src/dsh-live-progress.js'

it('accepts only bounded telemetry for the exact managed case', () => {
  const record = { schema: 'upstream-radar.dsh-live-progress/v1alpha1', caseId: 'plugin-node22',
    observedAt: '2026-09-15T00:00:00.000Z', phase: 'install', kind: 'heartbeat',
    elapsedMs: 1500, stdoutBytes: 42, stderrBytes: 3 }
  const line = `RADAR_PROGRESS:${JSON.stringify(record)}`
  assert.deepEqual(parseDshLiveProgressLine(line, 'plugin-node22'), record)
  assert.equal(parseDshLiveProgressLine(line, 'another-case'), undefined)
  assert.equal(parseDshLiveProgressLine(`untrusted ${line}`, 'plugin-node22'), undefined)
  assert.equal(parseDshLiveProgressLine(`RADAR_PROGRESS:${JSON.stringify({ ...record, stdout: 'secrets' })}`, 'plugin-node22'), undefined)
  assert.equal(parseDshLiveProgressLine(`RADAR_PROGRESS:${JSON.stringify({ ...record, stdoutBytes: -1 })}`, 'plugin-node22'), undefined)
  assert.equal(parseDshLiveProgressLine(`RADAR_PROGRESS:${JSON.stringify({ ...record, phase: 'approve' })}`, 'plugin-node22'), undefined)
  assert.equal(parseDshLiveProgressLine(line.padEnd(2049, 'x'), 'plugin-node22'), undefined)
})

it('consumes split Docker log chunks online without forwarding raw plugin text', async () => {
  const record = { schema: 'upstream-radar.dsh-live-progress/v1alpha1', caseId: 'plugin-node22',
    observedAt: '2026-09-15T00:00:00.000Z', phase: 'install', kind: 'heartbeat',
    elapsedMs: 1500, stdoutBytes: 42, stderrBytes: 3 }
  const line = `RADAR_PROGRESS:${JSON.stringify(record)}\n`
  const seen: unknown[] = []
  async function* chunks() {
    yield Buffer.from(`target says hello\n${line.slice(0, 25)}`)
    yield Buffer.from(line.slice(25))
    yield Buffer.from('not a progress line\n')
  }
  const result = await consumeDshLiveProgress(chunks(), 'plugin-node22', async event => { seen.push(event) })
  assert.deepEqual(seen, [record])
  assert.equal(result.events, 1)
  assert.equal(result.incomplete, false)
})
