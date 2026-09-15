import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it } from 'node:test'
import { createDshSurfaceSourceFingerprint } from '../src/dsh-surface.js'
import type { DshCompatibilityLedgerEntry } from '../src/dsh-compatibility-ledger.js'
import { collectDshHostNativeLoadFailures, parseDshHostBuildInventory } from '../src/dsh-host-builds.js'
import { assertDshHostBuildApproval } from '../src/dsh-host-build-policy.js'

const execFile = promisify(callback)

it('reviews an independent host native failure without a plugin build gate and does not review its unused plan again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-host-review-'))
  const plansPath = join(root, 'plans.json')
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(Buffer.concat(chunks).toString('utf8'))
    const pending = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.equal(pending.pendingTasks[0].caseId, 'fixture-web')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'retry-surface', classification: 'build-approval',
      allowedBuilds: [], allowedHostBuilds: ['fs-ext@2.1.1'], summary: 'Approve the separately observed host native build.',
      evidence: ['The host manifest and first requiring file identify fs-ext@2.1.1.'] }) } }] }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const source: DshCompatibilityLedgerEntry = {
      caseId: 'fixture-node22', targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.5-rc.2',
      runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      staticFingerprint: `sha256:${'b'.repeat(64)}`, contractFingerprint: `sha256:${'c'.repeat(64)}`,
      observedAt: '2026-09-14T05:00:00.000Z', result: 'compatible', reason: 'The native fixture loaded.',
      artifact: { lifecycleScripts: [], sha256: 'a'.repeat(64) }, observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
    }
    const location = 'pnpm/dlx/fixture/instance'
    const inventory = parseDshHostBuildInventory({ revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts',
      dshVersion: source.dshVersion, pnpmVersion: '11.7.0', coverageGaps: [],
      installation: { location, manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64),
        lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` },
      packages: [{ spec: 'fs-ext@2.1.1', location: `${location}/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext`,
        manifestSha256: '5'.repeat(64), lifecycleScripts: { install: 'node-gyp configure build' }, reportedLocators: ['fs-ext@2.1.1'], metadataSources: ['pendingBuilds'] }] })
    const failures = collectDshHostNativeLoadFailures(inventory, '/cache',
      `Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- /cache/${inventory.packages[0]!.location}/fs-ext.js\n`)
    const stages = Object.fromEntries(['runtime', 'artifact', 'profile', 'install', 'registration', 'host', 'surface', 'interaction', 'shutdown'].map(name => [name, { status: 'skipped' }]))
    stages.host = { status: 'failed' }
    const entry = { caseId: 'fixture-web', sourceCaseId: source.caseId, plugin: source.plugin, dshVersion: source.dshVersion,
      plane: 'web', profile: 'web', runtimeId: 'fixture', requiredDependencyBuilds: [], approvedDependencyBuilds: [],
      profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} },
      sourceFingerprint: createDshSurfaceSourceFingerprint(source), contractFingerprint: source.contractFingerprint,
      observedAt: source.observedAt, runtime: source.runtime, artifact: { sha256: source.artifact.sha256 }, stages,
      hostBuildInventory: inventory, hostBuildFailures: failures,
      evidence: { plane: 'web', url: 'http://127.0.0.1:3080', pluginClientDeclared: false, rootMounted: false, bootManifestPresent: false,
        pluginEntryPresent: false, pluginMaterialized: false, applicationMounted: false, consoleErrors: [], pageErrors: [], failedRequests: [] },
      result: 'environment-unsupported', reason: 'The independently installed DSH host could not load its native fs-ext binding.',
      observer: { schema: 'upstream-radar.dsh-surface-observation/v1alpha1', version: '0.45.0' } }
    const fixtures = [{ schema: 'upstream-radar.dsh-install-targets/v1alpha1', plugins: [{ id: 'fixture', spec: source.plugin, reason: 'host fixture' }] }, {}, {},
      { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [source] },
      { schema: 'upstream-radar.dsh-surface-ledger/v1alpha1', entries: [entry] }]
    const paths = fixtures.map((_, index) => join(root, `${index}.json`))
    await Promise.all(fixtures.map((value, index) => writeFile(paths[index]!, JSON.stringify(value))))
    const script = fileURLToPath(new URL('../../scripts/plan-dsh-surface-agent.mjs', import.meta.url))
    const run = () => execFile(process.execPath, [script, ...paths, plansPath, join(root, 'report.md')], {
      env: { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}`, ISSUE_LOCATOR_LLM_API_KEY: 'fixture-only', ISSUE_LOCATOR_LLM_MODEL: 'fixture-only' }, timeout: 20_000 })
    const summary = JSON.parse((await run()).stdout)
    assert.equal(summary.candidates, 1)
    assert.equal(summary.planned, 1)
    const saved = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.deepEqual(saved.entries[0].approvedBuilds, [])
    assert.deepEqual(saved.entries[0].hostBuildApproval.packages, ['fs-ext@2.1.1'])
    assertDshHostBuildApproval(saved.entries[0].hostBuildApproval, inventory, { ...entry, plane: 'web', artifactSha256: source.artifact.sha256! })
    assert.match(requests[0]!, /independent|Independent/)
    assert.match(requests[0]!, /fs-ext@2.1.1/)
    assert.equal(JSON.parse((await run()).stdout).attempted, 0)
    assert.equal(requests.length, 1)
    assert.deepEqual(JSON.parse(await readFile(plansPath, 'utf8')), saved)
    const refreshedInventory = parseDshHostBuildInventory({ ...inventory, installation: {
      ...inventory.installation!, lockfileSha256: '6'.repeat(64), lockGraphDigest: `sha256:${'7'.repeat(64)}` } })
    const refreshedSurface = JSON.parse(await readFile(paths[4]!, 'utf8'))
    refreshedSurface.entries[0].hostBuildInventory = refreshedInventory
    await writeFile(paths[4]!, JSON.stringify(refreshedSurface))
    assert.equal(JSON.parse((await run()).stdout).planned, 1)
    assert.equal(requests.length, 2, 'a new exact DSH graph needs another durable model handoff')
    const refreshed = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.notEqual(refreshed.entries[0].inputFingerprint, saved.entries[0].inputFingerprint)
    assert.notEqual(refreshed.entries[0].hostBuildApproval.inventoryFingerprint, saved.entries[0].hostBuildApproval.inventoryFingerprint)
    assertDshHostBuildApproval(refreshed.entries[0].hostBuildApproval, refreshedInventory,
      { ...entry, plane: 'web', artifactSha256: source.artifact.sha256! })
    assert.equal(JSON.parse((await run()).stdout).attempted, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('saves the exact surface build-review handoff before delivery and completes it durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-surface-review-'))
  const plansPath = join(root, 'plans.json')
  const statesAtDelivery: unknown[] = []
  let endpointUnavailable = false
  let oversizedResponse = false
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request at the model HTTP boundary. */ }
    statesAtDelivery.push(await readFile(plansPath, 'utf8').then(JSON.parse).catch(() => undefined))
    if (endpointUnavailable) { response.writeHead(503).end(); return }
    if (oversizedResponse) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'retry-surface', classification: 'build-approval',
        allowedBuilds: ['node-pty'], summary: 'x'.repeat(2 * 1024 * 1024), evidence: ['fixture'] }) } }] }))
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'retry-surface', classification: 'build-approval',
      allowedBuilds: ['node-pty'], summary: 'Approve the exact observed PTY build.', evidence: ['The isolated TUI install observed node-pty.'] }) } }] }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const source: DshCompatibilityLedgerEntry = {
      caseId: 'fixture-node22', targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.5-rc.2',
      runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      staticFingerprint: `sha256:${'b'.repeat(64)}`, contractFingerprint: `sha256:${'c'.repeat(64)}`,
      observedAt: '2026-09-14T05:00:00.000Z', result: 'compatible', reason: 'The native fixture loaded.',
      artifact: { lifecycleScripts: [], sha256: 'a'.repeat(64) }, observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
    }
    const stages = Object.fromEntries(['runtime', 'artifact', 'profile', 'install', 'registration', 'host', 'surface', 'interaction', 'shutdown']
      .map(name => [name, { status: 'skipped' }]))
    stages.install = { status: 'failed' }
    const fixtures = [
      { schema: 'upstream-radar.dsh-install-targets/v1alpha1', plugins: [{ id: 'fixture', spec: 'fixture@1.0.0', reason: 'surface fixture' }] },
      {}, {},
      { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [source] },
      { schema: 'upstream-radar.dsh-surface-ledger/v1alpha1', entries: [{
        caseId: 'fixture-tui', sourceCaseId: source.caseId, plugin: source.plugin, dshVersion: source.dshVersion,
        plane: 'tui', profile: 'dsh-tui', runtimeId: 'fixture', requiredDependencyBuilds: ['node-pty'], approvedDependencyBuilds: [],
        sourceFingerprint: createDshSurfaceSourceFingerprint(source), contractFingerprint: source.contractFingerprint,
        observedAt: source.observedAt, runtime: source.runtime, artifact: { sha256: source.artifact.sha256 }, stages,
        evidence: { plane: 'tui', terminal: 'xterm-256color', columns: 100, rows: 32, frameObserved: false,
          inputSent: false, exitedAfterShutdown: false, normalizedFrame: '', capturedBytes: 0, truncated: false },
        result: 'environment-unsupported', reason: 'The TUI profile requires an explicit node-pty build.',
        observer: { schema: 'upstream-radar.dsh-surface-observation/v1alpha1', version: '0.45.0' },
      }] },
    ]
    const paths = fixtures.map((_, index) => join(root, `${index}.json`))
    await Promise.all(fixtures.map((value, index) => writeFile(paths[index]!, JSON.stringify(value))))
    const script = fileURLToPath(new URL('../../scripts/plan-dsh-surface-agent.mjs', import.meta.url))
    const run = () => execFile(process.execPath, [script, ...paths, plansPath, join(root, 'report.md')], {
      env: { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}`, ISSUE_LOCATOR_LLM_API_KEY: 'fixture-only', ISSUE_LOCATOR_LLM_MODEL: 'fixture-only' },
      timeout: 20_000,
    })
    const summary = JSON.parse((await run()).stdout)
    assert.equal(summary.planned, 1)
    assert.equal(statesAtDelivery.length, 1)
    const handedOff = statesAtDelivery[0] as { pendingTasks: Array<{ caseId: string; attempts: number; inputFingerprint: string }>; entries: unknown[] } | undefined
    assert.ok(handedOff, 'the task must already exist on disk when the model receives the request')
    assert.deepEqual(handedOff.entries, [])
    assert.equal(handedOff.pendingTasks[0]?.caseId, 'fixture-tui')
    assert.equal(handedOff.pendingTasks[0]?.attempts, 1)
    const saved = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.deepEqual(saved.pendingTasks, [])
    assert.equal(saved.entries[0].inputFingerprint, handedOff.pendingTasks[0]!.inputFingerprint)
    assert.deepEqual(saved.entries[0].approvedBuilds, ['node-pty'])
    const repeated = JSON.parse((await run()).stdout)
    assert.equal(repeated.attempted, 0, 'saving an approval is not new execution evidence and must not invalidate its own review')
    assert.equal(statesAtDelivery.length, 1)
    assert.deepEqual(JSON.parse(await readFile(plansPath, 'utf8')), saved)
    endpointUnavailable = true
    const changed = JSON.parse(await readFile(paths[4]!, 'utf8'))
    changed.entries[0].reason = 'The updated TUI observation still requires the exact node-pty build.'
    await writeFile(paths[4]!, JSON.stringify(changed))
    await assert.rejects(run, (error: unknown) => {
      const failure = error as { code: number; stdout: string }
      assert.equal(failure.code, 2)
      assert.equal(JSON.parse(failure.stdout).failed, 1)
      return true
    })
    const interrupted = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.deepEqual(interrupted.entries, saved.entries, 'an unavailable model must not erase a still-bound earlier review')
    assert.equal(interrupted.pendingTasks[0].attempts, 1)
    assert.notEqual(interrupted.pendingTasks[0].inputFingerprint, saved.entries[0].inputFingerprint)
    endpointUnavailable = false
    assert.equal(JSON.parse((await run()).stdout).planned, 1)
    const recovered = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.deepEqual(recovered.pendingTasks, [])
    assert.equal(recovered.entries[0].inputFingerprint, interrupted.pendingTasks[0].inputFingerprint)
    assert.equal(JSON.parse((await run()).stdout).attempted, 0)
    const oversizedInput = JSON.parse(await readFile(paths[4]!, 'utf8'))
    oversizedInput.entries[0].reason = 'A later exact TUI attempt still needs the PTY build.'
    await writeFile(paths[4]!, JSON.stringify(oversizedInput))
    oversizedResponse = true
    await assert.rejects(run, (error: unknown) => {
      const failure = error as { code: number; stdout: string }
      assert.equal(failure.code, 2)
      assert.equal(JSON.parse(failure.stdout).failed, 1)
      return true
    })
    const failedBody = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.equal(failedBody.pendingTasks[0]?.attempts, 1)
    assert.deepEqual(failedBody.entries[0].approvedBuilds, ['node-pty'])
    assert.match(await readFile(join(root, 'report.md'), 'utf8'), /response byte budget/)
    oversizedResponse = false
    assert.equal(JSON.parse((await run()).stdout).planned, 1)
    assert.equal(JSON.parse((await run()).stdout).attempted, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
