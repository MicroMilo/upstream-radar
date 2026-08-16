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
    assert.match(help.stdout, /init --pnpm-lock <pnpm-lock\.yaml> \[--root <package>@<exact-version>\]/)
    assert.match(help.stdout, /init --npm-lock <package-lock\.json> \[--root <package>@<exact-version>\]/)
    assert.match(help.stdout, /--pnpm-lock <path>\s+init: build a static inventory from a pnpm v6\/v9 lockfile/)
    assert.match(help.stdout, /--npm-lock <path>\s+init: build a static inventory from an npm v2\/v3 package-lock\.json/)
    assert.match(help.stdout, /radar watch <config\.json>/)
    assert.match(help.stdout, /radar status <config\.json>/)
    assert.match(help.stdout, /radar next <config\.json>/)
    assert.match(help.stdout, /radar history <config\.json>/)
    assert.match(help.stdout, /triage <state\.json> <incident-id> --status .*--due <ISO-8601>/)
    assert.match(help.stdout, /graph <npm-lock\|pnpm-lock> <lockfile> \[--root <package>@<exact-version>\]/)
    assert.match(help.stdout, /--once\s+run one watch cycle and exit/)
    assert.match(help.stdout, /--frozen\s+radar check\/watch: use the reviewed graph/)
    assert.match(help.stdout, /--fail-on <value>\s+scan\/inspect verdict or radar severity/)
    assert.match(help.stdout, /--fail-on-compatibility <value>\s+CI gate: never\|breaking\|any/)
    assert.match(help.stdout, /--webhook <https-url>\s+radar check\/watch: POST changed events to an HTTPS endpoint/)
    assert.match(help.stdout, /--webhook-url-env <name>/)
    assert.match(help.stdout, /--webhook-secret-env <name>/)
    assert.match(help.stdout, /--dsh-patch <path>\s+write a self-contained DSH --patch overlay \(setup default: \.\/upstream-radar\.dsh\.yml\)/)
    assert.match(help.stdout, /--no-dsh-patch\s+setup: keep the legacy UPSTREAM_RADAR_\* environment-variable wiring/)
    assert.match(help.stdout, /probe dsh-load <package\.tgz>/)
    assert.match(help.stdout, /probe dsh-matrix <package\.tgz>/)
    assert.match(help.stdout, /demo \[--json\]/)

    const demo = spawnSync(process.execPath, [cli, 'demo'], { encoding: 'utf8' })
    assert.equal(demo.status, 0)
    assert.match(demo.stdout, /network-free; no DSH profile required/)
    assert.match(demo.stdout, /demo-plugin@1\.0\.0 -> logger@4\.0\.2 -> parser@2\.9\.0/)
    assert.match(demo.stdout, /Try it for real:/)

    const demoJson = spawnSync(process.execPath, [cli, 'demo', '--json'], { encoding: 'utf8' })
    assert.equal(demoJson.status, 0)
    const demoReport = JSON.parse(demoJson.stdout) as { schema: string; networkFree: boolean; analysisTask: { constraints: { readOnly: boolean } } }
    assert.equal(demoReport.schema, 'upstream-radar.demo/v1alpha1')
    assert.equal(demoReport.networkFree, true)
    assert.equal(demoReport.analysisTask.constraints.readOnly, true)

    const invalidDemo = spawnSync(process.execPath, [cli, 'demo', '--unexpected'], { encoding: 'utf8' })
    assert.equal(invalidDemo.status, 1)
    assert.match(invalidDemo.stderr, /unknown option for demo/)

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

  it('offers self-contained help for the first-use commands', () => {
    const setupHelp = spawnSync(process.execPath, [cli, 'setup', '--help'], { encoding: 'utf8' })
    assert.equal(setupHelp.status, 0)
    assert.match(setupHelp.stdout, /install the exact Radar bundle into DSH/)
    assert.match(setupHelp.stdout, /Review the generated files/)
    assert.match(setupHelp.stdout, /notificationPolicy/)
    assert.match(setupHelp.stdout, /--minimum-severity <level>/)
    assert.match(setupHelp.stdout, /--quiet-hours <tz,start-end>/)
    assert.match(setupHelp.stdout, /--webhook-url-env <name>/)
    assert.match(setupHelp.stdout, /--webhook-secret-env <name>/)
    assert.match(setupHelp.stdout, /--start\s+start DSH after the local wiring check passes/)
    assert.doesNotMatch(setupHelp.stderr, /unknown option/)

    const initHelp = spawnSync(process.execPath, [cli, 'init', '--help'], { encoding: 'utf8' })
    assert.equal(initHelp.status, 0)
    assert.match(initHelp.stdout, /--minimum-severity <level>/)
    assert.match(initHelp.stdout, /--quiet-hours <tz,start-end>/)
    assert.match(initHelp.stdout, /--webhook-url-env <name>/)
    assert.match(initHelp.stdout, /--webhook-secret-env <name>/)

    const invalidNotificationSeverity = spawnSync(process.execPath, [cli, 'init', '--minimum-severity', 'severe'], { encoding: 'utf8' })
    assert.equal(invalidNotificationSeverity.status, 1)
    assert.match(invalidNotificationSeverity.stderr, /--minimum-severity must be info, low, medium, high or critical/)

    const invalidQuietHours = spawnSync(process.execPath, [cli, 'init', '--quiet-hours', 'Asia/Shanghai,22:00-22:00'], { encoding: 'utf8' })
    assert.equal(invalidQuietHours.status, 1)
    assert.match(invalidQuietHours.stderr, /--quiet-hours must use <IANA timezone>,<HH:MM>-<HH:MM>/)

    const inspectHelp = spawnSync(process.execPath, [cli, 'inspect', '--help'], { encoding: 'utf8' })
    assert.equal(inspectHelp.status, 0)
    assert.match(inspectHelp.stdout, /inspect one exact npm artifact before installation/)
    assert.match(inspectHelp.stdout, /empty finding list is not\s+a safety certificate/)

    const statusHelp = spawnSync(process.execPath, [cli, 'radar', 'status', '--help'], { encoding: 'utf8' })
    assert.equal(statusHelp.status, 0)
    assert.match(statusHelp.stdout, /see the local monitoring snapshot/)
    assert.match(statusHelp.stdout, /never polls OSV, npm, GitHub, or DSH/)
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
      assert.match(result.stdout, /npx --yes upstream-radar@[^ ]+ doctor/)
      assert.match(result.stdout, /npx --yes upstream-radar@[^ ]+ radar status .*--state/)
      assert.doesNotMatch(result.stdout, /pnpm dlx --package=upstream-radar@[^ ]+ upstream-radar doctor/)
      assert.match(result.stdout, /--patch .*upstream-radar\.dsh\.yml/)
      const savedConfig = JSON.parse(await readFile(config, 'utf8')) as { projects: Array<{ project: { workspace?: string } }> }
      assert.equal(savedConfig.projects[0]?.project.workspace, '.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('initializes a monitorable config directly from a pnpm lockfile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-pnpm-init-cli-'))
    try {
      const lockfile = join(root, 'pnpm-lock.yaml')
      const config = join(root, 'upstream-radar.config.json')
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
      }))
      await writeFile(lockfile, `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      demo-plugin:
        specifier: 1.0.0
        version: 1.0.0

packages:
  'demo-plugin@1.0.0': {}
  'parser@2.9.0': {}

snapshots:
  'demo-plugin@1.0.0':
    dependencies:
      parser: 2.9.0
  'parser@2.9.0': {}
`)
      const result = spawnSync(process.execPath, [
        cli,
        'init',
        '--pnpm-lock',
        lockfile,
        '--output',
        config,
        '--project-name',
        'Demo plugin',
      ], { encoding: 'utf8', cwd: root })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /Source: pnpm-lock/)
      assert.match(result.stdout, /Next: upstream-radar radar check/)
      const saved = JSON.parse(await readFile(config, 'utf8')) as {
        dshProfile?: unknown
        projects: Array<{ plugins: Array<{ graph: { source?: string; nodes: unknown[] } }> }>
      }
      assert.equal(saved.dshProfile, undefined)
      assert.equal(saved.projects[0]?.plugins[0]?.graph.source, 'pnpm-lock')
      assert.equal(saved.projects[0]?.plugins[0]?.graph.nodes.length, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires an explicit root when a lockfile has no adjacent package manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-pnpm-root-cli-'))
    try {
      const lockfile = join(root, 'pnpm-lock.yaml')
      await writeFile(lockfile, "lockfileVersion: '9.0'\n")
      const result = spawnSync(process.execPath, [
        cli,
        'init',
        '--pnpm-lock',
        lockfile,
      ], { encoding: 'utf8', cwd: root })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /could not infer the pnpm lockfile root from .*package\.json; pass --root <package>@<exact-version>/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('initializes and graphs an npm lockfile without a repeated root coordinate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-npm-init-cli-'))
    try {
      const lockfile = join(root, 'package-lock.json')
      const config = join(root, 'upstream-radar.config.json')
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
      }))
      await writeFile(lockfile, JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'demo-plugin',
            version: '1.0.0',
            dependencies: { parser: '2.9.0' },
          },
          'node_modules/parser': { version: '2.9.0' },
        },
      }))

      const graph = spawnSync(process.execPath, [
        cli,
        'graph',
        'npm-lock',
        lockfile,
        '--json',
      ], { encoding: 'utf8', cwd: root })
      assert.equal(graph.status, 0)
      const savedGraph = JSON.parse(graph.stdout) as { source?: string; rootNodeId?: string; nodes: unknown[]; edges: unknown[] }
      assert.equal(savedGraph.source, 'npm-lock')
      assert.equal(savedGraph.rootNodeId, 'npm:workspace-root:demo-plugin@1.0.0')
      assert.equal(savedGraph.nodes.length, 2)
      assert.equal(savedGraph.edges.length, 1)

      const result = spawnSync(process.execPath, [
        cli,
        'init',
        '--npm-lock',
        lockfile,
        '--output',
        config,
      ], { encoding: 'utf8', cwd: root })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /Source: npm-lock/)
      const saved = JSON.parse(await readFile(config, 'utf8')) as {
        projects: Array<{ plugins: Array<{ graph: { source?: string; nodes: unknown[] } }> }>
      }
      assert.equal(saved.projects[0]?.plugins[0]?.graph.source, 'npm-lock')
      assert.equal(saved.projects[0]?.plugins[0]?.graph.nodes.length, 2)
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
        '--output',
        config,
        '--minimum-severity',
        'high',
        '--quiet-hours',
        'Asia/Shanghai,22:00-08:00',
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
      const saved = JSON.parse(await readFile(config, 'utf8')) as {
        dshProfile: { name: string }
        projects: Array<{ notificationPolicy?: unknown }>
      }
      assert.equal(saved.dshProfile.name, 'web')
      assert.deepEqual(saved.projects[0]?.notificationPolicy, {
        minimumSeverity: 'high',
        quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
      })
      assert.match(await readFile(join(root, 'upstream-radar.dsh.yml'), 'utf8'), /name: 'upstream-radar\/dsh'/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('can explicitly start DSH after the local wiring check passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-start-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profile = join(dshHome, 'profiles', 'web')
      const bin = join(root, 'bin')
      const dshLog = join(root, 'dsh-commands.txt')
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
          ? '@echo %* >> "%UPSTREAM_RADAR_TEST_LOG%"\r\n'
          : '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UPSTREAM_RADAR_TEST_LOG"\n',
        { mode: 0o755 })

      const result = spawnSync(process.execPath, [cli, 'setup', '--output', 'upstream-radar.config.json', '--start'], {
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
      assert.match(result.stdout, /Starting DSH profile web/)
      const commands = (await readFile(dshLog, 'utf8')).trim().split('\n')
      assert.equal(commands[0], `plugin --profile web add upstream-radar@${TOOL_VERSION}`)
      assert.equal(commands[1], '--profile web --patch upstream-radar.dsh.yml')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not start DSH when the local wiring check is blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-start-blocked-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profile = join(dshHome, 'profiles', 'web')
      const bin = join(root, 'bin')
      const dshLog = join(root, 'dsh-commands.txt')
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await mkdir(bin, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        main: './index.js',
      }))
      await writeFile(join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
        process.platform === 'win32'
          ? '@echo %* >> "%UPSTREAM_RADAR_TEST_LOG%"\r\n'
          : '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UPSTREAM_RADAR_TEST_LOG"\n',
        { mode: 0o755 })

      const result = spawnSync(process.execPath, [cli, 'setup', '--profile', 'web', '--no-install', '--start'], {
        encoding: 'utf8',
        cwd: root,
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          UPSTREAM_RADAR_TEST_LOG: dshLog,
        },
      })
      assert.equal(result.status, 1)
      assert.match(result.stdout, /Status: BLOCKED/)
      await assert.rejects(readFile(dshLog, 'utf8'), { code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('explains how to recover when the DSH command is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-missing-dsh-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profile = join(dshHome, 'profiles', 'web')
      const missingPath = join(root, 'no-dsh-bin')
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['upstream-radar', 'demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        main: './index.js',
      }))

      const result = spawnSync(process.execPath, [cli, 'setup', '--profile', 'web'], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, DSH_HOME: dshHome, PATH: missingPath },
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /could not find the `dsh` command/)
      assert.match(result.stderr, /verify `dsh --help` works/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('explains when setup needs an explicit profile in a multi-profile DSH home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-multiple-profiles-'))
    try {
      const dshHome = join(root, 'dsh-home')
      for (const profileName of ['api', 'web']) {
        const profile = join(dshHome, 'profiles', profileName)
        await mkdir(profile, { recursive: true })
        await writeFile(join(profile, 'package.json'), JSON.stringify({
          name: `dsh-profile-${profileName}`,
          dsh: { profile: { bundles: ['demo-plugin'] } },
        }))
      }

      const result = spawnSync(process.execPath, [cli, 'setup'], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, DSH_HOME: dshHome },
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /multiple DSH profiles with third-party bundles \(api, web\); pass --profile <name>/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('explains how to prepare a DSH profile with no third-party plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-empty-profile-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profile = join(dshHome, 'profiles', 'web')
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }))

      const result = spawnSync(process.execPath, [cli, 'setup', '--profile', 'web', '--no-install'], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, DSH_HOME: dshHome },
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /has no third-party bundles to monitor/)
      assert.match(result.stderr, /dsh plugin --profile <name> add <package>@<exact-version>/)
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
      state.activeVulnerabilities = {
        [event.incidentId]: { key: event.incidentId, event },
      }
      state.pendingAnalysisTasks.push(task)
      state.history = [event]
      await saveRadarState(stateFile, state)

      const listed = spawnSync(process.execPath, [cli, 'task', 'list', stateFile], { encoding: 'utf8' })
      assert.equal(listed.status, 0)
      assert.match(listed.stdout, new RegExp(task.id))
      assert.match(listed.stdout, /Project A/)

      const shown = spawnSync(process.execPath, [cli, 'task', 'show', stateFile, task.id], { encoding: 'utf8' })
      assert.equal(shown.status, 0)
      assert.match(shown.stdout, /UPSTREAM RADAR ANALYSIS TASK/)
      assert.match(shown.stdout, /不可信数据/)

      const next = spawnSync(process.execPath, [
        cli,
        'radar',
        'next',
        resolve(repository, 'examples/radar/config.json'),
        '--state',
        stateFile,
      ], { encoding: 'utf8' })
      assert.equal(next.status, 0)
      assert.match(next.stdout, /Upstream Radar next action/)
      assert.match(next.stdout, /Project A: parser@2\.9\.0 is affected by GHSA-demo/)
      assert.match(next.stdout, /DSH follow-up: queued/)
      assert.match(next.stdout, new RegExp(`Next command: upstream-radar task show .*${task.id}`))
      assert.match(next.stdout, new RegExp(`After reviewing the task, acknowledge it with: upstream-radar task ack .*${task.id}`))
      assert.match(next.stdout, /Follow-up: open; record an owner\/status with: upstream-radar triage/)
      const nextJson = spawnSync(process.execPath, [
        cli,
        'radar',
        'next',
        resolve(repository, 'examples/radar/config.json'),
        '--state',
        stateFile,
        '--json',
      ], { encoding: 'utf8' })
      assert.equal(nextJson.status, 0)
      const nextReport = JSON.parse(nextJson.stdout) as { schema: string; activeIncident?: { incidentId: string }; pendingAnalysisTaskId?: string }
      assert.equal(nextReport.schema, 'upstream-radar.radar-next/v1alpha1')
      assert.equal(nextReport.activeIncident?.incidentId, event.incidentId)
      assert.equal(nextReport.pendingAnalysisTaskId, task.id)

      const triaged = spawnSync(process.execPath, [
        cli,
        'triage',
        stateFile,
        event.incidentId,
        '--status',
        'in-progress',
        '--owner',
        'security-team',
        '--note',
        'Trace the parser input.',
        '--due',
        '2026-08-17T00:00:00+00:00',
        '--json',
      ], { encoding: 'utf8' })
      assert.equal(triaged.status, 0)
      const triageReport = JSON.parse(triaged.stdout) as {
        incidentId: string
        eventId: string
        status: string
        owner?: string
        note?: string
        dueAt?: string
        updatedAt: string
      }
      assert.deepEqual(triageReport, {
        incidentId: event.incidentId,
        eventId: event.id,
        status: 'in-progress',
        owner: 'security-team',
        note: 'Trace the parser input.',
        dueAt: '2026-08-17T00:00:00.000Z',
        updatedAt: triageReport.updatedAt,
      })

      const muteUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString()
      const muted = spawnSync(process.execPath, [
        cli,
        'mute',
        stateFile,
        event.incidentId,
        '--until',
        muteUntil,
        '--json',
      ], { encoding: 'utf8' })
      assert.equal(muted.status, 0)
      const muteReport = JSON.parse(muted.stdout) as { incidentId: string; eventId: string; mutedUntil: string }
      assert.deepEqual(muteReport, {
        incidentId: event.incidentId,
        eventId: event.id,
        mutedUntil: new Date(muteUntil).toISOString(),
        forced: false,
      })
      const mutedNext = spawnSync(process.execPath, [
        cli,
        'radar',
        'next',
        resolve(repository, 'examples/radar/config.json'),
        '--state',
        stateFile,
      ], { encoding: 'utf8' })
      assert.equal(mutedNext.status, 0)
      assert.match(mutedNext.stdout, /Delivery: muted until/)
      assert.match(mutedNext.stdout, /Follow-up: in progress; owner: security-team; note: Trace the parser input\.; due: 2026-08-17T00:00:00.000Z/)
      assert.match(mutedNext.stdout, /To resume delivery: upstream-radar unmute/)
      const unmuted = spawnSync(process.execPath, [cli, 'unmute', stateFile, event.incidentId], { encoding: 'utf8' })
      assert.equal(unmuted.status, 0)
      assert.match(unmuted.stdout, /Resumed delivery/)

      const history = spawnSync(process.execPath, [
        cli,
        'radar',
        'history',
        resolve(repository, 'examples/radar/config.json'),
        '--state',
        stateFile,
      ], { encoding: 'utf8' })
      assert.equal(history.status, 0)
      assert.match(history.stdout, /Showing 1 of 1 recorded transition\(s\)/)
      assert.match(history.stdout, /NEW\tvulnerability\tProject A/)
      const historyJson = spawnSync(process.execPath, [
        cli,
        'radar',
        'history',
        resolve(repository, 'examples/radar/config.json'),
        '--state',
        stateFile,
        '--limit',
        '1',
        '--json',
      ], { encoding: 'utf8' })
      assert.equal(historyJson.status, 0)
      const historyReport = JSON.parse(historyJson.stdout) as { events: Array<{ id: string }>; totalRecorded: number }
      assert.equal(historyReport.totalRecorded, 1)
      assert.equal(historyReport.events[0]?.id, event.id)

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
      const nextWithAnalysis = spawnSync(process.execPath, [
        cli,
        'radar',
        'next',
        resolve(repository, 'examples/radar/config.json'),
        '--state',
        stateFile,
      ], { encoding: 'utf8' })
      assert.equal(nextWithAnalysis.status, 0)
      assert.match(nextWithAnalysis.stdout, /DSH analysis: verified/)
      assert.match(nextWithAnalysis.stdout, /Recommendation \(within_24_hours\): Review the call path\./)
      assert.match(nextWithAnalysis.stdout, /Evidence: src\/index\.ts:12/)
      assert.match(nextWithAnalysis.stdout, new RegExp(`Next command: upstream-radar analysis show .*${event.incidentId}`))
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
