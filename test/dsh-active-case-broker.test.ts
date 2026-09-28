import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createDshActiveCaseBroker } from '../src/dsh-active-case-broker.js'
import { emptyDshEnvironmentRecommendations } from '../src/dsh-environment-recommendation.js'

it('gives one agent the review, launch and watch lifecycle without opening a shell bridge', async () => {
  const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.5-rc.2',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`, publishedManifest: { name: 'fixture', version: '1.0.0', engines: { node: '>=22' } },
    documents: [{ path: '.nvmrc', text: '22\n' },
      { path: 'README.md', text: 'Use the DSH headless profile: dsh plugin --profile headless add fixture.\n' }] }
  const state = emptyDshEnvironmentRecommendations()
  const calls: string[] = []
  const broker = createDshActiveCaseBroker({ candidate, state,
    save: async () => { calls.push('persist') },
    launch: async () => { calls.push('launch'); return { started: true } },
    selectNetworkRoute: async route => { calls.push(`network:${route}`); return { route } },
    watch: async cursor => { calls.push(`watch:${cursor}`); return { cursor: cursor + 1, status: 'running', events: [] } },
    inspect: async () => ({ status: 'running' }), cancel: async () => ({ cancelled: true }) })
  const request = (action: string, input: Record<string, unknown> = {}) => ({
    schema: 'upstream-radar.dsh-active-case-request/v1alpha1', id: 'a'.repeat(32), targetId: 'fixture', action, input })
  await broker.initialize()
  assert.deepEqual(calls, ['persist'], 'the task is durable before the first agent action')
  const review = await broker.handle(request('review')) as { targetId: string; guidance: string }
  assert.equal(review.targetId, candidate.targetId)
  assert.match(review.guidance, /README\.md|headless/)
  await assert.rejects(broker.handle(request('launch')), /recommendation/)
  const decision = { status: 'recommended', preferredNodeMajor: 22, nodeMajors: [22],
    nodeEvidence: [{ nodeMajor: 22, kind: 'declared-support', evidence: ['published-manifest'] }],
    executionProfiles: ['headless'], authorEnvironment: { packageManagers: [], overrides: [],
      workflows: [{ kind: 'headless', profile: 'headless', role: 'primary',
        evidence: [{ path: 'README.md', quote: 'dsh plugin --profile headless add fixture' }] }], dshVersions: [] },
    summary: 'Node 22 is declared in engines and pinned in .nvmrc; no author preference was proven.', evidence: ['.nvmrc', 'README.md', 'published-manifest'] }
  const reviewed = { ...decision, executionProfiles: ['web'], evidence: ['.nvmrc', 'README.md', 'published-manifest'],
    summary: 'Fixture Web manifest is cited.' }
  // A fixture with no Web declaration cannot be silently expanded by an agent.
  await assert.rejects(broker.handle(request('recommend', { decision: reviewed })), /Web|web/)
  assert.deepEqual(calls, ['persist'], 'invalid recommendations cannot alter execution state')
  assert.equal((await broker.handle(request('recommend', { decision })) as { accepted: boolean }).accepted, true)
  assert.deepEqual(await broker.handle(request('network', { route: 'direct' })), { route: 'direct' })
  assert.deepEqual(await broker.handle(request('launch')), { started: true })
  assert.deepEqual(await broker.handle(request('watch', { cursor: 0 })), { cursor: 1, status: 'running', events: [] })
  assert.deepEqual(calls, ['persist', 'persist', 'network:direct', 'launch', 'watch:0'])
})

