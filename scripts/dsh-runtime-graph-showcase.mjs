import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const {
  createRadarConfigFromDshProfile,
  discoverDshRuntimeHostNodeModulesDirectory,
  discoverDshRuntimePackage,
  discoverDshRuntimePackageDirectory,
  writeDshPatch,
  writeRadarConfig,
} = await import('../dist/src/index.js')
const { emptyRadarState } = await import('../dist/src/radar.js')
const { saveRadarState } = await import('../dist/src/radar-state.js')

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.6'
const PLUGIN_NAME = 'showcase-dsh-host-peer'
const PLUGIN_VERSION = '1.0.0'
const HOST_PACKAGE_NAME = '@deepseek-ai/cordis'
const ADVISORY_ID = 'GHSA-dsh-host-plane-demo'
const ADVISORY_MODIFIED = '2026-08-16T00:00:00.000Z'
const ROOT = resolve(import.meta.dirname, '..')
const WRITE_REPORT = process.argv.includes('--write-report')
const REPORT_PATH = join(ROOT, 'examples/dsh/reports/dsh-runtime-host.json')
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

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
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(Buffer.from(chunk))
    })
    child.on('error', error => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', code => {
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

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readRequestBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 2 * 1024 * 1024) throw new Error('showcase request body is too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function startModelStub() {
  const requests = []
  const finalAnalysis = JSON.stringify({
    project_exposure: 'unknown',
    confidence: 'low',
    evidence: ['showcase: deterministic host-runtime event'],
    recommended_action: 'Review the host-runtime advisory with the project tests before changing DSH.',
    urgency: 'within_24_hours',
    reasoning_summary: 'This local model proves that a real DSH Agent received and acknowledged a host-runtime vulnerability notice; it does not assess a real project.',
  })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      try {
        requests.push(JSON.parse(body))
      } catch {
        response.writeHead(400).end('invalid JSON')
        return
      }
      // DSH may make more than one model request while the Agent is handling
      // a follow-up. Once the admitted Radar marker has appeared in the
      // conversation, keep the deterministic stub's answer stable across
      // subsequent turns instead of depending on the last request shape.
      const sawRadar = JSON.stringify(requests).includes('[UPSTREAM RADAR ANALYSIS TASK')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': dsh-runtime-graph-showcase\n\n')
      const events = [
        { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
        { choices: [{ delta: { content: sawRadar ? finalAnalysis : 'Waiting for the Radar host-runtime notice.' } }] },
        { choices: [{ delta: { content: '' }, finish_reason: 'stop' }] },
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
        setTimeout(send, 60)
      }
      if (sawRadar) {
        send()
        return
      }
      // The headless profile exits after its first turn. Keep that first model
      // turn open long enough for Radar's runOnStart poll to finish the real
      // host-closure refresh and enqueue the follow-up in the same Agent.
      const heartbeat = setInterval(() => response.write(': waiting-for-radar\n\n'), 2_000)
      setTimeout(() => {
        clearInterval(heartbeat)
        send()
      }, 30_000)
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model stub did not obtain a port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}

