import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { promisify } from 'node:util'
import { applyDshEnvironmentRecommendations, applyDshEnvironmentRecommendationsToSurfaceTargets } from '../src/dsh-environment-recommendation.js'
import { buildDshInstallPlan } from '../src/dsh-install-plan.js'

const execFile = promisify(execFileCallback)

async function fixture(authorDshVersion?: string, explicitBaseline = true, authorTuiProfile?: string, independentErrors = false) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-environment-evidence-'))
  const targets = {
    schema: 'upstream-radar.dsh-install-targets/v1alpha1', refreshAfterHours: 168,
    runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
    plugins: [{ id: 'plugin', spec: 'fixture-plugin@1.0.0', observerTargetId: 'plugin', reason: 'immutable repository evidence regression' }],
  }
  const observations = { targets: {
    'deepseek-harness': {
      source: { repository: 'example/dsh', commit: 'd'.repeat(40), packagePath: 'package.json' },
      manifest: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', engines: { node: '>=22' } },
      package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' },
    },
    plugin: {
      source: { repository: 'example/plugin', commit: 'a'.repeat(40), packagePath: 'package.json' },
      manifest: { name: 'fixture-plugin', version: '1.0.0', engines: { node: '>=22' } },
      package: { name: 'fixture-plugin', version: '1.0.0' },
    },
  } }
  await writeFile(join(directory, 'targets.json'), JSON.stringify(targets))
  await writeFile(join(directory, 'observations.json'), JSON.stringify(observations))
  // Only external HTTP is replaced. The real CLI still collects, persists,
  // validates, schedules, and reuses its own evidence and model decisions.
  await writeFile(join(directory, 'network.mjs'), `
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.RADAR_EVIDENCE_FIXTURE;
const authorDshVersion = ${JSON.stringify(authorDshVersion) ?? 'undefined'};
const authorTuiProfile = ${JSON.stringify(authorTuiProfile) ?? 'undefined'};
const configurationQuote = ${independentErrors} ? 'overrides: {"fixture-peer":"1.0.0"}\\nDSH_BRIDGE_DISABLED=1' : undefined;
const recommended = !!(authorDshVersion || authorTuiProfile);
const authorQuote = authorDshVersion ? (${explicitBaseline}
  ? 'Overrides force the whole\\n# @deepseek-ai tree to the ' + authorDshVersion + ' line locally (the primary\\n# validated line; see src/dsh-adapter/contract.ts).'
  : 'The repository names DSH ' + authorDshVersion + ' for its development fixture.') : undefined;
const readme = [authorQuote, authorTuiProfile ? 'TUI requires Node 22.\\ndsh plugin --profile ' + authorTuiProfile + ' add fixture-plugin' : undefined, configurationQuote].filter(Boolean).join('\\n') || 'Repository setup documentation.';
globalThis.fetch = async (url, options) => {
  const address = String(url);
  if (address.startsWith('https://fixture-agent.example/')) {
    const state = JSON.parse(await readFile(join(root, 'recommendations.json'), 'utf8'));
    if (state.pendingTasks.length !== 1) throw new Error('Agent task was not durable before delivery');
    const request = JSON.parse(options.body);
    await appendFile(join(root, 'model-inputs.jsonl'), JSON.stringify(request) + '\\n');
    const omitBaseline = process.env.RADAR_EVIDENCE_NETWORK === 'omit-always'
      || process.env.RADAR_EVIDENCE_NETWORK === 'omit-baseline' && request.messages.length === 2;
    const correction = request.messages.length > 2 ? request.messages.at(-1).content : '';
    const independentErrors = process.env.RADAR_EVIDENCE_NETWORK === 'multiple-errors'
      && !['author override value', 'startup configuration requires', 'author-recommended Node'].every(error => correction.includes(error));
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      status: recommended ? 'recommended' : 'insufficient-evidence',
      ...(recommended ? { preferredNodeMajor: 22 } : {}),
      nodeMajors: recommended ? [22] : [], executionProfiles: authorTuiProfile ? ['tui'] : authorDshVersion ? ['headless'] : [],
      ...(authorTuiProfile && !(process.env.RADAR_EVIDENCE_NETWORK === 'omit-tui-profile' && request.messages.length === 2) ? { tuiProfile: authorTuiProfile } : {}),
      ...(configurationQuote ? { nodeEvidence: [{ nodeMajor: 22, kind: independentErrors ? 'author-recommended' : 'declared-support', evidence: ['source-manifest'] }] } : {}),
      authorEnvironment: { packageManagers: [],
        overrides: independentErrors ? [{ scope: 'development', values: { 'fixture-peer': '2.0.0' }, evidence: [{ path: 'README.md', quote: configurationQuote }] }] : [],
        ...(independentErrors ? { startupConfigurations: [{ plane: 'web', scope: 'Disabled bridge comparison', environment: { DSH_BRIDGE_DISABLED: '1' }, evidence: [{ path: 'README.md', quote: configurationQuote }] }] } : {}),
        workflows: [], dshVersions: authorDshVersion && !omitBaseline
        ? [{ version: authorDshVersion, evidence: [{ path: 'README.md', quote: authorQuote }] }] : [] },
      summary: recommended ? 'Select the evidenced author environment for an isolated comparison.' : 'The bounded input does not establish an author-supported launch workflow.',
      evidence: authorTuiProfile ? ['source-manifest', 'README.md'] : ['source-manifest'],
    }) } }] });
  }
  if (!/^https:\\/\\/(?:api.github.com|raw.githubusercontent.com)\\//.test(address)) throw new Error('Unexpected fixture URL');
  await appendFile(join(root, 'requests.jsonl'), JSON.stringify(address) + '\\n');
  if (process.env.RADAR_EVIDENCE_NETWORK === 'offline') throw new Error('fixture document collection timed out');
  if (process.env.RADAR_EVIDENCE_NETWORK === 'bad-tree' && address.startsWith('https://api.github.com/')) return Response.json({ truncated: true, tree: [] });
  if (address.startsWith('https://api.github.com/')) return Response.json({ truncated: false, tree: [
    { type: 'blob', mode: '100644', path: 'package.json' },
    { type: 'blob', mode: '100644', path: 'README.md' },
  ] });
  if (address.endsWith('/README.md') && address.includes('/example/plugin/') && process.env.RADAR_EVIDENCE_NETWORK === 'document-timeout') throw new Error('fixture README collection timed out');
  if (address.endsWith('/README.md')) return new Response(process.env.RADAR_EVIDENCE_NETWORK === 'oversized'
    && address.includes('/example/plugin/') ? 'x'.repeat(48 * 1024 + 1)
      : address.includes('/example/plugin/') ? readme : 'Repository setup documentation.');
  const dsh = address.includes('/example/dsh/');
  return Response.json({ name: dsh ? '@deepseek-ai/dsh' : 'fixture-plugin', version: dsh ? '0.1.5-rc.2' : '1.0.0', engines: { node: '>=22' } });
};
`)
  const run = async (network = 'online') => {
    const result = await execFile(process.execPath, ['--import', join(directory, 'network.mjs'),
      'scripts/plan-dsh-environment-recommendations.mjs',
      ...['targets.json', 'observations.json', 'recommendations.json', 'report.md', 'candidates.json'].map(file => join(directory, file)),
    ], { cwd: process.cwd(), timeout: 15_000, env: {
      ...process.env, RADAR_EVIDENCE_FIXTURE: directory, RADAR_EVIDENCE_NETWORK: network,
      ISSUE_LOCATOR_LLM_BASE_URL: 'https://fixture-agent.example', ISSUE_LOCATOR_LLM_API_KEY: 'fixture', ISSUE_LOCATOR_LLM_MODEL: 'fixture',
    } })
    return JSON.parse(result.stdout)
  }
  return { directory, targets, observations, run }
}

