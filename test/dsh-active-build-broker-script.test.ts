import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
import { createDshSurfaceSourceFingerprint } from '../src/dsh-surface.js'
import { createDshEnvironmentRecommendationInputFingerprint,
  DSH_ENVIRONMENT_RECOMMENDATIONS_SCHEMA, DSH_ENVIRONMENT_REVIEW_CONTRACT } from '../src/dsh-environment-recommendation.js'
import type { DshCompatibilityLedgerEntry } from '../src/dsh-compatibility-ledger.js'
import { addDshActiveRepositoryEvidence, emptyDshActiveRepositoryEvidence } from '../src/dsh-active-repository-evidence.js'

it('refuses a final Agent receipt when an explicitly selected Feishu adapter has no independent report', async () => {
  const script = await readFile(new URL('../../scripts/dsh-active-case-broker.mjs', import.meta.url), 'utf8')
  assert.match(script, /missingDshAuthorAdapterCoverage\(targetId, summary, state\)/)
  assert.match(script, /author adapter evidence is incomplete/)
})

it('does not conclude a proxy artifact failure before an independent direct-route retry', async () => {
  const script = await readFile(new URL('../../scripts/dsh-active-case-broker.mjs', import.meta.url), 'utf8')
  assert.match(script, /networkRoute === 'configured-proxy'/)
  assert.match(script, /exact npm artifact could not be established before execution/)
  assert.match(script, /network.*direct.*fresh launch/)
  assert.match(script, /selectedAt.*requestedAt/)
})

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { await readFile(path); return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`the exact broker state did not appear: ${path}`)
}

