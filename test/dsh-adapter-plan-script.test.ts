import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { promisify } from 'node:util'
import { applyDshEnvironmentRecommendations, createDshEnvironmentRecommendationInputFingerprint,
  DSH_ENVIRONMENT_REVIEW_CONTRACT, selectDshEnvironmentRecommendationCandidates } from '../src/dsh-environment-recommendation.js'
import { buildDshInstallPlan } from '../src/dsh-install-plan.js'
import { emptyDshCompatibilityLedger } from '../src/dsh-compatibility-ledger.js'
import { emptyDshAdapterLedger } from '../src/dsh-adapter.js'
import { DSH_ADAPTER_EXECUTION_CONTRACT } from '../src/dsh-adapter-observation.js'

const execFile = promisify(callback)

it('plans independent author and target SDK/ACP cells through the scheduled command and refuses stale installation sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-adapter-plan-'))
  try {
    const targets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'feishu', observerTargetId: 'feishu-source', spec: 'dsh-feishu-bot@0.19.16', reason: 'adapter planning fixture' }] }
    const observations = { targets: {
      'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } },
      'feishu-source': { package: { name: 'dsh-feishu-bot', version: '0.19.16' },
        manifest: { name: 'dsh-feishu-bot', version: '0.19.16', engines: { node: '>=22' } } },
    } }
    const candidate = selectDshEnvironmentRecommendationCandidates(targets, observations)[0]!
    const recommendations = { schema: 'upstream-radar.dsh-environment-recommendations/v1alpha1', updatedAt: new Date().toISOString(), pendingTasks: [],
      entries: [{ ...candidate, documents: undefined, manifest: undefined, reviewContract: DSH_ENVIRONMENT_REVIEW_CONTRACT,
        inputFingerprint: createDshEnvironmentRecommendationInputFingerprint(candidate), plannedAt: new Date().toISOString(), model: 'fixture',
        status: 'recommended', preferredNodeMajor: 22, nodeMajors: [22], executionProfiles: ['sdk', 'acp'], evidence: ['source-manifest'],
        summary: 'Author defaults to SDK with ACP as an additional adapter.',
        authorEnvironment: { packageManagers: [], overrides: [],
          workflows: ['sdk', 'acp'].map(kind => ({ kind, role: kind === 'sdk' ? 'primary' : 'additional', evidence: [{ path: 'README.md', quote: kind }] })),
          dshVersions: [{ version: '0.1.0-rc.8', evidence: [{ path: 'README.md', quote: '0.1.0-rc.8' }] }] } }] }
    const applied = applyDshEnvironmentRecommendations(targets, observations, recommendations)
    const native = buildDshInstallPlan(applied, observations, { changes: [] }, emptyDshCompatibilityLedger())
    const source = { ...emptyDshCompatibilityLedger(), entries: native.matrix.include.map(cell => ({
      caseId: cell.id, targetId: cell.targetId, plugin: cell.plugin, dshVersion: cell.dshVersion,
      staticFingerprint: cell.staticFingerprint, contractFingerprint: cell.contractFingerprint, observedAt: new Date().toISOString(),
      runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      profileEnvironment: cell.profileEnvironment, result: 'compatible', reason: 'Isolated fixture source.',
      artifact: { sha256: 'a'.repeat(64), lifecycleScripts: [] },
      observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
    })) }
    const values = [targets, observations, recommendations, source, emptyDshAdapterLedger(),
      { schema: 'upstream-radar.dsh-headless-agent-plans/v1alpha1', updatedAt: new Date().toISOString(), entries: [] }]
    const paths = values.map((_, i) => join(root, `${i}.json`))
    await Promise.all(values.map((v, i) => writeFile(paths[i]!, JSON.stringify(v))))
    const output = join(root, 'github-output')
    const run = async () => JSON.parse((await execFile(process.execPath, ['scripts/write-dsh-adapter-plan.mjs', ...paths],
      { cwd: process.cwd(), env: { ...process.env, GITHUB_OUTPUT: output }, timeout: 10_000 })).stdout)
    const planned = await run()
    assert.deepEqual(planned.blocked, [])
    assert.equal(planned.run, true)
    assert.deepEqual(planned.matrix.include.map((c: { adapter: string; dshVersion: string; versionRole: string }) => `${c.adapter}:${c.dshVersion}:${c.versionRole}`).sort(),
      ['acp:0.1.0-rc.8:author-baseline', 'acp:0.1.5-rc.2:target', 'sdk:0.1.0-rc.8:author-baseline', 'sdk:0.1.5-rc.2:target'])
    assert.match(await readFile(output, 'utf8'), /run=true\nmatrix=/)

    const cell = planned.matrix.include[0]
    const report = { schema: 'upstream-radar.dsh-adapter-observation/v1alpha1', executionContract: DSH_ADAPTER_EXECUTION_CONTRACT,
      plugin: cell.plugin, dshVersion: cell.dshVersion, adapter: cell.adapter, profile: cell.profile, recipe: cell.recipe,
      runtime: { nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      profileEnvironment: cell.profileEnvironment, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      artifact: { sha256: cell.expectedArtifactSha256, bytes: 1 }, commands: [], fixtureRequests: 0,
      stages: { runtime: 'passed', artifact: 'passed', install: 'failed', initialize: 'skipped', profileGraph: 'skipped' },
      boundary: { lifecycleScripts: 'disabled', inheritedHostSecrets: false, note: 'Fixture only, no target code ran.' },
      result: 'unknown', coverageGaps: ['Fixture installation unavailable.'], reason: 'An incomplete adapter observation is not a pass.' }
    const reports = join(root, 'reports'), matrix = join(root, 'matrix.json'), summaryPath = join(root, 'merge-summary.json')
    await mkdir(reports)
    await mkdir(join(reports, cell.id))
    await writeFile(join(reports, cell.id, 'report.json'), JSON.stringify(report))
    await writeFile(join(reports, cell.id, 'case.json'), JSON.stringify(cell))
    await writeFile(matrix, JSON.stringify(planned.matrix))
    const merge = async () => {
      await assert.rejects(execFile(process.execPath, ['scripts/merge-dsh-adapter-ledger.mjs', paths[4]!, matrix, reports, summaryPath],
        { cwd: process.cwd(), timeout: 10_000 }), (error: unknown) => (error as { code?: number }).code === 1)
      return JSON.parse(await readFile(summaryPath, 'utf8'))
    }
    const partial = await merge()
    assert.equal(partial.accepted.length, 1)
    assert.equal(partial.missing.length, 3)
    assert.deepEqual(partial.rejected, [])
    assert.equal(JSON.parse(await readFile(paths[4]!, 'utf8')).entries[0].report.result, 'unknown')
    assert.deepEqual((await merge()).transitions, [], 'unchanged incomplete evidence must not emit the same event again')
    await writeFile(join(reports, cell.id, 'case.json'), JSON.stringify({ ...cell, sourceFingerprint: `sha256:${'c'.repeat(64)}` }))
    assert.equal((await merge()).rejected.length, 1, 'an identical package does not authorize a different repository-evidence contract')
    await writeFile(join(reports, cell.id, 'case.json'), JSON.stringify(cell))
    await writeFile(join(reports, cell.id, 'report.json'), JSON.stringify({ ...report, dshVersion: '0.1.0-rc.99' }))
    const rejected = await merge()
    assert.equal(rejected.rejected.length, 1)
    assert.deepEqual(JSON.parse(await readFile(paths[4]!, 'utf8')).entries[0].report, report, 'rejecting a new report must preserve previously accepted evidence')

    await writeFile(paths[3]!, JSON.stringify({ ...source, entries: source.entries.map(e => ({ ...e, staticFingerprint: `sha256:${'f'.repeat(64)}` })) }))
    const stale = await run()
    assert.equal(stale.run, false)
    assert.deepEqual(stale.matrix.include, [])
    assert.equal(stale.blocked.length, 1)
    assert.match(stale.blocked[0].reason, /current byte-bound artifact/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
