import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import { emptyRadarState } from '../src/radar.js'
import { loadRadarState, saveRadarState } from '../src/radar-state.js'
import type { VulnerabilityEvent } from '../src/radar-types.js'
import { TOOL_VERSION } from '../src/version.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = resolve(repository, 'dist/src/cli.js')
const fixture = resolve(repository, 'examples/fixtures/clean-dsh-plugin')

describe('CLI option parsing', () => {
  it('advertises a one-command watch loop and validates its safety interval', () => {
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /setup \[--profile <name>\]/)
    assert.match(help.stdout, /doctor \[config\.json\]/)
    assert.match(help.stdout, /radar watch <config\.json>/)
    assert.match(help.stdout, /radar status <config\.json>/)
    assert.match(help.stdout, /--once\s+run one watch cycle and exit/)
    assert.match(help.stdout, /--frozen\s+radar check\/watch: use the reviewed graph/)
    assert.match(help.stdout, /--fail-on <value>\s+scan\/inspect verdict or radar severity/)
    assert.match(help.stdout, /--fail-on-compatibility <value>\s+CI gate: never\|breaking\|any/)
    assert.match(help.stdout, /--webhook <https-url>\s+radar check\/watch: POST changed events to an HTTPS endpoint/)
    assert.match(help.stdout, /--dsh-patch <path>\s+write a self-contained DSH --patch overlay \(setup default: \.\/upstream-radar\.dsh\.yml\)/)
    assert.match(help.stdout, /--no-dsh-patch\s+setup: keep the legacy UPSTREAM_RADAR_\* environment-variable wiring/)
    assert.match(help.stdout, /probe dsh-load <package\.tgz>/)
    assert.match(help.stdout, /probe dsh-matrix <package\.tgz>/)

    const benchmark = spawnSync(process.execPath, [cli, 'benchmark', 'compatibility', '--json'], { encoding: 'utf8' })
    assert.equal(benchmark.status, 0)
    const benchmarkReport = JSON.parse(benchmark.stdout) as { mode: string; summary: { total: number; failed: number } }
    assert.equal(benchmarkReport.mode, 'offline-rules')
    assert.deepEqual(benchmarkReport.summary, { total: 6, passed: 6, failed: 0 })

    const invalidProbeVersion = spawnSync(process.execPath, [cli, 'probe', 'dsh-load', 'missing.tgz', '--dsh-version', 'latest'], { encoding: 'utf8' })
    assert.equal(invalidProbeVersion.status, 1)
    assert.match(invalidProbeVersion.stderr, /DSH version must be an exact semantic version/)

    const incompleteProbeMatrix = spawnSync(process.execPath, [cli, 'probe', 'dsh-matrix', 'missing.tgz', '--dsh-version', '0.1.0-rc.6'], { encoding: 'utf8' })
    assert.equal(incompleteProbeMatrix.status, 1)
    assert.match(incompleteProbeMatrix.stderr, /at least two exact DSH versions/)

    const blockedDoctor = spawnSync(process.execPath, [cli, 'doctor', resolve(tmpdir(), `upstream-radar-missing-${process.pid}.json`)], { encoding: 'utf8' })
    assert.equal(blockedDoctor.status, 1)
    assert.match(blockedDoctor.stdout, /Status: BLOCKED/)

    const invalid = spawnSync(process.execPath, [cli, 'radar', 'watch', 'missing.json', '--interval', '299'], { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /--interval must be an integer between 300 and 86400/)

    const misplaced = spawnSync(process.execPath, [cli, 'radar', 'compare', 'missing.json', 'before.json', 'candidate.json', '--interval', '1800'], { encoding: 'utf8' })
    assert.equal(misplaced.status, 1)
    assert.match(misplaced.stderr, /radar compare does not accept check or watch options/)

    const insecureWebhook = spawnSync(process.execPath, [cli, 'radar', 'watch', 'missing.json', '--once', '--webhook', 'http://127.0.0.1:8080'], { encoding: 'utf8' })
    assert.equal(insecureWebhook.status, 1)
    assert.match(insecureWebhook.stderr, /webhook URL must use HTTPS/)

    const memoryWebhook = spawnSync(process.execPath, [cli, 'radar', 'watch', 'missing.json', '--once', '--state', ':memory:', '--webhook', 'https://hooks.example.test/incoming'], { encoding: 'utf8' })
    assert.equal(memoryWebhook.status, 1)
    assert.match(memoryWebhook.stderr, /requires a persistent --state file/)
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

    const gated = spawnSync(process.execPath, [cli, 'radar', 'status', config, '--state', missingState, '--fail-on', 'high', '--json'], { encoding: 'utf8' })
    assert.equal(gated.status, 0)
    const gatedReport = JSON.parse(gated.stdout) as { policy: { threshold: string; status: string } }
    assert.deepEqual(gatedReport.policy, { threshold: 'high', status: 'pass', matches: [] })

    const invalidThreshold = spawnSync(process.execPath, [cli, 'radar', 'status', config, '--fail-on', 'severe'], { encoding: 'utf8' })
    assert.equal(invalidThreshold.status, 1)
    assert.match(invalidThreshold.stderr, /invalid radar --fail-on value: severe/)

    const invalidCompatibilityThreshold = spawnSync(process.execPath, [cli, 'radar', 'status', config, '--fail-on-compatibility', 'severe'], { encoding: 'utf8' })
    assert.equal(invalidCompatibilityThreshold.status, 1)
    assert.match(invalidCompatibilityThreshold.stderr, /invalid radar --fail-on-compatibility value: severe/)

    const longRunningGate = spawnSync(process.execPath, [cli, 'radar', 'watch', config, '--fail-on', 'high'], { encoding: 'utf8' })
    assert.equal(longRunningGate.status, 1)
    assert.match(longRunningGate.stderr, /requires --once when a policy gate is used/)

    const longRunningCompatibilityGate = spawnSync(process.execPath, [cli, 'radar', 'watch', config, '--fail-on-compatibility', 'breaking'], { encoding: 'utf8' })
    assert.equal(longRunningCompatibilityGate.status, 1)
    assert.match(longRunningCompatibilityGate.stderr, /requires --once when a policy gate is used/)
  })

  it('prints the local doctor command before the long-running DSH start command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-init-cli-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profile = join(dshHome, 'profiles', 'web')
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        main: './index.js',
      }))

      const config = join(root, 'upstream-radar.config.json')
      const patch = join(root, 'upstream-radar.dsh.yml')
      const result = spawnSync(process.execPath, [
        cli,
        'init',
        '--profile',
        'web',
        '--output',
        config,
        '--dsh-patch',
        patch,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: dshHome },
      })
      assert.equal(result.status, 0)
      const doctorAt = result.stdout.indexOf(' doctor ')
      const dshAt = result.stdout.indexOf('dsh --profile')
      assert.ok(doctorAt >= 0)
      assert.ok(dshAt > doctorAt)
      assert.match(result.stdout, /--patch .*upstream-radar\.dsh\.yml/)
      const savedConfig = JSON.parse(await readFile(config, 'utf8')) as { projects: Array<{ project: { workspace?: string } }> }
      assert.equal(savedConfig.projects[0]?.project.workspace, '.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sets up an exact Radar bundle and verifies the generated DSH wiring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-cli-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profile = join(dshHome, 'profiles', 'web')
      const bin = join(root, 'bin')
      const dshLog = join(root, 'dsh-command.txt')
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await mkdir(bin, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['upstream-radar', 'demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        main: './index.js',
      }))
      await writeFile(join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
        process.platform === 'win32'
          ? '@echo %* > "%UPSTREAM_RADAR_TEST_LOG%"\r\n'
          : '#!/bin/sh\nprintf "%s\\n" "$*" > "$UPSTREAM_RADAR_TEST_LOG"\n',
        { mode: 0o755 })

      const config = join(root, 'upstream-radar.config.json')
      const result = spawnSync(process.execPath, [
        cli,
        'setup',
        '--profile',
        'web',
        '--output',
        config,
      ], {
        encoding: 'utf8',
        cwd: root,
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          UPSTREAM_RADAR_TEST_LOG: dshLog,
        },
      })
      assert.equal(result.status, 0)
      assert.ok(result.stdout.includes(`Installing upstream-radar@${TOOL_VERSION} into DSH profile web`))
      assert.match(result.stdout, /Local wiring check:/)
      assert.match(result.stdout, /Status: READY WITH WARNINGS/)
      assert.match(result.stdout, /Created .*upstream-radar\.dsh\.yml/)
      assert.ok((await readFile(dshLog, 'utf8')).includes(`plugin --profile web add upstream-radar@${TOOL_VERSION}`))
      assert.equal(JSON.parse(await readFile(config, 'utf8')).dshProfile.name, 'web')
      assert.match(await readFile(join(root, 'upstream-radar.dsh.yml'), 'utf8'), /name: 'upstream-radar\/dsh'/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
      const saved = await loadRadarState(stateFile)
      assert.equal(saved.pendingAnalysisTasks.length, 0)
      saved.analysisResults = {
        [event.incidentId]: {
          schema: 'upstream-radar.analysis-result/v1alpha1',
          taskId: task.id,
          incidentId: event.incidentId,
          eventId: event.id,
          deliveryId: 'delivery-cli',
          receivedAt: '2026-08-14T01:02:00.000Z',
          sessionId: 'session-cli',
          userMessageId: 'message-cli',
          assistantMessageId: 'assistant-cli',
          project_exposure: 'likely_exposed',
          confidence: 'medium',
          evidence: ['src/index.ts:12'],
          recommended_action: 'Review the call path.',
          urgency: 'within_24_hours',
          reasoning_summary: 'The model found a likely project path.',
        },
      }
      await saveRadarState(stateFile, saved)
      const analysisList = spawnSync(process.execPath, [cli, 'analysis', 'list', stateFile], { encoding: 'utf8' })
      assert.equal(analysisList.status, 0)
      assert.match(analysisList.stdout, /likely_exposed/)
      const analysisShow = spawnSync(process.execPath, [cli, 'analysis', 'show', stateFile, event.incidentId], { encoding: 'utf8' })
      assert.equal(analysisShow.status, 0)
      assert.match(analysisShow.stdout, /Review the call path/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
