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

const execFile = promisify(callback)

it('saves the exact surface build-review handoff before delivery and completes it durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-surface-review-'))
  const plansPath = join(root, 'plans.json')
  const statesAtDelivery: unknown[] = []
  let endpointUnavailable = false
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request at the model HTTP boundary. */ }
    statesAtDelivery.push(await readFile(plansPath, 'utf8').then(JSON.parse).catch(() => undefined))
    if (endpointUnavailable) { response.writeHead(503).end(); return }
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
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
