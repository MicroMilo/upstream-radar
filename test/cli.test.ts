import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import { emptyRadarState } from '../src/radar.js'
import { loadRadarState, saveRadarState } from '../src/radar-state.js'
import type { VulnerabilityEvent } from '../src/radar-types.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = resolve(repository, 'dist/src/cli.js')
const fixture = resolve(repository, 'examples/fixtures/clean-dsh-plugin')

describe('CLI option parsing', () => {
  it('advertises a one-command watch loop and validates its safety interval', () => {
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /doctor \[config\.json\]/)
    assert.match(help.stdout, /radar watch <config\.json>/)
    assert.match(help.stdout, /radar status <config\.json>/)
    assert.match(help.stdout, /--once\s+run one watch cycle and exit/)
    assert.match(help.stdout, /--dsh-patch <path>\s+write a self-contained DSH --patch overlay/)

    const blockedDoctor = spawnSync(process.execPath, [cli, 'doctor', resolve(tmpdir(), `upstream-radar-missing-${process.pid}.json`)], { encoding: 'utf8' })
    assert.equal(blockedDoctor.status, 1)
    assert.match(blockedDoctor.stdout, /Status: BLOCKED/)

    const invalid = spawnSync(process.execPath, [cli, 'radar', 'watch', 'missing.json', '--interval', '299'], { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /--interval must be an integer between 300 and 86400/)

    const misplaced = spawnSync(process.execPath, [cli, 'radar', 'compare', 'missing.json', 'before.json', 'candidate.json', '--interval', '1800'], { encoding: 'utf8' })
    assert.equal(misplaced.status, 1)
    assert.match(misplaced.stderr, /radar compare does not accept check or watch options/)
  })

  it('shows a network-free first-run status snapshot', () => {
    const config = resolve(repository, 'examples/radar/config.json')
    const missingState = resolve(tmpdir(), `upstream-radar-status-${process.pid}-${Date.now()}.json`)
    const result = spawnSync(process.execPath, [cli, 'radar', 'status', config, '--state', missingState], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Monitoring: not started/)
    assert.match(result.stdout, /Active vulnerabilities: 0/)
    assert.match(result.stdout, /No completed check is recorded yet/)

    const json = spawnSync(process.execPath, [cli, 'radar', 'status', config, '--state', missingState, '--json'], { encoding: 'utf8' })
    assert.equal(json.status, 0)
    const report = JSON.parse(json.stdout) as { schema: string; stateExists: boolean; monitoring: string }
    assert.equal(report.schema, 'upstream-radar.radar-status/v1alpha1')
    assert.equal(report.stateExists, false)
    assert.equal(report.monitoring, 'not-started')
  })

  it('rejects unknown options instead of silently weakening a scan', () => {
    const result = spawnSync(process.execPath, [cli, 'scan', fixture, '--jsno'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unknown option for scan: --jsno/)
  })

  it('rejects flags with missing values', () => {
    const result = spawnSync(process.execPath, [cli, 'scan', fixture, '--fail-on'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--fail-on requires a value/)
  })

  it('lists, renders and acknowledges a pending DSH analysis task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-cli-'))
    const stateFile = join(root, 'radar-state.json')
    try {
      const event: VulnerabilityEvent = {
        schema: 'upstream-radar.event/v1alpha1',
        id: 'event-agent-bridge',
        incidentId: 'incident-agent-bridge',
        kind: 'vulnerability',
        change: 'new',
        detectedAt: '2026-08-14T01:00:00.000Z',
        project: { id: 'project-a', name: 'Project A', workspace: '/workspace/project-a' },
        route: { channels: ['stdout'] },
        plugin: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
        affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
        paths: [[
          { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
          { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
        ]],
        advisory: {
          id: 'GHSA-demo',
          aliases: [],
          summary: 'Unsafe parser input handling',
          details: 'Untrusted source material.',
          severity: 'high',
          modified: '2026-08-14T01:00:00.000Z',
          fixedVersions: ['3.0.0'],
          references: [],
        },
      }
      const task = createAnalysisTask(event)
      const state = emptyRadarState()
      state.pendingAnalysisTasks.push(task)
      await saveRadarState(stateFile, state)

      const listed = spawnSync(process.execPath, [cli, 'task', 'list', stateFile], { encoding: 'utf8' })
      assert.equal(listed.status, 0)
      assert.match(listed.stdout, new RegExp(task.id))
      assert.match(listed.stdout, /Project A/)

      const shown = spawnSync(process.execPath, [cli, 'task', 'show', stateFile, task.id], { encoding: 'utf8' })
      assert.equal(shown.status, 0)
      assert.match(shown.stdout, /UPSTREAM RADAR ANALYSIS TASK/)
      assert.match(shown.stdout, /不可信数据/)

      const acknowledged = spawnSync(process.execPath, [cli, 'task', 'ack', stateFile, task.id], { encoding: 'utf8' })
      assert.equal(acknowledged.status, 0)
      assert.match(acknowledged.stdout, /Acknowledged/)
      assert.equal((await loadRadarState(stateFile)).pendingAnalysisTasks.length, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