it('corrects a repeated review that silently drops a still-grounded author DSH baseline before planning', async () => {
  const { directory, targets, observations, run } = await fixture('0.1.5-rc.1', false)
  try {
    assert.equal((await run()).planned, 1)
    const prior = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    prior.entries[0].reviewContract = 'dsh-environment/v0'
    await writeFile(join(directory, 'recommendations.json'), JSON.stringify(prior))
    assert.equal((await run('omit-baseline')).planned, 1)
    const reviewed = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    assert.deepEqual(reviewed.entries[0].authorEnvironment.dshVersions, prior.entries[0].authorEnvironment.dshVersions)
    const attempts = JSON.parse(await readFile(join(directory, 'recommendations.json.attempts.json'), 'utf8')).attempts
    assert.deepEqual(attempts.map((item: { status: string }) => item.status), ['rejected', 'validated'])
    assert.match(attempts[0].error, /omitted.*0\.1\.5-rc\.1/)
    const plan = buildDshInstallPlan(applyDshEnvironmentRecommendations(targets, observations, reviewed), observations, { changes: [] })
    assert.deepEqual(plan.matrix.include.map(item => item.dshVersion).sort(), ['0.1.5-rc.1', '0.1.5-rc.2'])
    assert.equal((await run('offline')).attempted, 0, 'the corrected decision must not cause an endless review loop')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps an unresolved baseline omission pending after bounded corrections instead of publishing a smaller plan', async () => {
  const { directory, targets, observations, run } = await fixture('0.1.5-rc.1', false)
  try {
    await run()
    const prior = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    prior.entries[0].reviewContract = 'dsh-environment/v0'
    await writeFile(join(directory, 'recommendations.json'), JSON.stringify(prior))
    await assert.rejects(run('omit-always'), { code: 2 })
    const unresolved = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    assert.deepEqual(unresolved.entries, prior.entries, 'failed corrections cannot overwrite the last source claims')
    assert.equal(unresolved.pendingTasks.length, 1)
    const attempts = JSON.parse(await readFile(join(directory, 'recommendations.json.attempts.json'), 'utf8')).attempts
    assert.deepEqual(attempts.map((item: { status: string }) => item.status), ['rejected', 'rejected', 'rejected'])
    const plan = buildDshInstallPlan(applyDshEnvironmentRecommendations({ ...targets, environmentRecommendationsRequired: true }, observations, unresolved), observations, { changes: [] })
    assert.equal(plan.matrix.include.length, 0)
    assert.equal(plan.blocked.length, 1)
    assert.equal((await run('omit-baseline')).planned, 1, 'the next run can correct and finish the same durable task')
    assert.equal((await run('offline')).attempted, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('requires the first review to account for explicit author validation evidence without any prior recommendation', async () => {
  const { directory, targets, observations, run } = await fixture('0.1.5-rc.1')
  try {
    assert.equal((await run('omit-baseline')).planned, 1)
    const reviewed = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    assert.deepEqual(reviewed.entries[0].authorEnvironment.dshVersions.map((fact: { version: string }) => fact.version), ['0.1.5-rc.1'])
    const attempts = JSON.parse(await readFile(join(directory, 'recommendations.json.attempts.json'), 'utf8')).attempts
    assert.deepEqual(attempts.map((item: { status: string }) => item.status), ['rejected', 'validated'])
    assert.match(attempts[0].error, /omitted.*0\.1\.5-rc\.1/)
    const plan = buildDshInstallPlan(applyDshEnvironmentRecommendations(targets, observations, reviewed), observations, { changes: [] })
    assert.deepEqual(plan.matrix.include.map(item => item.dshVersion).sort(), ['0.1.5-rc.1', '0.1.5-rc.2'])
    assert.equal((await run('offline')).attempted, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('corrects a missing author TUI profile through the normal review command before surface planning', async () => {
  const { directory, targets, observations, run } = await fixture(undefined, true, 'author-console')
  try {
    assert.equal((await run('omit-tui-profile')).planned, 1)
    const reviewed = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    assert.equal(reviewed.entries[0].tuiProfile, 'author-console')
    const attempts = JSON.parse(await readFile(join(directory, 'recommendations.json.attempts.json'), 'utf8')).attempts
    assert.deepEqual(attempts.map((item: { status: string }) => item.status), ['rejected', 'validated'])
    const surfaces = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [],
    }, targets, observations, reviewed)
    assert.equal(surfaces.surfaces[0]?.profile, 'author-console')
    assert.equal((await run('offline')).attempted, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('returns independent validation errors together through the normal bounded review correction loop', async () => {
  const { directory, targets, observations, run } = await fixture(undefined, true, 'author-console', true)
  try {
    assert.equal((await run('multiple-errors')).planned, 1)
    const reviewed = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    assert.equal(reviewed.pendingTasks.length, 0)
    assert.equal(reviewed.entries[0].nodeEvidence[0].kind, 'declared-support')
    assert.deepEqual(reviewed.entries[0].authorEnvironment.overrides, [])
    assert.equal(reviewed.entries[0].authorEnvironment.startupConfigurations, undefined)
    const attempts = JSON.parse(await readFile(join(directory, 'recommendations.json.attempts.json'), 'utf8')).attempts
    assert.deepEqual(attempts.map((item: { status: string }) => item.status), ['rejected', 'validated'])
    for (const error of ['author override value', 'startup configuration requires', 'author-recommended Node']) {
      assert.ok(attempts[0].error.includes(error))
    }
    assert.ok(attempts[0].error.length <= 1024)
    const surfaces = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [],
    }, targets, observations, reviewed)
    assert.equal(surfaces.surfaces[0]?.profile, 'author-console')
    assert.equal((await run('offline')).attempted, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('reuses collected immutable repository bytes across processes without turning a later outage into a new review', async () => {
  const { directory, run } = await fixture()
  try {
    assert.equal((await run()).planned, 1)
    const before = await readFile(join(directory, 'recommendations.json'), 'utf8')
    const requests = await readFile(join(directory, 'requests.jsonl'), 'utf8')
    assert.equal((await run('offline')).attempted, 0, 'unchanged immutable input must reuse the completed review during a GitHub outage')
    assert.equal(await readFile(join(directory, 'recommendations.json'), 'utf8'), before)
    assert.equal(await readFile(join(directory, 'requests.jsonl'), 'utf8'), requests)
    const candidates = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))
    assert.deepEqual(candidates[0].collectionGaps, [])
    assert.ok(candidates[0].documents.some((document: { path: string }) => document.path === 'README.md'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('reuses deterministic collection limits while preserving the omitted-file coverage gap', async () => {
  const { directory, run } = await fixture()
  try {
    assert.equal((await run('oversized')).planned, 1)
    const before = await readFile(join(directory, 'candidates.json'), 'utf8')
    assert.match(before, /example\/plugin\/README.md exceeds 49152 bytes/)
    const reviewed = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
    assert.ok(reviewed.entries[0].coverageGaps.some((gap: string) => /collection is incomplete/.test(gap)))
    assert.equal((await run('offline')).attempted, 0, 'an unchanged size bound is not a reason to discard the collected documents')
    assert.equal(await readFile(join(directory, 'candidates.json'), 'utf8'), before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not reuse a different plugin commit and retries an unavailable new collection', async () => {
  const { directory, observations, run } = await fixture()
  try {
    await run()
    observations.targets.plugin.source.commit = 'b'.repeat(40)
    await writeFile(join(directory, 'observations.json'), JSON.stringify(observations))
    assert.equal((await run('offline')).planned, 1)
    const missing = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))[0]
    assert.equal(missing.sourceCommit, 'b'.repeat(40))
    assert.ok(!missing.documents.some((document: { path: string }) => document.path === 'README.md'), 'old plugin documents must not be attributed to the new commit')
    assert.ok(missing.documents.some((document: { path: string }) => document.path === 'dsh-repository/package.json'))
    assert.match(missing.collectionGaps.join(' '), /timed out/)
    assert.equal((await run()).planned, 1, 'a transient collection failure must not freeze incomplete evidence')
    const recovered = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))[0]
    assert.deepEqual(recovered.collectionGaps, [])
    assert.ok(recovered.documents.some((document: { path: string }) => document.path === 'README.md'))
    assert.equal((await run('offline')).attempted, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('binds the cache to the DSH commit and still re-reviews a changed published plugin coordinate', async () => {
  const { directory, observations, run } = await fixture()
  try {
    await run()
    const requests = await readFile(join(directory, 'requests.jsonl'), 'utf8')
    observations.targets.plugin.package.version = '1.0.1'
    await writeFile(join(directory, 'observations.json'), JSON.stringify(observations))
    assert.equal((await run('offline')).planned, 1)
    assert.equal(await readFile(join(directory, 'requests.jsonl'), 'utf8'), requests, 'same repository commit can reuse its bytes, but not the old package review')
    const changedPackage = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))[0]
    assert.equal(changedPackage.plugin, 'fixture-plugin@1.0.1')
    observations.targets['deepseek-harness'].source.commit = 'e'.repeat(40)
    await writeFile(join(directory, 'observations.json'), JSON.stringify(observations))
    assert.equal((await run('offline')).planned, 1)
    const changedDsh = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))[0]
    assert.ok(!changedDsh.documents.some((document: { path: string }) => document.path.startsWith('dsh-repository/')))
    assert.ok(changedDsh.documents.some((document: { path: string }) => document.path === 'README.md'))
    assert.match(changedDsh.collectionGaps.join(' '), /DSH baseline:.*timed out/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('recollects after a collector change and rejects corrupted or symlinked checkpoints before reviewing', async () => {
  const { directory, run } = await fixture()
  try {
    await run()
    const cachePath = join(directory, 'recommendations.json.evidence.json')
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    const requests = await readFile(join(directory, 'requests.jsonl'), 'utf8')
    cache.collectorFingerprint = 'f'.repeat(64)
    await writeFile(cachePath, JSON.stringify(cache))
    assert.equal((await run()).attempted, 0, 'unchanged recollected bytes may still reuse the completed review')
    assert.ok((await readFile(join(directory, 'requests.jsonl'), 'utf8')).length > requests.length, 'a different collector contract must recollect')
    const before = await readFile(join(directory, 'recommendations.json'), 'utf8')
    const currentCache = JSON.parse(await readFile(cachePath, 'utf8'))
    currentCache.entries[0].documents[0].text = 'corrupted cached bytes'
    await writeFile(cachePath, JSON.stringify(currentCache))
    await assert.rejects(run(), /cache digest/)
    assert.equal(await readFile(join(directory, 'recommendations.json'), 'utf8'), before)
    const external = join(directory, 'not-the-checkpoint.json')
    await writeFile(external, JSON.stringify(cache))
    await unlink(cachePath)
    await symlink(external, cachePath)
    await assert.rejects(run(), /ELOOP/)
    assert.equal(await readFile(join(directory, 'recommendations.json'), 'utf8'), before)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('never freezes a partial document fetch or parser error as complete evidence', async () => {
  for (const failure of ['document-timeout', 'bad-tree']) {
    const { directory, run } = await fixture()
    try {
      assert.equal((await run(failure)).planned, 1)
      const missing = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))[0]
      assert.ok(missing.collectionGaps.length > 0)
      const reviewed = JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8'))
      assert.ok(reviewed.entries[0].coverageGaps.some((gap: string) => /collection is incomplete/.test(gap)))
      assert.equal((await run()).planned, 1)
      const recovered = JSON.parse(await readFile(join(directory, 'candidates.json'), 'utf8'))[0]
      assert.deepEqual(recovered.collectionGaps, [])
      assert.equal((await run('offline')).attempted, 0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

it('rejects cache size, collection-count and document-path violations before any model delivery', async () => {
  const { directory, run } = await fixture()
  try {
    await run()
    const cachePath = join(directory, 'recommendations.json.evidence.json')
    const initial = JSON.parse(await readFile(cachePath, 'utf8'))
    const before = await readFile(join(directory, 'model-inputs.jsonl'), 'utf8')
    await truncate(cachePath, 64 * 1024 * 1024 + 1)
    await assert.rejects(run(), /bounded regular JSON file/)
    await writeFile(cachePath, JSON.stringify({ ...initial, entries: Array.from({ length: 102 }, () => initial.entries[0]) }))
    await assert.rejects(run(), /Invalid repository evidence cache/)
    initial.entries[0].documents[0].path = '../outside.md'
    await writeFile(cachePath, JSON.stringify(initial))
    await assert.rejects(run(), /Invalid cached repository document/)
    assert.equal(await readFile(join(directory, 'model-inputs.jsonl'), 'utf8'), before)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
