import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const { writeDshPatch } = await import('../dist/src/init.js')
const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.6'
const ROOT = resolve(import.meta.dirname, '..')
const WRITE_REPORT = process.argv.includes('--write-report')
const LIVE_FEEDS = process.argv.includes('--live-feeds')
const REPORT_PATH = join(ROOT, 'examples/dsh/reports/headless-smoke.json')
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const LIVE_STARTUP_WINDOW_MS = 30_000

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
  const finalAnalysis = JSON.stringify({
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

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-'))
  const dshHome = join(scratch, 'dsh-home')
  const stateFile = join(scratch, 'radar-state.json')
  const model = await startModelStub()
  try {
    const overlayFile = join(scratch, 'smoke.patch.yml')
    const radarOverlayFile = join(scratch, 'upstream-radar.generated.patch.yml')
    const packDirectory = join(scratch, 'package')
    await mkdir(packDirectory)

    if (!LIVE_FEEDS) {
      const fixture = JSON.parse(await readFile(join(ROOT, 'examples/radar/reports/02-vulnerability-alert.json'), 'utf8'))
      await writeFile(stateFile, `${JSON.stringify(fixture.state, null, 2)}\n`)
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
    await run('pnpm', ['dlx', DSH_PACKAGE, '--profile', 'headless', '--help'], { env: baseEnv })
    await run('pnpm', ['dlx', DSH_PACKAGE, 'plugin', '--profile', 'headless', 'add', tarball], { env: baseEnv })

    const profileManifestPath = join(dshHome, 'profiles/headless/package.json')
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
      profile: 'headless',
      intervalSeconds: 300,
      runOnStart: LIVE_FEEDS,
    })

    const execution = await run('pnpm', [
      'dlx', DSH_PACKAGE,
      '--profile', 'headless',
      '--patch', overlayFile,
      '--patch', radarOverlayFile,
      'Wait for the Upstream Radar plugin notice, then answer that notice.',
    ], { env: baseEnv })

    const finalState = JSON.parse(await readFile(stateFile, 'utf8'))
    const requestText = JSON.stringify(model.requests)
    const radarTaskReachedModel = requestText.includes('[UPSTREAM RADAR ANALYSIS TASK')
    const sessionFiles = await filesBelow(join(dshHome, 'sessions'))
    const sessionText = (await Promise.all(sessionFiles.map(readSessionFile))).join('\n')
    const pluginSourcePreserved = sessionText.includes('"plugin":"upstream-radar"')
      && sessionText.includes('"kind":"plugin"')
    const pendingTasksAfterDelivery = finalState.pendingAnalysisTasks.length
    const activeVulnerabilities = Object.keys(finalState.activeVulnerabilities).length
    const analysisResults = Object.keys(finalState.analysisResults ?? {}).length

    if (!radarTaskReachedModel) throw new Error('DSH model requests never contained the Radar task')
    if (!pluginSourcePreserved) throw new Error('DSH session did not preserve the plugin source metadata')
    if (pendingTasksAfterDelivery !== 0) throw new Error('Radar task remained queued after DSH admission')
    if (analysisResults === 0) throw new Error('DSH model result was not accepted into Radar state')
    if (LIVE_FEEDS && activeVulnerabilities === 0) throw new Error('live OSV polling did not create an active vulnerability')

    let finalAssistant = execution.stdout.trim()
    try {
      finalAssistant = JSON.parse(finalAssistant)
    } catch {
      // Preserve exact stdout when the runner emits non-JSON text.
    }
    const report = {
      dshPackage: DSH_PACKAGE,
      profile: 'headless',
      model: 'local deterministic DeepSeek-compatible stub',
      feedMode: LIVE_FEEDS ? 'live OSV + live npm' : 'checked-in deterministic event',
      bundleInstalled,
      radarTaskReachedModel,
      pluginSourcePreserved,
      pendingTasksAfterDelivery,
      analysisResults,
      activeVulnerabilities,
      modelRequests: model.requests.length,
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
