import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it } from 'node:test'

const execFile = promisify(callback)

it('repairs a contradictory build decision through the same strict validator before saving a plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-build-repair-'))
  const plansPath = join(root, 'plans.json')
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  let rejectEveryAttempt = false
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const durable = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.equal(durable.entries.length, rejectEveryAttempt ? 1 : 0, 'an invalid decision must never become an executable plan')
    assert.equal(durable.pendingTasks[0].caseId, 'fixture-node22')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'stop-headless', classification: 'insufficient-evidence',
      allowedBuilds: requests.length === 1 || rejectEveryAttempt ? ['sharp'] : [], summary: 'No build gate exists; the missing peer is still unknown.',
      evidence: ['The isolated result is unknown, not build-approval-required.'] }) } }] }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const fixtures = [
      { schema: 'upstream-radar.dsh-install-targets/v1alpha1', plugins: [{ id: 'fixture', spec: 'fixture@1.0.0', reason: 'repair fixture' }] },
      {}, {},
      { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [{
        caseId: 'fixture-node22', targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.5-rc.2',
        runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
        staticFingerprint: `sha256:${'b'.repeat(64)}`, contractFingerprint: `sha256:${'c'.repeat(64)}`,
        observedAt: '2026-09-14T05:00:00.000Z', result: 'unknown', reason: 'Missing peer coverage.',
        artifact: { lifecycleScripts: [], sha256: 'a'.repeat(64) }, observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
      }] },
    ]
    const paths = fixtures.map((_, index) => join(root, `${index}.json`))
    await Promise.all(fixtures.map((value, index) => writeFile(paths[index]!, JSON.stringify(value))))
    const script = fileURLToPath(new URL('../../scripts/plan-dsh-headless-agent.mjs', import.meta.url))
    const run = () => execFile(process.execPath, [script, ...paths, plansPath, join(root, 'report.md')], {
      env: { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}`, ISSUE_LOCATOR_LLM_API_KEY: 'fixture-only', ISSUE_LOCATOR_LLM_MODEL: 'fixture-only' },
      timeout: 20_000,
    })
    const summary = JSON.parse((await run()).stdout)
    assert.equal(summary.planned, 1)
    assert.equal(summary.failed, 0)
    assert.equal(requests.length, 2)
    assert.match(requests[1]!.messages.at(-1)!.content, /a stopped headless plan cannot approve dependency builds/)
    assert.match(requests[1]!.messages.at(-1)!.content, /original evidence/)
    const saved = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.equal(saved.pendingTasks.length, 0)
    assert.deepEqual(saved.entries[0].allowedBuilds, [])
    const diagnostics = JSON.parse(await readFile(`${plansPath}.attempts.json`, 'utf8'))
    assert.deepEqual(diagnostics.attempts.map((attempt: { status: string }) => attempt.status), ['rejected', 'validated'])
    assert.equal(JSON.parse((await run()).stdout).attempted, 0)
    assert.equal(requests.length, 2)
    assert.equal(JSON.parse(await readFile(`${plansPath}.attempts.json`, 'utf8')).attempts.length, 2)
    rejectEveryAttempt = true
    const changedLedger = JSON.parse(await readFile(paths[3]!, 'utf8'))
    changedLedger.entries[0].reason = 'A different missing peer coverage gap requires a new review.'
    await writeFile(paths[3]!, JSON.stringify(changedLedger))
    await assert.rejects(run, (error: unknown) => {
      const failure = error as { code: number; stdout: string }
      assert.equal(failure.code, 2)
      assert.equal(JSON.parse(failure.stdout).failed, 1)
      return true
    })
    assert.equal(requests.length, 5, 'invalid output repair must stop after three attempts')
    const failedState = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.equal(failedState.pendingTasks.length, 1)
    assert.deepEqual(failedState.entries, saved.entries, 'no automatic normalization may turn an invalid decision into an approval')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('persists omitted repository documents as review coverage gaps without silently truncating UTF-8 evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-build-documents-'))
  const plansPath = join(root, 'plans.json')
  let prompt = ''
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[1].content
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'stop-headless', classification: 'insufficient-evidence',
      allowedBuilds: [], summary: 'No build gate was observed; document coverage is incomplete.', evidence: ['The isolated result is unknown.'] }) } }] }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const fixtures = [
      { schema: 'upstream-radar.dsh-install-targets/v1alpha1', plugins: [{ id: 'fixture', observerTargetId: 'fixture', spec: 'fixture@1.0.0', reason: 'document fixture' }] },
      {}, { targets: { fixture: { package: { name: 'fixture', version: '1.0.0' }, source: { repository: 'fixture/plugin', commit: 'f'.repeat(40), packagePath: 'package.json' } } } },
      { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [{
        caseId: 'fixture-node22', targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.5-rc.2',
        runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
        staticFingerprint: `sha256:${'b'.repeat(64)}`, contractFingerprint: `sha256:${'c'.repeat(64)}`,
        observedAt: '2026-09-14T05:00:00.000Z', result: 'unknown', reason: 'Missing peer coverage.',
        artifact: { lifecycleScripts: [], sha256: 'a'.repeat(64) }, observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
      }] },
    ]
    const paths = fixtures.map((_, index) => join(root, `${index}.json`))
    await Promise.all(fixtures.map((value, index) => writeFile(paths[index]!, JSON.stringify(value))))
    const preload = join(root, 'network-fixture.mjs')
    await writeFile(preload, `const actual = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://raw.githubusercontent.com/fixture/plugin/')) return actual(url, options);
  if (String(url).endsWith('/package.json')) return new Response('{}');
  if (String(url).endsWith('/README.md')) return new Response('x'.repeat(49 * 1024));
  return new Response('界'.repeat(16000));
};`)
    const script = fileURLToPath(new URL('../../scripts/plan-dsh-headless-agent.mjs', import.meta.url))
    await execFile(process.execPath, ['--import', preload, script, ...paths, plansPath, join(root, 'report.md')], {
      env: { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}`, ISSUE_LOCATOR_LLM_API_KEY: 'fixture-only', ISSUE_LOCATOR_LLM_MODEL: 'fixture-only' },
      timeout: 20_000,
    })
    const saved = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.match(JSON.stringify(saved.entries[0].documentCoverageGaps), /README\.md.*exceeds/)
    assert.match(JSON.stringify(saved.entries[0].documentCoverageGaps), /byte budget.*cordis\.patch\.yaml/)
    assert.match(prompt, /Document collection coverage gaps/)
    assert.match(await readFile(join(root, 'report.md'), 'utf8'), /README\.md.*exceeds/)
    assert.doesNotMatch(prompt, /untrusted-document path="cordis\.patch\.yaml"/)
    const evidenceBytes = [...prompt.matchAll(/<untrusted-document path=[^\n]+>\n([\s\S]*?)\n<\/untrusted-document>/g)]
      .reduce((sum, match) => sum + Buffer.byteLength(match[1]!), 0)
    assert.ok(evidenceBytes <= 128 * 1024)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('persists bounded build-review handoffs before delivery and gives deferred plugins a turn after failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-build-review-'))
  const plansPath = join(root, 'plans.json')
  const ids = Array.from({ length: 34 }, (_, index) => `plugin-${String(index).padStart(2, '0')}`)
  const delivered: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const id = /Case: (plugin-\d+)-node22/.exec(body.messages[1].content)?.[1]
    assert.ok(id)
    delivered.push(id)
    const durable = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.ok(durable.pendingTasks.some((task: { caseId: string; attempts: number }) => task.caseId === `${id}-node22` && task.attempts > 0), 'handoff must already exist')
    if (Number(id.slice(-2)) < 32) { response.writeHead(503).end(); return }
    response.setHeader('content-type', 'application/json')
    if (id === 'plugin-33') {
      response.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(300 * 1024) } }] })); return
    }
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'retry-headless', classification: 'build-approval',
      allowedBuilds: ['sharp'], summary: 'Approve the exact observed build in this fixture.', evidence: ['Observed sharp build gate.'] }) } }] }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const fixtures = [
      { schema: 'upstream-radar.dsh-install-targets/v1alpha1', plugins: ids.map(id => ({ id, spec: `${id}@1.0.0`, reason: 'fairness fixture' })) },
      {}, {},
      { schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: ids.map(id => ({
        caseId: `${id}-node22`, targetId: id, plugin: `${id}@1.0.0`, dshVersion: '0.1.5-rc.2',
        runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
        staticFingerprint: `sha256:${'b'.repeat(64)}`, contractFingerprint: `sha256:${'c'.repeat(64)}`,
        observedAt: '2026-09-14T05:00:00.000Z', result: 'build-approval-required', reason: 'Observed sharp build gate.', requiredDependencyBuilds: ['sharp'],
        artifact: { lifecycleScripts: [], sha256: 'a'.repeat(64) }, observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
      })) },
    ]
    const paths = fixtures.map((_, index) => join(root, `${index}.json`))
    await Promise.all(fixtures.map((value, index) => writeFile(paths[index]!, JSON.stringify(value))))
    const script = fileURLToPath(new URL('../../scripts/plan-dsh-headless-agent.mjs', import.meta.url))
    const run = () => execFile(process.execPath, [script, ...paths, plansPath, join(root, 'report.md')], {
      env: { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}`, ISSUE_LOCATOR_LLM_API_KEY: 'fixture-only', ISSUE_LOCATOR_LLM_MODEL: 'fixture-only' },
      timeout: 20_000,
    }).catch((error: { stdout: string; code: number }) => { assert.equal(error.code, 2); return { stdout: error.stdout } })
    const first = JSON.parse((await run()).stdout)
    assert.equal(first.attempted, 32)
    assert.equal(delivered.length, 32)
    assert.equal(delivered.includes('plugin-32'), false)
    const second = JSON.parse((await run()).stdout)
    assert.equal(second.planned, 1)
    assert.ok(delivered.includes('plugin-32') && delivered.includes('plugin-33'))
    const saved = JSON.parse(await readFile(plansPath, 'utf8'))
    assert.equal(saved.entries.length, 1)
    assert.equal(saved.pendingTasks.length, 33)
    assert.match(await readFile(join(root, 'report.md'), 'utf8'), /Agent response exceeds/)
    await run()
    assert.equal(delivered.filter(id => id === 'plugin-32').length, 1, 'an unexecuted approval must not invalidate its own unchanged review input')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
