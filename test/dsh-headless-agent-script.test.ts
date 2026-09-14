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