it('takes a live broker request from persisted build gate to graph-bound isolated retry plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-active-build-broker-'))
  const review = join(root, 'review'), output = join(root, 'batch'), control = join(root, 'control')
  const candidatePath = join(root, 'candidate.json'), targetsPath = join(root, 'targets.json')
  const observationsPath = join(root, 'observations.json'), executorPath = join(root, 'executor.json')
  const launchId = 'a'.repeat(32), graphDigest = `sha256:${'b'.repeat(64)}`
  let broker: ReturnType<typeof spawn> | undefined
  try {
    await Promise.all([mkdir(review), mkdir(output), mkdir(control)])
    const baseCandidate = { targetId: 'fixture', plugin: 'fixture@1.0.0',
      dshVersion: '0.1.6-alpha.1', sourceFingerprint: `sha256:${'c'.repeat(64)}`,
      repository: 'example/fixture', sourceCommit: '0'.repeat(40),
      documents: [{ path: 'README.md', text: 'Use the DSH plugin profile.' }] }
    const supplemental = addDshActiveRepositoryEvidence(emptyDshActiveRepositoryEvidence(baseCandidate),
      baseCandidate, { path: '.github/workflows/ci.yml', text: 'The author tests Node 20.' })
    await Promise.all([
      writeFile(candidatePath, JSON.stringify([baseCandidate])),
      writeFile(join(review, 'agent-evidence.json'), JSON.stringify(supplemental.state)),
      writeFile(targetsPath, JSON.stringify({ schema: 'upstream-radar.dsh-install-targets/v1alpha1',
        runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
        plugins: [{ id: 'fixture', spec: 'fixture@1.0.0', reason: 'exact broker fixture' }] })),
      writeFile(observationsPath, JSON.stringify({ targets: { 'deepseek-harness': {
        package: { name: '@deepseek-ai/dsh', version: '0.1.6-alpha.1' },
      } } })),
      writeFile(executorPath, JSON.stringify({ dockerContext: 'unused', architecture: 'arm64',
        timeoutSeconds: 180, maxTasks: 100 })),
      writeFile(join(output, 'agent-launch.json'), JSON.stringify({ id: launchId, targetId: 'fixture',
        requestedAt: '2026-09-15T16:00:00.000Z', log: `agent-batch-${launchId}.log` })),
      writeFile(join(output, 'summary.json'), JSON.stringify({ activeLaunchId: launchId,
        authorScopes: [{ id: 'fixture', recommendation: { inputFingerprint: supplemental.inputFingerprint,
          authorEnvironment: { dshVersions: [] } } }] })),
      writeFile(join(output, 'state.json'), JSON.stringify({ nativeLedger: {
        schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [{
          caseId: 'fixture-node22', targetId: 'fixture', plugin: 'fixture@1.0.0',
          dshVersion: '0.1.6-alpha.1', runtime: { nodeMajor: 22, nodeVersion: '22.23.2',
            platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
          profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} },
          staticFingerprint: `sha256:${'d'.repeat(64)}`, contractFingerprint: `sha256:${'e'.repeat(64)}`,
          observedAt: '2026-09-15T16:01:00.000Z', result: 'build-approval-required',
          reason: 'The isolated pnpm install named protobufjs.', requiredDependencyBuilds: ['protobufjs'],
          artifact: { lifecycleScripts: [], sha256: 'f'.repeat(64) },
          resolution: { runtimeGraph: { digest: graphDigest, nodes: 2, edges: 1, unresolved: 0 } },
          observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
        }] } })),
    ])
    const script = fileURLToPath(new URL('../../scripts/dsh-active-case-broker.mjs', import.meta.url))
    broker = spawn(process.execPath, [script, 'fixture', candidatePath, targetsPath, observationsPath,
      review, output, executorPath, control, '--execute'], { stdio: ['ignore', 'pipe', 'pipe'] })
    broker.stdout?.resume()
    broker.stderr?.resume()
    await waitFor(join(review, 'recommendations.json'))
    assert.deepEqual(JSON.parse(await readFile(join(review, 'observations.json'), 'utf8')),
      JSON.parse(await readFile(observationsPath, 'utf8')),
      'the broker must stage the exact observations before an Agent can launch the isolated batch')
    const tool = fileURLToPath(new URL('../../scripts/dsh-active-case-tool.mjs', import.meta.url))
    async function requestRaw(action: string, input: string): Promise<Record<string, unknown>> {
      const child = spawn(process.execPath, [tool, action, input], { env: { ...process.env,
        RADAR_CASE_TARGET_ID: 'fixture', RADAR_CASE_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk))
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    async function request(action: string, input: string): Promise<Record<string, unknown>> {
      const result = await requestRaw(action, input)
      assert.equal(result.ok, true, String(result.error))
      return result.value as Record<string, unknown>
    }
    const repositoryReview = await request('review', '')
    assert.match(String(repositoryReview.guidance), /\.github\/workflows\/ci\.yml/)
    assert.equal(repositoryReview.inputFingerprint, supplemental.inputFingerprint,
      'the broker must restore a supplemental file as a fresh exact reasoning input')
    const collectedFile = await request('evidence', 'README.md')
    assert.equal(collectedFile.alreadyCollected, true)
    assert.equal(collectedFile.pendingReview, false)
    assert.equal(collectedFile.inputFingerprint, supplemental.inputFingerprint,
      'reading an already-collected exact file must not invalidate current reasoning')
    const reasoning = JSON.parse(await readFile(join(review, 'recommendations.json'), 'utf8'))
    assert.equal(reasoning.pendingTasks[0].inputFingerprint, supplemental.inputFingerprint)
    const activeReasoning = JSON.parse(await readFile(join(output, 'agent-reasoning-input.json'), 'utf8'))
    assert.equal(activeReasoning.inputFingerprint, supplemental.inputFingerprint)
    const reviewed = await request('build-review', 'fixture-node22')
    assert.equal(reviewed.pending, true)
    const pending = JSON.parse(await readFile(join(review, 'build-plans.json'), 'utf8'))
    assert.equal(pending.pendingTasks.length, 1, 'the task is durable before the response reaches the agent')
    const accepted = await request('build', JSON.stringify({ caseId: 'fixture-node22', decision: {
      action: 'retry-headless', classification: 'build-approval', allowedBuilds: ['protobufjs'],
      summary: 'Only the observed package build in the isolated retry.', evidence: ['observed-build-gate'],
    } }))
    assert.equal(accepted.accepted, true)
    const plans = JSON.parse(await readFile(join(review, 'build-plans.json'), 'utf8'))
    assert.equal(plans.entries[0].dependencyGraphDigest, graphDigest)
    assert.deepEqual(plans.entries[0].approvedBuilds, ['protobufjs'])
    assert.equal(plans.pendingTasks.length, 0)
    const concluded = await requestRaw('conclude', JSON.stringify({ launchId,
      statement: 'The exact build gate was reviewed, but this fixture has no live compatibility proof.',
      coverageNotes: ['Only the dependency-build action was exercised.'] }))
    assert.equal(concluded.ok, false)
    assert.match(String(concluded.error), /re-review and relaunch/,
      'a valid build approval does not make an old repository conclusion current')
    await assert.rejects(readFile(join(output, 'agent-conclusion.json')), /ENOENT/)
  } finally {
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM')
      await new Promise(resolve => broker!.once('close', resolve))
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('takes a Web/TUI profile build gate through durable broker review without reusing a native-only permission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-active-surface-build-broker-'))
  const review = join(root, 'review'), output = join(root, 'batch'), control = join(root, 'control')
  const candidatePath = join(root, 'candidate.json'), targetsPath = join(root, 'targets.json')
  const observationsPath = join(root, 'observations.json'), executorPath = join(root, 'executor.json')
  const launchId = '1'.repeat(32), surfaceGraph = `sha256:${'2'.repeat(64)}`
  const baseCandidate = { targetId: 'fixture', plugin: 'fixture@1.0.0',
    dshVersion: '0.1.6-alpha.1', sourceFingerprint: `sha256:${'8'.repeat(64)}`,
    documents: [{ path: 'README.md', text: 'Use the author-tui profile.' }] }
  const inputFingerprint = createDshEnvironmentRecommendationInputFingerprint(baseCandidate)
  let broker: ReturnType<typeof spawn> | undefined
  try {
    await Promise.all([mkdir(review), mkdir(output), mkdir(control)])
    const native = {
      caseId: 'fixture-node22', targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
      runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
      profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} },
      staticFingerprint: `sha256:${'3'.repeat(64)}`, contractFingerprint: `sha256:${'4'.repeat(64)}`,
      observedAt: '2026-09-15T16:01:00.000Z', result: 'compatible', reason: 'Native loading completed.',
      artifact: { lifecycleScripts: [], sha256: '5'.repeat(64) },
      resolution: { runtimeGraph: { digest: `sha256:${'6'.repeat(64)}`, nodes: 2, edges: 1, unresolved: 0 } },
      observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.45.0' },
    }
    const sourceFingerprint = createDshSurfaceSourceFingerprint(native as DshCompatibilityLedgerEntry)
    const stages = Object.fromEntries(['runtime', 'artifact', 'profile', 'install', 'registration', 'host',
      'surface', 'interaction', 'shutdown'].map(name => [name, { status: name === 'install' ? 'failed' : 'skipped' }]))
    const surface = {
      caseId: 'fixture-tui', sourceCaseId: native.caseId, plugin: native.plugin, dshVersion: native.dshVersion,
      plane: 'tui', profile: 'author-tui', runtimeId: 'fixture', sourceFingerprint,
      contractFingerprint: `sha256:${'7'.repeat(64)}`, observedAt: '2026-09-15T16:02:00.000Z',
      runtime: native.runtime, artifact: { sha256: native.artifact.sha256 }, stages,
      requiredDependencyBuilds: ['node-pty'], approvedDependencyBuilds: [],
      resolution: { profileLockfile: { sha256: '9'.repeat(64), bytes: 1024,
        graphDigest: surfaceGraph, nodes: 3, edges: 2, unresolved: 0 },
        runtimeGraphError: 'plugin root is not yet installed' },
      evidence: { plane: 'tui', terminal: 'xterm-256color', columns: 100, rows: 32, frameObserved: false,
        inputSent: false, exitedAfterShutdown: false, normalizedFrame: '', capturedBytes: 0, truncated: false },
      result: 'environment-unsupported', reason: 'The isolated author TUI profile requires a node-pty build.',
      observer: { schema: 'upstream-radar.dsh-surface-observation/v1alpha1', version: '0.45.0' },
    }
    await Promise.all([
      writeFile(candidatePath, JSON.stringify([baseCandidate])),
      writeFile(targetsPath, JSON.stringify({ schema: 'upstream-radar.dsh-install-targets/v1alpha1',
        runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
        plugins: [{ id: 'fixture', spec: native.plugin, reason: 'exact surface broker fixture' }] })),
      writeFile(observationsPath, JSON.stringify({ targets: { 'deepseek-harness': {
        package: { name: '@deepseek-ai/dsh', version: native.dshVersion },
      } } })),
      writeFile(executorPath, JSON.stringify({ dockerContext: 'unused', architecture: 'arm64',
        timeoutSeconds: 180, maxTasks: 100 })),
      writeFile(join(output, 'agent-launch.json'), JSON.stringify({ id: launchId, targetId: 'fixture',
        requestedAt: '2026-09-15T16:00:00.000Z', log: `agent-batch-${launchId}.log` })),
      writeFile(join(output, 'summary.json'), JSON.stringify({ activeLaunchId: launchId, executed: 2,
        authorScopes: [{ id: 'fixture', recommendation: { inputFingerprint,
          authorEnvironment: { dshVersions: [] } } }] })),
      writeFile(join(output, 'state.json'), JSON.stringify({ nativeLedger: {
        schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1', entries: [native],
      }, surfaceLedger: { schema: 'upstream-radar.dsh-surface-ledger/v1alpha1', entries: [surface] } })),
    ])
    const script = fileURLToPath(new URL('../../scripts/dsh-active-case-broker.mjs', import.meta.url))
    broker = spawn(process.execPath, [script, 'fixture', candidatePath, targetsPath, observationsPath,
      review, output, executorPath, control, '--execute'], { stdio: ['ignore', 'pipe', 'pipe'] })
    broker.stdout?.resume()
    const brokerErrors: Buffer[] = []
    broker.stderr?.on('data', chunk => brokerErrors.push(Buffer.from(chunk)))
    await waitFor(join(review, 'recommendations.json')).catch(error => {
      throw new Error(`${String(error)}; broker: ${Buffer.concat(brokerErrors).toString('utf8')}`)
    })
    const tool = fileURLToPath(new URL('../../scripts/dsh-active-case-tool.mjs', import.meta.url))
    async function request(action: string, input: string): Promise<Record<string, unknown>> {
      const child = spawn(process.execPath, [tool, action, input], { env: { ...process.env,
        RADAR_CASE_TARGET_ID: 'fixture', RADAR_CASE_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk))
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(result.ok, true, result.error)
      return result.value
    }
    const reviewed = await request('surface-build-review', 'fixture-tui')
    assert.equal(reviewed.pending, true)
    const pending = JSON.parse(await readFile(join(review, 'surface-build-plans.json'), 'utf8'))
    assert.equal(pending.pendingTasks.length, 1, 'the exact Web/TUI handoff must exist before the model sees it')
    const accepted = await request('surface-build', JSON.stringify({ caseId: 'fixture-tui', decision: {
      action: 'retry-surface', classification: 'build-approval', allowedBuilds: ['node-pty'],
      summary: 'Allow only the observed author TUI profile package build.', evidence: ['The isolated install named node-pty.'],
    } }))
    assert.equal(accepted.accepted, true)
    const plans = JSON.parse(await readFile(join(review, 'surface-build-plans.json'), 'utf8'))
    assert.deepEqual(plans.entries[0].approvedBuilds, ['node-pty'])
    assert.equal(plans.entries[0].surfaceGraphDigest, surfaceGraph)
    assert.equal(plans.entries[0].surfaceGraphSource, 'profile-lock')
    assert.equal(plans.entries[0].sourceFingerprint, sourceFingerprint)
    assert.equal(plans.pendingTasks.length, 0)
  } finally {
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM')
      await new Promise(resolve => broker!.once('close', resolve))
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('requires a finished full ledger inspection and rejects an all-passed claim over a failed TUI shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-active-final-inspection-'))
  const review = join(root, 'review'), output = join(root, 'batch'), control = join(root, 'control')
  const candidatePath = join(root, 'candidate.json'), targetsPath = join(root, 'targets.json')
  const observationsPath = join(root, 'observations.json'), executorPath = join(root, 'executor.json')
  const launchId = '3'.repeat(32), at = '2026-09-15T16:00:00.000Z'
  const fixtureExecutor = { dockerContext: 'unused', architecture: 'arm64',
    timeoutSeconds: 180, maxTasks: 100 }
  const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
    sourceFingerprint: `sha256:${'4'.repeat(64)}`,
    documents: [{ path: 'README.md', text: 'Node 22 uses the author-tui TUI profile.\nHeadless operation: run this plugin in DSH headless mode.' }] }
  const inputFingerprint = createDshEnvironmentRecommendationInputFingerprint(candidate)
  let broker: ReturnType<typeof spawn> | undefined
  try {
    await Promise.all([mkdir(review), mkdir(output), mkdir(control)])
    await Promise.all([
      writeFile(candidatePath, JSON.stringify([candidate])),
      writeFile(targetsPath, JSON.stringify({ schema: 'upstream-radar.dsh-install-targets/v1alpha1',
        runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
        plugins: [{ id: 'fixture', spec: candidate.plugin, reason: 'exact terminal fixture' }] })),
      writeFile(observationsPath, JSON.stringify({ targets: { 'deepseek-harness': {
        package: { name: '@deepseek-ai/dsh', version: candidate.dshVersion },
      } } })),
      writeFile(executorPath, JSON.stringify(fixtureExecutor)),
      writeFile(join(output, 'agent-network-route.json'), JSON.stringify({ targetId: 'fixture',
        route: 'direct', configFingerprint: createHash('sha256').update(JSON.stringify(fixtureExecutor)).digest('hex'),
        selectedAt: '2026-09-15T15:59:00.000Z' })),
      writeFile(join(review, 'recommendations.json'), JSON.stringify({ schema: DSH_ENVIRONMENT_RECOMMENDATIONS_SCHEMA,
        updatedAt: at, pendingTasks: [], entries: [{ ...candidate, documents: undefined,
          reviewContract: DSH_ENVIRONMENT_REVIEW_CONTRACT, inputFingerprint, plannedAt: at, model: 'fixture',
          status: 'recommended', preferredNodeMajor: 22, nodeMajors: [22], executionProfiles: ['tui'],
          tuiProfile: 'author-tui', summary: 'The fixture intends an interactive TUI.', evidence: ['README.md'] }] })),
      writeFile(join(output, 'agent-launch.json'), JSON.stringify({ id: launchId, targetId: 'fixture',
        requestedAt: at, log: `agent-batch-${launchId}.log` })),
      writeFile(join(output, 'agent-launch-result.json'), JSON.stringify({ id: launchId, exitCode: 0,
        finishedAt: '2026-09-15T16:01:00.000Z' })),
      writeFile(join(output, 'summary.json'), JSON.stringify({ activeLaunchId: launchId, executed: 0,
        authorScopes: [{ id: 'fixture', recommendation: { inputFingerprint,
          sourceFingerprint: candidate.sourceFingerprint, preferredNodeMajor: 22,
          nodeMajors: [22], executionProfiles: ['tui'],
          summary: 'The fixture intends an interactive TUI.', evidence: ['README.md'] } }],
        nativeCells: 1, surfaceCells: 1, adapterCells: 0,
        nextNativePlan: { matrix: { include: [] } }, nextSurfacePlan: { matrix: { include: [] } },
        nextAdapterPlan: { matrix: { include: [] } }, failedTasks: [], deferredTaskKeys: [] })),
      writeFile(join(output, 'state.json'), JSON.stringify({ executorIdentity: 'exact-fixture', tasks: [],
        nativeLedger: { entries: [{ caseId: 'fixture-node22', targetId: 'fixture',
          dshVersion: candidate.dshVersion, runtime: { nodeMajor: 22 }, result: 'compatible' }] },
        surfaceLedger: { entries: [{ caseId: 'fixture-node22-tui', sourceCaseId: 'fixture-node22',
          dshVersion: candidate.dshVersion, runtime: { nodeMajor: 22 }, result: 'surface-incompatible',
          reason: 'frame observed but controlled shutdown failed' }] },
        adapterLedger: { entries: [] } })),
    ])
    const script = fileURLToPath(new URL('../../scripts/dsh-active-case-broker.mjs', import.meta.url))
    broker = spawn(process.execPath, [script, 'fixture', candidatePath, targetsPath, observationsPath,
      review, output, executorPath, control, '--execute'], { stdio: ['ignore', 'pipe', 'pipe'] })
    broker.stdout?.resume()
    const brokerErrors: Buffer[] = []
    broker.stderr?.on('data', chunk => brokerErrors.push(Buffer.from(chunk)))
    await waitFor(join(output, 'agent-reasoning-input.json')).catch(error => {
      throw new Error(`${String(error)}; broker: ${Buffer.concat(brokerErrors).toString('utf8')}`)
    })
    const tool = fileURLToPath(new URL('../../scripts/dsh-active-case-tool.mjs', import.meta.url))
    async function request(action: string, input: string): Promise<Record<string, unknown>> {
      const child = spawn(process.execPath, [tool, action, input], { env: { ...process.env,
        RADAR_CASE_TARGET_ID: 'fixture', RADAR_CASE_CONTROL: control }, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk))
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    const allPassed = JSON.stringify({ launchId, statement: 'All TUI results passed.', coverageNotes: ['Only this fixture was covered.'] })
    const before = await request('conclude', allPassed)
    assert.equal(before.ok, false)
    assert.match(String(before.error), /inspect/)
    const inspection = await request('inspect', '')
    assert.equal(inspection.ok, true, String(inspection.error))
    assert.deepEqual((inspection.value as { entries: Array<{ result: string }> }).entries.map(entry => entry.result),
      ['compatible', 'surface-incompatible'])
    assert.deepEqual((inspection.value as { entries: Array<{ dshVersion: string; nodeMajor: number }> })
      .entries.map(entry => [entry.dshVersion, entry.nodeMajor]),
      [[candidate.dshVersion, 22], [candidate.dshVersion, 22]],
      'the Agent needs exact DSH and Node facts in its inspect hand before writing prose')
    const wrong = await request('conclude', allPassed)
    assert.equal(wrong.ok, false)
    assert.match(String(wrong.error), /non-compatible/)
    const wrongVersion = await request('conclude', JSON.stringify({ launchId,
      statement: '目标渠道 DSH 0.1.5-rc.2：原生加载通过，TUI 受控关闭失败。',
      coverageNotes: ['Only this fixture was covered.'] }))
    assert.equal(wrongVersion.ok, false)
    assert.match(String(wrongVersion.error), /DSH version|version attribution/)
    const correct = await request('conclude', JSON.stringify({ launchId,
      statement: '整体不兼容；原生加载通过，但 TUI 画面出现后受控关闭失败。',
      coverageNotes: ['The terminal result is surface-incompatible.'] }))
    assert.equal(correct.ok, true, String(correct.error))
    assert.deepEqual(JSON.parse(await readFile(join(output, 'agent-final-inspection.json'), 'utf8')).resultCounts,
      { native: { compatible: 1 }, surface: { 'surface-incompatible': 1 }, adapter: {} })
    const revised = await request('recommend', JSON.stringify({ decision: {
      status: 'recommended', preferredNodeMajor: 22, nodeMajors: [22], executionProfiles: ['headless'],
      authorEnvironment: { packageManagers: [], overrides: [], workflows: [{ kind: 'headless',
        role: 'primary', evidence: [{ path: 'README.md', quote: 'Headless operation: run this plugin in DSH headless mode.' }] }], dshVersions: [] },
      summary: 'The author now intends the documented DSH headless operation in this fixture.', evidence: ['README.md'],
    } }))
    assert.equal(revised.ok, true, String(revised.error))
    const stalePlan = await request('conclude', JSON.stringify({ launchId,
      statement: 'The prior TUI run is not a review of the newly recommended workflow.',
      coverageNotes: ['The model changed its author intent decision without another launch.'] }))
    assert.equal(stalePlan.ok, false)
    assert.match(String(stalePlan.error), /re-review and relaunch/)
  } finally {
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM')
      await new Promise(resolve => broker!.once('close', resolve))
    }
    await rm(root, { recursive: true, force: true })
  }
})
