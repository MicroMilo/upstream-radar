import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const { writeDshPatch } = await import('../dist/src/init.js')
const { discoverDshRuntimeNodeModulesDirectory } = await import('../dist/src/dsh-runtime.js')
const { createAnalysisTask } = await import('../dist/src/dsh-analysis.js')
const { emptyRadarState } = await import('../dist/src/radar.js')
const { checkDshProfile } = await import('../dist/src/dsh-profile-check.js')
const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.6'
const DSH_PROFILE = process.env.DSH_PROFILE ?? 'headless'
const REAL_PLUGIN_SPECS = process.env.DSH_REAL_PLUGINS === undefined
  ? (process.argv.includes('--real-plugins')
    ? ['dsh-find-plugin@0.3.6']
    : [])
  : process.env.DSH_REAL_PLUGINS.split(',').map(spec => spec.trim()).filter(Boolean)
const ROOT = resolve(import.meta.dirname, '..')
const WRITE_REPORT = process.argv.includes('--write-report')
const LIVE_FEEDS = process.argv.includes('--live-feeds')
const PUBLIC_CASE = process.argv.includes('--public-case')
const REPORT_PATH = join(ROOT, PUBLIC_CASE
  ? 'examples/dsh/reports/dsh-web-ui-public-case.json'
  : 'examples/dsh/reports/headless-smoke.json')
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const LIVE_STARTUP_WINDOW_MS = 30_000
const PUBLIC_CASE_ROOT = join(ROOT, 'examples/cases/dsh-web-ui-issue-71')

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectRun(new Error(`${command} timed out`))
    }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code === 0) resolveRun(result)
      else rejectRun(new Error([
        `${command} ${args.join(' ')} exited with ${code}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n')))
    })
  })
}

async function sse(response, text, delayMs, initialDelayMs = 0) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(': upstream-radar-showcase\n\n')
  let heartbeat
  if (initialDelayMs > 0) {
    heartbeat = setInterval(() => response.write(': waiting-for-live-radar\n\n'), 2_000)
    try {
      await new Promise(resolveWait => setTimeout(resolveWait, initialDelayMs))
    } finally {
      clearInterval(heartbeat)
    }
  }
  const events = [
    { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 64, completion_tokens: 32 },
    },
  ]
  let index = 0
  const send = () => {
    if (index >= events.length) {
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    response.write(`data: ${JSON.stringify(events[index])}\n\n`)
    index += 1
    setTimeout(send, delayMs)
  }
  send()
}

async function startModelStub() {
  const requests = []
  const finalAnalysis = JSON.stringify(PUBLIC_CASE
    ? {
        project_exposure: 'likely_exposed',
        confidence: 'high',
        evidence: [
          'examples/cases/dsh-web-ui-issue-71/before/cordis.patch.yml',
          'examples/cases/dsh-web-ui-issue-71/before/pnpm-lock.yaml',
          'https://github.com/zhu1090093659/dsh-web-ui/issues/35',
          'https://github.com/zhu1090093659/dsh-web-ui/issues/71',
        ],
        recommended_action: '升级 @linxin666/dsh-web-ui-all、@linxin666/dsh-client-ui-skin-center 与 @linxin666/dsh-skins 到 0.1.7，加入 minimumReleaseAgeExclude，清理旧的 insert 行后重新运行 profile-check。',
        urgency: 'within_24_hours',
        reasoning_summary: '静态复现已确认旧 profile 的 patch 引用了锁文件中不存在的独立皮肤包；手动补包又会产生重复 loader id。公开 Issue #71 的维护者修复采用 bundled carrier，并把 release-age 排除配置补齐。',
      }
    : {
        project_exposure: 'unknown',
        confidence: 'low',
        evidence: ['examples/radar/project/src/import-logs.ts'],
        recommended_action: 'Repeat this DSH profile run with a configured DeepSeek model for semantic reachability analysis.',
        urgency: 'within_24_hours',
        reasoning_summary: 'The real DSH Agent received the plugin-originated Radar task. This deterministic local model verifies delivery plumbing, not vulnerability applicability.',
      })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        response.writeHead(400).end('invalid JSON')
        return
      }
      requests.push(parsed)
      const sawRadar = JSON.stringify(parsed).includes('[UPSTREAM RADAR ANALYSIS TASK')
      void sse(
        response,
        sawRadar ? finalAnalysis : 'Waiting for the Upstream Radar follow-up.',
        75,
        sawRadar || !LIVE_FEEDS ? 0 : LIVE_STARTUP_WINDOW_MS,
      ).catch(error => response.destroy(error))
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model stub did not obtain a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}

async function filesBelow(directory) {
  const result = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile()) result.push(target)
    }
  }
  return result
}

async function readSessionFile(file) {
  return readFile(file, 'utf8')
}

async function runPublicCaseStaticChecks() {
  const cases = [
    { id: 'before', directory: join(PUBLIC_CASE_ROOT, 'before'), checkedAt: '2026-08-17T08:00:00.000Z' },
    { id: 'manual-add', directory: join(PUBLIC_CASE_ROOT, 'manual-add'), checkedAt: '2026-08-17T08:01:00.000Z' },
    { id: 'fixed', directory: join(PUBLIC_CASE_ROOT, 'fixed'), checkedAt: '2026-08-17T08:02:00.000Z' },
  ]
  const checked = []
  for (const item of cases) {
    const report = await checkDshProfile({ profileDirectory: item.directory, checkedAt: item.checkedAt })
    checked.push({
      id: item.id,
      status: report.status,
      findingCodes: report.findings.map(finding => finding.code),
      execution: report.execution,
    })
  }
  const before = checked.find(item => item.id === 'before')
  const manualAdd = checked.find(item => item.id === 'manual-add')
  const fixed = checked.find(item => item.id === 'fixed')
  if (before?.status !== 'blocked' || !before.findingCodes.includes('missing-loader-package')) {
    throw new Error('public case before replay did not reproduce missing-loader-package')
  }
  if (manualAdd?.status !== 'blocked' || !manualAdd.findingCodes.includes('duplicate-loader-id')) {
    throw new Error('public case manual workaround did not reproduce duplicate-loader-id')
  }
  if (fixed?.status !== 'pass' || fixed.findingCodes.length !== 0) {
    throw new Error('public case fixed replay did not pass cleanly')
  }
  return checked
}

function publicCaseState() {
  const event = {
    schema: 'upstream-radar.event/v1alpha1',
    id: 'event-dsh-web-ui-issue-71',
    incidentId: 'incident-dsh-web-ui-issue-71',
    kind: 'compatibility',
    change: 'new',
    detectedAt: '2026-08-17T08:02:00.000Z',
    project: {
      id: 'dsh-web-ui-public-case',
      name: 'dsh-web-ui public compatibility case',
      repository: 'https://github.com/zhu1090093659/dsh-web-ui',
      workspace: 'examples/cases/dsh-web-ui-issue-71/before',
      owner: 'dsh-web-ui-maintainers',
      channels: ['stdout'],
    },
    route: {
      owner: 'dsh-web-ui-maintainers',
      channels: ['stdout'],
    },
    plugin: {
      ecosystem: 'npm',
      name: '@linxin666/dsh-web-ui-all',
      version: '0.1.5',
    },
    installed: {
      ecosystem: 'npm',
      name: '@linxin666/dsh-web-ui-all',
      version: '0.1.5',
    },
    candidate: {
      ecosystem: 'npm',
      name: '@linxin666/dsh-web-ui-all',
      version: '0.1.7',
    },
    signals: [
      {
        code: 'missing-loader-package',
        confidence: 'confirmed',
        summary: '旧版 Apply 写入的 ui-skin-qq98 loader 不在锁定依赖图中。',
        before: 'cordis.patch.yml insert -> @linxin666/dsh-client-ui-skin-qq98, package absent',
        after: 'fixed profile uses bundled carrier row without an insert',
      },
      {
        code: 'duplicate-loader-id',
        confidence: 'confirmed',
        summary: '手动补装独立皮肤包后，同一个 ui-skin-qq98 会注册两次。',
        before: 'profile insert + package cordis.patch.yml insert',
        after: 'one active row in the bundled-carrier layout',
      },
      {
        code: 'minimum-release-age-unexcluded',
        confidence: 'strong',
        summary: 'pnpm release-age 门禁可能让按 README 安装的 profile 停留在有问题的旧版本。',
        before: 'minimumReleaseAge=14400 without @linxin666/* exclusion',
        after: 'minimumReleaseAgeExclude includes the related packages',
      },
    ],
    releaseNotes: '维护者在 Issue #71 回复已修复，并将随下一版发布。',
    releaseNotesUrl: 'https://github.com/zhu1090093659/dsh-web-ui/issues/71',
  }
  const state = emptyRadarState()
  state.activeCompatibility[event.incidentId] = { key: event.incidentId, event }
  state.pendingAnalysisTasks = [createAnalysisTask(event)]
  state.history = [event]
  return state
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-'))
  const dshHome = join(scratch, 'dsh-home')
  const stateFile = join(scratch, 'radar-state.json')
  const dshArgvFile = join(scratch, 'dsh-argv.json')
  const dshArgvProbe = join(scratch, 'capture-dsh-argv.cjs')
  const model = await startModelStub()
  try {
    const overlayFile = join(scratch, 'smoke.patch.yml')
    const radarOverlayFile = join(scratch, 'upstream-radar.generated.patch.yml')
    const packDirectory = join(scratch, 'package')
    await mkdir(packDirectory)

    const publicCaseStaticChecks = PUBLIC_CASE ? await runPublicCaseStaticChecks() : undefined
    if (!LIVE_FEEDS) {
      const state = PUBLIC_CASE
        ? publicCaseState()
        : JSON.parse(await readFile(join(ROOT, 'examples/radar/reports/02-vulnerability-alert.json'), 'utf8')).state
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    }

    const packed = await run('pnpm', ['pack', '--pack-destination', packDirectory])
    const tarball = packed.stdout.trim().split('\n').at(-1)
    if (!tarball?.endsWith('.tgz')) throw new Error('pnpm pack did not return a tarball path')

    const baseEnv = {
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'read-only',
      DSH_SMOKE_API_KEY: 'local-smoke-key',
      DSH_TELEMETRY_MODE: 'DISABLED',
    }
    await run('pnpm', ['dlx', DSH_PACKAGE, '--profile', DSH_PROFILE, '--help'], { env: baseEnv })
    await run('pnpm', ['dlx', DSH_PACKAGE, 'plugin', '--profile', DSH_PROFILE, 'add', tarball], { env: baseEnv })
    for (const pluginSpec of REAL_PLUGIN_SPECS) {
      const pluginPack = await run('npm', [
        'pack', '--ignore-scripts', '--pack-destination', packDirectory, pluginSpec,
      ])
      const pluginTarball = pluginPack.stdout.trim().split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).at(-1)
      if (!pluginTarball?.endsWith('.tgz')) throw new Error(`npm pack did not return a tarball path for ${pluginSpec}`)
      await run('pnpm', [
        'dlx', DSH_PACKAGE, 'plugin', '--profile', DSH_PROFILE, 'add', join(packDirectory, pluginTarball),
      ], { env: baseEnv })
    }

    const profileManifestPath = join(dshHome, 'profiles', DSH_PROFILE, 'package.json')
    const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'))
    const bundleInstalled = profileManifest.dsh?.profile?.bundles?.includes('upstream-radar') === true
    if (!bundleInstalled) throw new Error('DSH profile did not register the upstream-radar bundle')

    const overlay = [
      '- id: subprocess',
      "  name: '@deepseek-ai/dsh-subprocess-local'",
      '  disabled: true',
      '- id: bash-sandbox',
      "  name: '@deepseek-ai/dsh-bash-sandbox'",
      '  disabled: true',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  disabled: true',
      '- id: tool-bash',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      '  disabled: true',
      '- id: tool-fs-search',
      "  name: '@deepseek-ai/dsh-tool-fs-search'",
      '  disabled: true',
      '- id: llm-deepseek',
      "  name: '@deepseek-ai/dsh-llm-deepseek'",
      '  config:',
      '    apiKeyEnv: DSH_SMOKE_API_KEY',
      `    baseURL: ${JSON.stringify(model.baseUrl)}`,
      '    thinking: disabled',
      '    reasoningEffort: off',
      '    maxTokens: 1024',
      '    streamIdleTimeoutMs: 10000',
      '- id: session-persistence-jsonl',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(dshHome, 'sessions'))}`,
      '    compression: none',
      '    packChunks: false',
      '',
    ].join('\n')
    await writeFile(overlayFile, overlay)
    await writeDshPatch({
      output: radarOverlayFile,
      configFile: join(ROOT, LIVE_FEEDS ? 'examples/dsh/live-config.json' : 'examples/radar/config.json'),
      stateFile,
      profile: DSH_PROFILE,
      intervalSeconds: 300,
      runOnStart: LIVE_FEEDS,
    })

    // Capture the real DSH CLI entrypoint without importing DSH from the showcase.
    // The Radar adapter uses the same process.argv[1] boundary for runtime discovery.
    await writeFile(dshArgvProbe, [
      "const fs = require('node:fs')",
      "const entrypoint = process.argv[1]",
      "if (typeof entrypoint === 'string' && (entrypoint.includes('/node_modules/@deepseek-ai/dsh/') || entrypoint.includes('\\\\node_modules\\\\@deepseek-ai\\\\dsh\\\\'))) {",
      `  fs.writeFileSync(${JSON.stringify(dshArgvFile)}, JSON.stringify({ argv: process.argv, cwd: process.cwd() }))`,
      '}',
      '',
    ].join('\n'))

    const execution = await run('pnpm', [
      'dlx', DSH_PACKAGE,
      '--profile', DSH_PROFILE,
      '--patch', overlayFile,
      '--patch', radarOverlayFile,
      'Wait for the Upstream Radar plugin notice, then answer that notice.',
    ], { env: { ...baseEnv, NODE_OPTIONS: `--require=${dshArgvProbe}` } })

    let dshEntrypointObserved = false
    let dshHostRuntimePlaneDiscovered = false
    try {
      const captured = JSON.parse(await readFile(dshArgvFile, 'utf8'))
      const entrypoint = captured?.argv?.[1]
      dshEntrypointObserved = typeof entrypoint === 'string'
      dshHostRuntimePlaneDiscovered = dshEntrypointObserved
        && discoverDshRuntimeNodeModulesDirectory(entrypoint) !== undefined
    } catch {
      // Report the failed evidence below instead of turning a valid DSH delivery
      // proof into an opaque parse error.
    }
    if (!dshEntrypointObserved) throw new Error('real DSH CLI entrypoint was not observed')
    if (!dshHostRuntimePlaneDiscovered) throw new Error('real DSH host dependency plane was not discovered')

    const finalState = JSON.parse(await readFile(stateFile, 'utf8'))
    const requestText = JSON.stringify(model.requests)
    const radarTaskReachedModel = requestText.includes('[UPSTREAM RADAR ANALYSIS TASK')
    const sessionFiles = await filesBelow(join(dshHome, 'sessions'))
    const sessionText = (await Promise.all(sessionFiles.map(readSessionFile))).join('\n')
    const pluginSourcePreserved = sessionText.includes('"plugin":"upstream-radar"')
      && sessionText.includes('"kind":"plugin"')
    const pendingTasksAfterDelivery = finalState.pendingAnalysisTasks.length
    const activeVulnerabilities = Object.keys(finalState.activeVulnerabilities).length
    const activeCompatibility = Object.keys(finalState.activeCompatibility).length
    const analysisResults = Object.keys(finalState.analysisResults ?? {}).length
    const rawAnalysisResult = Object.values(finalState.analysisResults ?? {})[0]
    const analysisResult = rawAnalysisResult === undefined
      ? null
      : {
          taskId: rawAnalysisResult.taskId,
          incidentId: rawAnalysisResult.incidentId,
          eventId: rawAnalysisResult.eventId,
          project_exposure: rawAnalysisResult.project_exposure,
          confidence: rawAnalysisResult.confidence,
          evidence: rawAnalysisResult.evidence,
          recommended_action: rawAnalysisResult.recommended_action,
          urgency: rawAnalysisResult.urgency,
          reasoning_summary: rawAnalysisResult.reasoning_summary,
        }

    if (!radarTaskReachedModel) throw new Error('DSH model requests never contained the Radar task')
    if (!pluginSourcePreserved) throw new Error('DSH session did not preserve the plugin source metadata')
    if (pendingTasksAfterDelivery !== 0) throw new Error('Radar task remained queued after DSH admission')
    if (analysisResults === 0) throw new Error('DSH model result was not accepted into Radar state')
    if (LIVE_FEEDS && activeVulnerabilities === 0) throw new Error('live OSV polling did not create an active vulnerability')
    if (PUBLIC_CASE && activeCompatibility !== 1) throw new Error('public case compatibility incident was not preserved')

    let finalAssistant = execution.stdout.trim()
    try {
      finalAssistant = JSON.parse(finalAssistant)
    } catch {
      // Preserve exact stdout when the runner emits non-JSON text.
    }
    const report = {
      dshPackage: DSH_PACKAGE,
      profile: DSH_PROFILE,
      model: 'local deterministic DeepSeek-compatible stub (plumbing proof only)',
      feedMode: PUBLIC_CASE
        ? 'public dsh-web-ui #35/#71 replay; static profile facts + real DSH delivery'
        : LIVE_FEEDS ? 'live OSV + live npm' : 'checked-in deterministic event',
      ...(PUBLIC_CASE
        ? {
            case: {
              issue35: 'https://github.com/zhu1090093659/dsh-web-ui/issues/35',
              issue71: 'https://github.com/zhu1090093659/dsh-web-ui/issues/71',
              staticChecks: publicCaseStaticChecks,
            },
          }
        : {}),
      bundleInstalled,
      radarTaskReachedModel,
      pluginSourcePreserved,
      pendingTasksAfterDelivery,
      analysisResults,
      ...(PUBLIC_CASE ? { activeCompatibility, analysisResult } : {}),
      activeVulnerabilities,
      modelRequests: model.requests.length,
      dshEntrypointObserved,
      dshHostRuntimePlaneDiscovered,
      realPlugins: REAL_PLUGIN_SPECS,
      finalAssistant,
    }
    if (WRITE_REPORT) {
      await mkdir(join(ROOT, 'examples/dsh/reports'), { recursive: true })
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await model.close()
    if (process.env.KEEP_DSH_SHOWCASE !== '1') await rm(scratch, { recursive: true, force: true })
    else process.stderr.write(`Kept DSH showcase files at ${scratch}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