async function startFeedStub(options) {
  const requests = []
  const webhookRequests = []
  const advisory = {
    id: ADVISORY_ID,
    aliases: [],
    summary: 'The DSH host-runtime demo package is affected.',
    details: 'This deterministic advisory exists only to prove that the real DSH refresh included the host package.',
    database_specific: { severity: 'high' },
    published: ADVISORY_MODIFIED,
    modified: ADVISORY_MODIFIED,
    affected: [{
      package: { ecosystem: 'npm', name: options.hostPackageName },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
      ecosystem_specific: { severity: 'high' },
    }],
    references: [{ url: 'https://example.test/dsh-host-runtime-demo' }],
  }
  const server = createHttpsServer({ key: await readFile(options.keyFile), cert: await readFile(options.certFile) }, async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname })
    try {
      if (request.method === 'POST' && url.pathname === '/v1/querybatch') {
        const payload = JSON.parse(await readRequestBody(request))
        const queries = Array.isArray(payload.queries) ? payload.queries : []
        jsonResponse(response, 200, {
          results: queries.map(query => (
            query?.package?.ecosystem === 'npm'
              && query.package.name === options.hostPackageName
              && query.version === options.hostPackageVersion
              ? { vulns: [{ id: ADVISORY_ID, modified: ADVISORY_MODIFIED }] }
              : { vulns: [] }
          )),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === `/v1/vulns/${ADVISORY_ID}`) {
        jsonResponse(response, 200, advisory)
        return
      }
      if (request.method === 'POST' && url.pathname === '/webhook') {
        webhookRequests.push(JSON.parse(await readRequestBody(request)))
        response.writeHead(204).end()
        return
      }
      // A 404 makes the npm release source explicit but harmless. This showcase
      // is proving OSV matching and DSH host refresh, not npm release metadata.
      response.writeHead(404).end('not found')
    } catch (error) {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('feed stub did not obtain a port')
  return {
    baseUrl: `https://127.0.0.1:${address.port}/`,
    requests,
    webhookUrl: `https://127.0.0.1:${address.port}/webhook`,
    webhookRequests,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}

async function createLocalCertificate(scratch) {
  const keyFile = join(scratch, 'localhost.key')
  const certFile = join(scratch, 'localhost.crt')
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile,
    '-out', certFile,
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { timeoutMs: 30_000 })
  return { keyFile, certFile }
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-runtime-'))
  const dshHome = join(scratch, 'dsh-home')
  const baseEnv = {
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_SMOKE_API_KEY: 'local-runtime-key',
    DSH_TELEMETRY_MODE: 'DISABLED',
  }
  const model = await startModelStub()
  let feed
  try {
    const captureFile = join(scratch, 'dsh-argv.json')
    const captureProbe = join(scratch, 'capture-dsh-argv.cjs')
    await writeFile(captureProbe, [
      "const fs = require('node:fs')",
      "const entrypoint = process.argv[1]",
      "if (typeof entrypoint === 'string' && (entrypoint.includes('/node_modules/@deepseek-ai/dsh/') || entrypoint.includes('\\\\node_modules\\\\@deepseek-ai\\\\dsh\\\\'))) {",
      `  fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv }))`,
      '}',
      '',
    ].join('\n'))
    await run('pnpm', ['dlx', DSH_PACKAGE, '--profile', 'headless', '--help'], {
      env: { ...baseEnv, NODE_OPTIONS: `--require=${captureProbe}` },
    })
    const captured = JSON.parse(await readFile(captureFile, 'utf8'))
    const entrypoint = captured?.argv?.[1]
    if (typeof entrypoint !== 'string') throw new Error('real DSH entrypoint was not captured')
    // The exact runtime may be installed by pnpm dlx. In that topology the
    // package-local node_modules misses sibling dependencies in `.pnpm`; the
    // host plane is the bounded directory that contains both.
    const hostNodeModulesDirectory = discoverDshRuntimeHostNodeModulesDirectory(entrypoint)
    const hostRuntimePackage = discoverDshRuntimePackage(entrypoint)
    const hostRuntimePackageDirectory = discoverDshRuntimePackageDirectory(entrypoint)
    if (hostNodeModulesDirectory === undefined) throw new Error('real DSH host dependency plane was not discovered')
    if (hostRuntimePackage === undefined || hostRuntimePackageDirectory === undefined) {
      throw new Error('real DSH runtime package was not discovered')
    }

    const pluginDirectory = join(scratch, 'plugin')
    const packDirectory = join(scratch, 'package')
    await mkdir(pluginDirectory, { recursive: true })
    await mkdir(packDirectory, { recursive: true })

    // Install the product itself as a real DSH bundle. The generated Radar
    // patch is an overlay for this bundle; passing it alone would only try to
    // patch a row that is not present in the profile tree.
    const radarPacked = await run('pnpm', ['pack', '--pack-destination', packDirectory], { cwd: ROOT })
    const radarTarball = resolve(radarPacked.stdout.trim().split('\n').at(-1) ?? '')
    if (!radarTarball.endsWith('.tgz')) throw new Error('runtime showcase did not produce an upstream-radar tarball')
    await run('pnpm', ['dlx', DSH_PACKAGE, 'plugin', '--profile', 'headless', 'add', radarTarball], { env: baseEnv })

    await writeFile(join(pluginDirectory, 'package.json'), `${JSON.stringify({
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      peerDependencies: { [HOST_PACKAGE_NAME]: '^4.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`)
    await writeFile(join(pluginDirectory, 'cordis.patch.yml'), [
      '- id: system-prompt',
      '  config:',
      '    persona: >-',
      '      You are running the deterministic DSH host-runtime showcase.',
      '',
    ].join('\n'))
    const packed = await run('pnpm', ['pack', '--pack-destination', packDirectory], { cwd: pluginDirectory })
    const tarball = resolve(packed.stdout.trim().split('\n').at(-1) ?? '')
    if (!tarball.endsWith('.tgz')) throw new Error('runtime showcase did not produce a plugin tarball')
    await run('pnpm', ['dlx', DSH_PACKAGE, 'plugin', '--profile', 'headless', 'add', tarball], { env: baseEnv })

    const profileDirectory = join(dshHome, 'profiles', 'headless')
    const exact = await createRadarConfigFromDshProfile({
      profileDirectory,
      projectId: 'dsh-runtime-host-showcase',
      projectName: 'DSH runtime host showcase',
      workspace: ROOT,
      hostNodeModulesDirectory,
      hostRuntimeSource: 'dsh-process',
      hostRuntimePackage,
      hostRuntimePackageDirectory,
    })
    const exactGraph = exact.projects[0]?.plugins[0]?.graph
    const exactHostNode = exactGraph?.nodes.find(node => node.name === HOST_PACKAGE_NAME && node.source === 'dsh-host')
    if (exactHostNode === undefined) throw new Error(`exact preflight graph did not resolve ${HOST_PACKAGE_NAME} from the DSH host plane`)
    const hostPackageVersion = exactHostNode.version

    // A profile can contain symlinks into the DSH package-manager cache. A
    // profile-only inspection deliberately refuses to follow that untrusted
    // external link. Once the real DSH process gives us its exact package
    // root, the earlier `exact` graph supplies a bounded, verified host plane.
    let staticProfileBoundary: 'refused-external-host-link' | undefined
    try {
      await createRadarConfigFromDshProfile({
        profileDirectory,
        projectId: 'dsh-runtime-host-showcase',
        projectName: 'DSH runtime host showcase',
        workspace: ROOT,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('escapes the shared dependency plane')) throw error
      staticProfileBoundary = 'refused-external-host-link'
    }
    if (staticProfileBoundary === undefined) {
      throw new Error('profile-only graph unexpectedly followed an external DSH host link')
    }

    // The native adapter receives the same exact running-process boundary and
    // rebuilds this graph before it polls. Starting from verified evidence is
    // safer than treating a profile-controlled external symlink as trusted.
    const config = exact
    config.dshProfile = { name: 'headless' }
    const configuredHostRuntime = config.projects[0]?.plugins[0]?.graph.hostRuntime
    if (configuredHostRuntime?.source !== 'dsh-process' || configuredHostRuntime.resolvedNodes < 1) {
      throw new Error(`verified process graph did not preserve the expected DSH host plane: ${JSON.stringify(configuredHostRuntime)}`)
    }

    const configFile = join(scratch, 'upstream-radar.config.json')
    const stateFile = `${configFile}.state.json`
    await writeRadarConfig(config, { output: configFile })
    await saveRadarState(stateFile, emptyRadarState())

    const certificate = await createLocalCertificate(scratch)
    feed = await startFeedStub({
      keyFile: certificate.keyFile,
      certFile: certificate.certFile,
      hostPackageName: HOST_PACKAGE_NAME,
      hostPackageVersion,
    })
    const radarPatch = join(scratch, 'upstream-radar.dsh.yml')
    await writeDshPatch({
      output: radarPatch,
      configFile,
      stateFile,
      profile: 'headless',
      intervalSeconds: 300,
      runOnStart: true,
      registry: feed.baseUrl,
      deepCandidates: false,
    })
    const patchText = await readFile(radarPatch, 'utf8')
    await writeFile(radarPatch, `${patchText.trimEnd()}\n    osvBaseUrl: ${JSON.stringify(feed.baseUrl)}\n`)

    const dshOverlay = [
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
      '    streamIdleTimeoutMs: 60000',
      '- id: session-persistence-jsonl',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(dshHome, 'sessions'))}`,
      '    compression: none',
      '    packChunks: false',
      '',
    ].join('\n')
    const dshOverlayFile = join(scratch, 'dsh.patch.yml')
    await writeFile(dshOverlayFile, dshOverlay)
    const execution = await run('pnpm', [
      'dlx', DSH_PACKAGE,
      '--profile', 'headless',
      '--patch', dshOverlayFile,
      '--patch', radarPatch,
      'Wait for the DSH host-runtime Radar notice, then answer it.',
    ], {
      env: {
        ...baseEnv,
        NODE_EXTRA_CA_CERTS: certificate.certFile,
        NODE_OPTIONS: `--require=${captureProbe}`,
        UPSTREAM_RADAR_WEBHOOK_URL: feed.webhookUrl,
      },
    })

    const finalState = JSON.parse(await readFile(stateFile, 'utf8'))
    const matches = Object.values(finalState.activeVulnerabilities ?? {})
    const hostEvent = matches.map(item => item.event).find(event => event.affected.name === HOST_PACKAGE_NAME)
    const hostRuntimeObserved = hostEvent?.affected.version === hostPackageVersion
      && hostEvent.affectedSources?.includes('dsh-host') === true
      && hostEvent.paths.some(path => path.some(node => node.name === HOST_PACKAGE_NAME))
    if (!hostRuntimeObserved) throw new Error(`real DSH poll did not persist a dsh-host vulnerability event: ${JSON.stringify({
      hostEvent,
      activeVulnerabilities: Object.keys(finalState.activeVulnerabilities ?? {}),
      pendingAnalysisTasks: finalState.pendingAnalysisTasks?.length ?? 0,
      feedRequests: feed.requests,
      modelRequests: model.requests.map(request => ({
        messageCount: request.messages?.length,
        lastMessage: request.messages?.at(-1)?.content,
      })),
      dshStdout: execution.stdout.slice(-8_000),
      dshStderr: execution.stderr.slice(-8_000),
    })}`)
    const analysisResults = Object.keys(finalState.analysisResults ?? {}).length
    if (analysisResults === 0) throw new Error(`real DSH host-runtime analysis result was not accepted: ${JSON.stringify({
      pendingAnalysisTasks: finalState.pendingAnalysisTasks?.length ?? 0,
      analysisDeliveries: Object.keys(finalState.analysisDeliveries ?? {}).length,
      modelRequests: model.requests.map(request => ({
        messageCount: request.messages?.length,
        containsRadarMarker: JSON.stringify(request).includes('[UPSTREAM RADAR ANALYSIS TASK'),
      })),
      dshStdout: execution.stdout.slice(-4_000),
      dshStderr: execution.stderr.slice(-4_000),
    })}`)
    const webhookEventIds = feed.webhookRequests.flatMap(payload => payload.events?.map(event => event.id) ?? [])
    if (feed.webhookRequests.length !== 1 || !webhookEventIds.includes(hostEvent.id)) {
      throw new Error(`real DSH webhook delivery was not recorded exactly once: ${JSON.stringify(feed.webhookRequests)}`)
    }

    const report = {
      dshPackage: DSH_PACKAGE,
      plugin: `${PLUGIN_NAME}@${PLUGIN_VERSION}`,
      hostPackage: `${HOST_PACKAGE_NAME}@${hostPackageVersion}`,
      staticProfileBoundary: {
        result: staticProfileBoundary,
      },
      configuredProcessGraph: {
        hostRuntimeSource: configuredHostRuntime.source,
        hostRuntimePackages: configuredHostRuntime.resolvedNodes,
      },
      refreshedGraph: {
        source: exactGraph?.hostRuntime?.source,
        hostRuntimePackages: exactGraph?.hostRuntime?.resolvedNodes,
        hostNode: exactHostNode,
      },
      persistedEvent: {
        affected: hostEvent.affected,
        affectedSources: hostEvent.affectedSources,
        path: hostEvent.paths[0],
      },
      dshAnalysisResults: analysisResults,
      feedRequests: feed.requests.length,
      modelRequests: model.requests.length,
      webhookRequests: feed.webhookRequests.length,
      webhookEventIds,
      webhookEndpointPersisted: JSON.stringify(finalState).includes(feed.webhookUrl),
      dshProcessPollCompleted: true,
      finalAssistant: execution.stdout.trim(),
    }
    if (WRITE_REPORT) {
      await mkdir(join(ROOT, 'examples/dsh/reports'), { recursive: true })
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await model.close()
    await feed?.close()
    if (process.env.KEEP_DSH_SHOWCASE !== '1') await rm(scratch, { recursive: true, force: true })
    else process.stderr.write(`Kept DSH runtime showcase files at ${scratch}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