it('routes an observed dependency build gate through bounded review and decision callbacks', async () => {
  const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`, documents: [] }
  const calls: string[] = []
  const broker = createDshActiveCaseBroker({ candidate, state: emptyDshEnvironmentRecommendations(),
    save: async () => { calls.push('persist-case') },
    launch: async () => ({ started: true }), watch: async () => ({ status: 'running', events: [] }),
    inspect: async () => ({}), cancel: async () => ({}), selectNetworkRoute: async () => ({}),
    reviewBuild: async caseId => { calls.push(`review-build:${caseId}`); return { caseId, pending: true } },
    decideBuild: async (caseId, decision) => { calls.push(`decide-build:${caseId}`); return { caseId, decision } },
  })
  const request = (action: string, input: Record<string, unknown>) => ({
    schema: 'upstream-radar.dsh-active-case-request/v1alpha1', id: 'b'.repeat(32), targetId: 'fixture', action, input })
  await broker.initialize()
  assert.deepEqual(await broker.handle(request('build-review', { caseId: 'fixture-node22' })),
    { caseId: 'fixture-node22', pending: true })
  const decision = { action: 'retry-headless', classification: 'build-approval', allowedBuilds: ['protobufjs'],
    summary: 'Exact observed gate.', evidence: ['observed-build-gate'] }
  assert.deepEqual(await broker.handle(request('build', { caseId: 'fixture-node22', decision })),
    { caseId: 'fixture-node22', decision })
  assert.deepEqual(calls, ['persist-case', 'review-build:fixture-node22', 'decide-build:fixture-node22'])
})

it('lets the same agent request one bounded pinned file through the trusted repository evidence collector', async () => {
  const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`, documents: [] }
  const calls: string[] = []
  const broker = createDshActiveCaseBroker({ candidate, state: emptyDshEnvironmentRecommendations(),
    save: async () => { calls.push('persist-case') }, launch: async () => ({}), watch: async () => ({}),
    inspect: async () => ({}), cancel: async () => ({}), selectNetworkRoute: async () => ({}),
    fetchEvidence: async input => { calls.push(`fetch:${input.path}:${input.offset ?? 'full'}`)
      return { ...input, refreshedReview: true } },
  })
  await broker.initialize()
  const result = await broker.handle({ schema: 'upstream-radar.dsh-active-case-request/v1alpha1',
    id: 'e'.repeat(32), targetId: 'fixture', action: 'evidence',
    input: { path: '.github/workflows/ci.yml' } })
  assert.deepEqual(result, { path: '.github/workflows/ci.yml', refreshedReview: true })
  assert.deepEqual(calls, ['persist-case', 'fetch:.github/workflows/ci.yml:full'])
  const excerpt = await broker.handle({ schema: 'upstream-radar.dsh-active-case-request/v1alpha1',
    id: 'f'.repeat(32), targetId: 'fixture', action: 'evidence',
    input: { path: 'README.md', offset: 24 * 1024 } })
  assert.deepEqual(excerpt, { path: 'README.md', offset: 24 * 1024, refreshedReview: true })
  assert.deepEqual(calls, ['persist-case', 'fetch:.github/workflows/ci.yml:full',
    'fetch:README.md:24576'])
})

it('routes a Web/TUI dependency build gate through its separate bounded review and retry plan', async () => {
  const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`, documents: [] }
  const calls: string[] = []
  const broker = createDshActiveCaseBroker({ candidate, state: emptyDshEnvironmentRecommendations(),
    save: async () => { calls.push('persist-case') }, launch: async () => ({}), watch: async () => ({}),
    inspect: async () => ({}), cancel: async () => ({}), selectNetworkRoute: async () => ({}),
    reviewSurfaceBuild: async caseId => { calls.push(`review-surface:${caseId}`); return { pending: true } },
    decideSurfaceBuild: async caseId => { calls.push(`decide-surface:${caseId}`); return { accepted: true } },
  })
  await broker.initialize()
  const request = (action: string, input: Record<string, unknown>) => ({
    schema: 'upstream-radar.dsh-active-case-request/v1alpha1', id: 'd'.repeat(32), targetId: 'fixture', action, input })
  assert.deepEqual(await broker.handle(request('surface-build-review', { caseId: 'fixture-node22-tui' })), { pending: true })
  assert.deepEqual(await broker.handle(request('surface-build', { caseId: 'fixture-node22-tui', decision: {
    action: 'retry-surface', classification: 'build-approval', allowedBuilds: ['node-pty'],
    summary: 'Exact gate.', evidence: ['profile output'],
  } })), { accepted: true })
  assert.deepEqual(calls, ['persist-case', 'review-surface:fixture-node22-tui', 'decide-surface:fixture-node22-tui'])
})

it('routes a bounded final Agent conclusion without treating it as a policy decision', async () => {
  const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`, documents: [] }
  const broker = createDshActiveCaseBroker({ candidate, state: emptyDshEnvironmentRecommendations(),
    save: async () => {}, launch: async () => ({}), watch: async () => ({}), inspect: async () => ({}),
    cancel: async () => ({}), selectNetworkRoute: async () => ({}),
    conclude: async input => ({ accepted: true, modelAuthored: true, input }),
  })
  await broker.initialize()
  const input = { launchId: 'b'.repeat(32), statement: 'Observed load needs external account.', coverageNotes: [] }
  const result = await broker.handle({ schema: 'upstream-radar.dsh-active-case-request/v1alpha1',
    id: 'c'.repeat(32), targetId: 'fixture', action: 'conclude', input }) as Record<string, unknown>
  assert.equal(result.accepted, true)
  assert.equal(result.modelAuthored, true)
})
