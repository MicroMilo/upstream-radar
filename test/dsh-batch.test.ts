import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DshBatchExecutionDeferred, runDshCompatibilityBatch, type DshBatchState, type DshBatchTask } from '../src/dsh-batch.js'
import type { DshSurfaceExpectedCase } from '../src/dsh-surface.js'
import { DSH_SURFACE_EXECUTION_CONTRACT } from '../src/dsh-surface-observation.js'

function nativeReport(task: DshBatchTask) {
  const cell = task.cell
  return {
    schema: 'upstream-radar.dsh-install-observation/v1alpha1', executionContract: 'dsh-install/v1alpha6',
    tool: { name: 'upstream-radar', version: '0.45.0' }, probe: 'dsh-install', scope: 'install-and-load-behavior',
    caseId: cell.id, completedAt: '2026-09-14T05:00:00.000Z', dshVersion: cell.dshVersion,
    runtime: { platform: 'linux', architecture: 'arm64', nodeVersion: `${cell.nodeMajor}.23.2`,
      packageManager: { name: 'pnpm', version: cell.profileEnvironment?.pnpmVersion ?? '11.7.0' } },
    profileEnvironment: cell.profileEnvironment, artifact: { spec: cell.plugin, sha256: 'a'.repeat(64), lifecycleScripts: [] },
    boundary: { approvedDependencyBuilds: [] }, result: 'compatible', reason: 'Fixture execution returned exact install/load and graph evidence.',
    resolution: { runtimeGraph: { digest: `sha256:${'b'.repeat(64)}`, nodes: 1, edges: 0, unresolved: 0,
      pluginPeerContracts: { declared: 0, satisfied: 0, mismatched: 0, indeterminate: 0, missing: 0, relations: [] } } },
  }
}

describe('durable DSH compatibility batch', () => {
  it('keeps an observed live handle for the next invocation when waiting expires', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: ['alpha', 'beta'].map(id => ({ id, spec: `${id}@1.0.0`, reason: 'live wait boundary fixture' })) }
    let durable: DshBatchState | undefined
    const options = { installTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async (state: DshBatchState) => { durable = structuredClone(state) } }
    const firstCalls: DshBatchTask[] = []
    const first = await runDshCompatibilityBatch({ ...options, execute: async task => {
      firstCalls.push(task)
      throw new DshBatchExecutionDeferred('Docker wait expired while this exact container is still running')
    } })
    assert.equal(firstCalls.length, 1, 'do not start another plugin while a live handle is deferred')
    assert.equal(first.state.tasks.find(task => task.key === firstCalls[0]?.key)?.status, 'running')
    assert.equal(first.state.tasks.find(task => task.key === firstCalls[0]?.key)?.attempts, 1)
    assert.deepEqual(first.deferredTaskKeys, [firstCalls[0]?.key])
    assert.equal(first.state.tasks.filter(task => task.status === 'failed').length, 0)
    assert.equal(durable?.tasks.find(task => task.key === firstCalls[0]?.key)?.status, 'running')
    const resumed: DshBatchTask[] = []
    const second = await runDshCompatibilityBatch({ ...options, state: JSON.parse(JSON.stringify(first.state)), maxTasks: 1,
      execute: async task => { resumed.push(task); return nativeReport(task) } })
    assert.equal(resumed[0]?.key, firstCalls[0]?.key)
    assert.equal(resumed[0]?.attempts, 1, 'reattach the same attempt instead of starting a duplicate container')
    assert.equal(second.state.nativeLedger.entries.length, 1)
    assert.deepEqual(second.deferredTaskKeys, [])
  })

  it('hands author baseline cells to both default and additional startup surfaces instead of dropping one configuration', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'terminal', spec: 'terminal@1.0.0', runtimeProfiles: ['node22'], reason: 'author baseline fixture',
        environmentRecommendation: { sourceFingerprint: `sha256:${'d'.repeat(64)}`, preferredNodeMajor: 22, nodeMajors: [22], unavailableNodeMajors: [],
          executionProfiles: ['tui'], summary: 'Author terminal workflow.', evidence: ['README.md'],
          authorEnvironment: { packageManagers: [], overrides: [], workflows: [],
            dshVersions: [{ version: '0.1.0-rc.8', evidence: [{ path: 'README.md', quote: 'DSH 0.1.0-rc.8' }] }] } } }] }
    const base = { id: `terminal-tui-${'x'.repeat(33)}`, sourceCaseId: 'terminal-node22', plane: 'tui', profile: 'author-tui', runtimeId: 'terminal', reason: 'author intended terminal' }
    const surfaceTargets = { schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [base, { ...base, id: `${base.id}-disabled`,
      startupConfiguration: { scope: 'Terminal with bridge stopped', environment: { DSH_BRIDGE_DISABLED: '1' } } }] }
    const profiles: DshBatchTask[] = []
    const result = await runDshCompatibilityBatch({ installTargets, surfaceTargets,
      runtime: { platform: 'linux', architecture: 'arm64' }, now: new Date('2026-09-14T05:01:00.000Z'),
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      checkpoint: async () => {}, execute: async task => {
        if (task.kind === 'native') return nativeReport(task)
        profiles.push(task)
        throw new Error('bounded surface executor fixture unavailable')
      } })
    assert.equal(result.executed, 6)
    assert.deepEqual(profiles.map(task => task.cell.dshVersion).sort(), ['0.1.0-rc.8', '0.1.0-rc.8', '0.1.5-rc.2', '0.1.5-rc.2'])
    assert.equal(profiles.filter(task => Reflect.get(task.cell, 'startupConfiguration')).length, 2)
    assert.ok(profiles.every(task => task.kind === 'surface' && Reflect.get(task.cell, 'profile') === 'author-tui'))
    assert.notEqual(profiles[0]?.cell.id, profiles[1]?.cell.id)
  })

  it('keeps byte-bound build review evidence across an executor rebuild and a later process restart', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: ['alpha', 'zulu'].map(id => ({ id, spec: `${id}@1.0.0`, reason: 'durable build review fixture' })) }
    const options = { installTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async () => {},
      execute: async (task: DshBatchTask) => task.cell.plugin === 'zulu@1.0.0' && !task.cell.allowedBuilds
        ? { ...nativeReport(task), result: 'build-approval-required', boundary: { approvedDependencyBuilds: [], requiredDependencyBuilds: ['sharp'] } }
        : { ...nativeReport(task), boundary: { approvedDependencyBuilds: task.cell.allowedBuilds ? ['sharp'] : [] } } }
    const original = await runDshCompatibilityBatch({ ...options, executorIdentity: 'original-image' })
    const buildPlans = { schema: 'upstream-radar.dsh-headless-agent-plans/v1alpha1', updatedAt: '2026-09-14T05:01:00.000Z', entries: [{
      caseId: 'zulu-node22', targetId: 'zulu', plugin: 'zulu@1.0.0', dshVersion: '0.1.5-rc.2', nodeMajor: 22,
      executionEnvironment: { platform: 'linux', architecture: 'arm64', profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } },
      result: 'build-approval-required', observedRequiredBuilds: ['sharp'], approvedBuilds: ['sharp'], allowedBuilds: ['sharp'],
      artifactSha256: 'a'.repeat(64), inputFingerprint: `sha256:${'d'.repeat(64)}`, plannedAt: '2026-09-14T05:01:00.000Z',
      model: 'test-boundary', action: 'retry-headless', classification: 'build-approval', summary: 'Observed sharp gate approved.', evidence: ['Observed sharp gate.'],
    }] }
    const rebuilt = await runDshCompatibilityBatch({ ...options, state: original.state, executorIdentity: 'rebuilt-image', buildPlans, maxTasks: 1 })
    assert.equal(rebuilt.state.nativeLedger.entries.length, 1)
    assert.equal(rebuilt.state.nativeLedger.entries[0]?.targetId, 'alpha')
    const resumed: DshBatchTask[] = []
    await runDshCompatibilityBatch({ ...options, state: JSON.parse(JSON.stringify(rebuilt.state)), executorIdentity: 'rebuilt-image', buildPlans,
      execute: async task => { resumed.push(task); return options.execute(task) } })
    assert.equal(resumed[0]?.cell.allowedBuilds, 'sharp', 'a restart must not lose the pending target\'s approved build binding')
    assert.equal(resumed.length, 1, 'the approved target must not repeat its known build gate')
  })

  it('reattaches a persisted live task before starting new work without incrementing its attempt', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: ['alpha', 'beta'].map(id => ({ id, spec: `${id}@1.0.0`, reason: 'live resume fixture' })) }
    let durable: DshBatchState | undefined
    const options = { installTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), maxTasks: 1,
      checkpoint: async (state: DshBatchState) => { if (!durable && state.tasks.some(task => task.status === 'running')) durable = structuredClone(state) },
      execute: async (task: DshBatchTask) => nativeReport(task) }
    await runDshCompatibilityBatch(options)
    const resumed: DshBatchTask[] = []
    await runDshCompatibilityBatch({ ...options, state: durable, execute: async task => { resumed.push(task); return nativeReport(task) } })
    assert.equal(resumed[0]?.cell.id, 'alpha-node22')
    assert.equal(resumed[0]?.attempts, 1)
  })

  it('durably schedules the evidenced SDK and ACP workflows against author and target DSH without substituting generic profiles', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'feishu', spec: 'dsh-feishu-bot@0.19.16', reason: 'author adapter fixture', runtimeProfiles: ['node22'],
        environmentRecommendation: { sourceFingerprint: `sha256:${'d'.repeat(64)}`, preferredNodeMajor: 22, nodeMajors: [22], unavailableNodeMajors: [],
          executionProfiles: ['sdk', 'acp'], summary: 'SDK is primary; ACP is supported.', evidence: ['README.md'],
          authorEnvironment: { packageManagers: [], overrides: [], workflows: [
            { kind: 'sdk', role: 'primary', evidence: [{ path: 'README.md', quote: 'sdk default' }] },
            { kind: 'acp', role: 'additional', evidence: [{ path: 'README.md', quote: 'acp supported' }] },
          ], dshVersions: [{ version: '0.1.0-rc.8', evidence: [{ path: 'README.md', quote: 'DSH 0.1.0-rc.8' }] }] } } }] }
    let durable: DshBatchState | undefined
    const adapters: DshBatchTask[] = []
    const options = { installTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async (state: DshBatchState) => { durable = structuredClone(state) },
      execute: async (task: DshBatchTask) => {
        assert.ok(durable?.tasks.some(item => item.key === task.key && item.status === 'running'))
        if (task.kind === 'native') return nativeReport(task)
        adapters.push(task)
        throw new Error('adapter executor temporarily unavailable')
      } }
    const first = await runDshCompatibilityBatch(options)
    assert.equal(first.executed, 6, 'two native DSH cells plus four independent adapter cells')
    assert.deepEqual(adapters.map(task => `${Reflect.get(task.cell, 'adapter')}:${task.cell.dshVersion}`).sort(), [
      'acp:0.1.0-rc.8', 'acp:0.1.5-rc.2', 'sdk:0.1.0-rc.8', 'sdk:0.1.5-rc.2',
    ])
    for (const task of adapters) {
      assert.equal(Reflect.get(task.cell, 'expectedArtifactSha256'), 'a'.repeat(64))
      assert.deepEqual(task.cell.profileEnvironment, { pnpmVersion: '11.7.0', overrides: {} })
    }
    const resumed = await runDshCompatibilityBatch({ ...options, state: first.state, maxTasks: 1 })
    assert.equal(resumed.executed, 1)
    assert.equal(adapters.at(-1)?.attempts, 2)
    const recoveredOptions = { ...options, execute: async (task: DshBatchTask) => {
      assert.equal(task.kind, 'adapter')
      return {
        schema: 'upstream-radar.dsh-adapter-observation/v1alpha1', executionContract: 'dsh-author-adapter/v1alpha2',
        recipe: Reflect.get(task.cell, 'recipe'), plugin: task.cell.plugin, dshVersion: task.cell.dshVersion,
        adapter: Reflect.get(task.cell, 'adapter'), profile: Reflect.get(task.cell, 'profile'),
        startedAt: '2026-09-14T05:00:00.000Z', completedAt: '2026-09-14T05:00:10.000Z',
        runtime: { nodeVersion: '22.23.2', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
        profileEnvironment: task.cell.profileEnvironment, artifact: { sha256: 'a'.repeat(64), bytes: 128 },
        stages: { runtime: 'passed', artifact: 'passed', install: 'failed', initialize: 'skipped', profileGraph: 'skipped' },
        commands: [], fixtureRequests: 0, result: 'unknown', reason: 'Bounded registry fixture unavailable; initialization was not tested.',
        coverageGaps: ['The independent runtime graph is unavailable.'], boundary: { lifecycleScripts: 'disabled', inheritedHostSecrets: false, note: 'Isolated boundary fixture.' },
      }
    } }
    const recovered = await runDshCompatibilityBatch({ ...recoveredOptions, state: resumed.state })
    assert.equal(recovered.state.adapterLedger.entries.length, 4)
    assert.equal(recovered.state.adapterLedger.entries[0]?.report.result, 'unknown', 'collection completion is not compatibility')
    assert.equal((await runDshCompatibilityBatch({ ...recoveredOptions, state: recovered.state })).executed, 0)
    assert.equal((await runDshCompatibilityBatch({ ...recoveredOptions, state: recovered.state,
      now: new Date('2026-09-15T05:01:00.000Z') })).executed, 4, 'unknown adapter evidence is retried after its bounded lifetime')
  })

  it('resumes a build-gated plugin only with the durable byte-bound review and then reuses its result', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'native', spec: 'native@1.0.0', reason: 'build retry fixture' }] }
    const delivered: DshBatchTask[] = []
    const options = { installTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async () => {},
      execute: async (task: DshBatchTask) => {
        delivered.push(task)
        const report = nativeReport(task)
        if (task.cell.allowedBuilds === '') return { ...report, result: 'build-approval-required', reason: 'Observed sharp build gate.',
          boundary: { approvedDependencyBuilds: [], requiredDependencyBuilds: ['sharp'] } }
        assert.equal(Reflect.get(task.cell, 'expectedArtifactSha256'), 'a'.repeat(64))
        return { ...report, boundary: { approvedDependencyBuilds: ['sharp'] } }
      } }
    const first = await runDshCompatibilityBatch(options)
    const buildPlans = { schema: 'upstream-radar.dsh-headless-agent-plans/v1alpha1', updatedAt: '2026-09-14T05:01:00.000Z', entries: [{
      caseId: 'native-node22', targetId: 'native', plugin: 'native@1.0.0', dshVersion: '0.1.5-rc.2', nodeMajor: 22,
      executionEnvironment: { platform: 'linux', architecture: 'arm64', profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } },
      result: 'build-approval-required', observedRequiredBuilds: ['sharp'], approvedBuilds: ['sharp'], allowedBuilds: ['sharp'],
      artifactSha256: 'a'.repeat(64), inputFingerprint: `sha256:${'d'.repeat(64)}`, plannedAt: '2026-09-14T05:01:00.000Z',
      model: 'test-boundary', action: 'retry-headless', classification: 'build-approval', summary: 'Fixture review approves the observed build.', evidence: ['Observed sharp build gate.'],
    }] }
    const retryOptions = { ...options, state: first.state, buildPlans }
    const retried = await runDshCompatibilityBatch(retryOptions)
    assert.equal(retried.executed, 1)
    assert.equal(retried.state.nativeLedger.entries[0]?.result, 'compatible')
    assert.equal((await runDshCompatibilityBatch({ ...retryOptions, state: retried.state })).executed, 0)
    assert.deepEqual(delivered.map(task => task.cell.allowedBuilds), ['', 'sharp'])
  })

  it('retries a surface-only build gate through its exact reviewed plan without rerunning the native cell', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'terminal', spec: 'terminal@1.0.0', reason: 'surface-only build gate fixture' }] }
    const surfaceTargets = { schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [{ id: 'terminal-tui', sourceCaseId: 'terminal-node22',
      plane: 'tui', profile: 'author-tui', runtimeId: 'terminal', reason: 'author intended terminal' }] }
    let durable: DshBatchState | undefined
    const delivered: DshBatchTask[] = []
    const options = { installTargets, surfaceTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async (state: DshBatchState) => { durable = structuredClone(state) },
      execute: async (task: DshBatchTask) => {
        delivered.push(task)
        assert.ok(durable?.tasks.some(item => item.key === task.key && item.status === 'running'))
        if (task.kind === 'native') return nativeReport(task)
        const cell = task.cell as DshSurfaceExpectedCase
        const approved = cell.allowedBuilds === 'node-pty'
        return { schema: 'upstream-radar.dsh-surface-observation/v1alpha1', executionContract: DSH_SURFACE_EXECUTION_CONTRACT,
          hostBuildInventory: { revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts', dshVersion: cell.dshVersion,
            pnpmVersion: '11.7.0', packages: [], coverageGaps: [], installation: { location: 'pnpm/dlx/fixture/instance',
              manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64), lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` } },
          tool: { name: 'upstream-radar', version: '0.45.0' }, probe: 'dsh-surface', scope: 'surface-runtime-behavior',
          ...cell, caseId: cell.id, startedAt: '2026-09-14T05:00:00.000Z', completedAt: '2026-09-14T05:00:10.000Z',
          artifact: { sha256: cell.artifactSha256 }, runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
          resolution: { runtimeGraph: { digest: `sha256:${'c'.repeat(64)}`, nodes: 2, edges: 1, unresolved: 0,
            hostRuntime: { source: 'dsh-process', resolvedNodes: 1, dshVersion: cell.dshVersion } } },
          stages: Object.fromEntries(['runtime', 'artifact', 'profile', 'install', 'registration', 'host', 'surface', 'interaction', 'shutdown'].map(stage => [stage, { status: approved ? 'passed' : 'skipped' }])),
          evidence: { plane: 'tui', terminal: 'xterm-256color', columns: 100, rows: 32, frameObserved: approved, inputSent: approved,
            exitedAfterShutdown: approved, exitCode: 0, normalizedFrame: approved ? 'Ready' : '', capturedBytes: approved ? 128 : 0, truncated: false },
          result: approved ? 'compatible' : 'environment-unsupported', reason: approved ? 'Fixture exact TUI completed.' : 'The TUI profile requires node-pty build approval.',
          boundary: { isolationProviderClaim: 'other', approvedDependencyBuilds: approved ? ['node-pty'] : [],
            requiredDependencyBuilds: approved ? [] : ['node-pty'], note: 'Fixture isolated executor.' } }
      } }
    const first = await runDshCompatibilityBatch(options)
    assert.equal(first.executed, 2)
    assert.equal(first.state.surfaceLedger.entries[0]?.result, 'environment-unsupported')
    const surface = first.state.surfaceLedger.entries[0]!
    const surfaceBuildPlans = { schema: 'upstream-radar.dsh-surface-agent-plans/v1alpha1', updatedAt: '2026-09-14T05:01:00.000Z', entries: [{
      caseId: surface.caseId, sourceCaseId: surface.sourceCaseId, plugin: surface.plugin, dshVersion: surface.dshVersion,
      nodeMajor: surface.runtime.nodeMajor, plane: surface.plane, profile: surface.profile, result: surface.result,
      observedRequiredBuilds: ['node-pty'], approvedBuilds: ['node-pty'], allowedBuilds: ['node-pty'],
      sourceFingerprint: surface.sourceFingerprint, artifactSha256: surface.artifact.sha256, inputFingerprint: `sha256:${'d'.repeat(64)}`,
      plannedAt: '2026-09-14T05:01:00.000Z', model: 'test-boundary', action: 'retry-surface', classification: 'build-approval',
      summary: 'The observed surface-only node-pty build is approved.', evidence: ['The TUI profile requires node-pty build approval.'],
    }] }
    const retryOptions = { ...options, state: JSON.parse(JSON.stringify(first.state)), surfaceBuildPlans }
    const retried = await runDshCompatibilityBatch(retryOptions)
    assert.equal(retried.executed, 1, 'the persisted surface gate must enter the reviewed retry')
    assert.equal(retried.state.surfaceLedger.entries[0]?.result, 'compatible')
    assert.deepEqual(delivered.map(task => [task.kind, task.cell.allowedBuilds]), [['native', ''], ['surface', ''], ['surface', 'node-pty']])
    assert.equal((await runDshCompatibilityBatch({ ...retryOptions, state: retried.state })).executed, 0)
  })

  it('does not let repeated installation failures starve a ready profile task under a small run budget', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: ['alpha', 'beta'].map(id => ({ id, spec: `${id}@1.0.0`, reason: 'fair execution fixture' })) }
    const surfaceTargets = { schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [{ id: 'beta-tui', sourceCaseId: 'beta-node22',
      plane: 'tui', profile: 'beta-tui', runtimeId: 'beta', reason: 'ready profile fixture' }] }
    let durable: DshBatchState | undefined
    const delivered: string[] = []
    const options = { installTargets, surfaceTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async (state: DshBatchState) => { durable = structuredClone(state) },
      execute: async (task: DshBatchTask) => {
        delivered.push(`${task.kind}:${task.cell.id}`)
        if (task.cell.plugin.startsWith('alpha@') || task.kind === 'surface') throw new Error('bounded executor fixture failure')
        return nativeReport(task)
      } }
    await runDshCompatibilityBatch({ ...options, maxTasks: 2 })
    await runDshCompatibilityBatch({ ...options, state: durable, maxTasks: 1 })
    assert.equal(delivered.at(-1), 'surface:beta-tui')
  })

  it('automatically hands current installation evidence to an independent intended-profile check', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: [{ id: 'terminal', spec: 'terminal@1.0.0', reason: 'profile handoff fixture' }] }
    const surfaceTargets = { schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [{ id: 'terminal-tui', sourceCaseId: 'terminal-node22',
      plane: 'tui', profile: 'author-tui', runtimeId: 'terminal', reason: 'author intended terminal' }] }
    let durable: DshBatchState | undefined
    const phases: string[] = []
    const options = { installTargets, surfaceTargets, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      observations: { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } } } },
      now: new Date('2026-09-14T05:01:00.000Z'), checkpoint: async (state: DshBatchState) => { durable = structuredClone(state) },
      execute: async (task: DshBatchTask) => {
        phases.push(task.kind)
        if (task.kind === 'native') return nativeReport(task)
        const cell = task.cell as DshSurfaceExpectedCase
        assert.equal(durable?.nativeLedger.entries[0]?.artifact.sha256, cell.artifactSha256)
        return { schema: 'upstream-radar.dsh-surface-observation/v1alpha1', executionContract: DSH_SURFACE_EXECUTION_CONTRACT,
          hostBuildInventory: { revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts', dshVersion: cell.dshVersion,
            pnpmVersion: '11.7.0', packages: [], coverageGaps: [], installation: { location: 'pnpm/dlx/fixture/instance',
              manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64), lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` } },
          tool: { name: 'upstream-radar', version: '0.45.0' }, probe: 'dsh-surface', scope: 'surface-runtime-behavior',
          ...cell, caseId: cell.id, startedAt: '2026-09-14T05:00:00.000Z', completedAt: '2026-09-14T05:00:10.000Z',
          artifact: { sha256: cell.artifactSha256 }, runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
          resolution: { runtimeGraph: { digest: `sha256:${'c'.repeat(64)}`, nodes: 2, edges: 1, unresolved: 0,
            hostRuntime: { source: 'dsh-process', resolvedNodes: 1, dshVersion: cell.dshVersion } } },
          stages: Object.fromEntries(['runtime', 'artifact', 'profile', 'install', 'registration', 'host', 'surface', 'interaction', 'shutdown'].map(stage => [stage, { status: 'passed' }])),
          evidence: { plane: 'tui', terminal: 'xterm-256color', columns: 100, rows: 32, frameObserved: true, inputSent: true,
            exitedAfterShutdown: true, exitCode: 0, normalizedFrame: 'Ready', capturedBytes: 128, truncated: false },
          result: 'compatible', reason: 'Fixture independent TUI evidence.', boundary: { isolationProviderClaim: 'other',
            approvedDependencyBuilds: [], note: 'Fixture isolated executor.' } }
      } }
    const result = await runDshCompatibilityBatch(options)
    assert.deepEqual(phases, ['native', 'surface'])
    assert.equal(result.state.surfaceLedger.entries.length, 1)
    assert.equal((await runDshCompatibilityBatch({ ...options, state: durable })).executed, 0)
  })

  it('continues past one executor failure, recovers it, reuses unchanged evidence and retests a changed plugin', async () => {
    const installTargets = { schema: 'upstream-radar.dsh-install-targets/v1alpha1', runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: ['alpha', 'beta'].map(id => ({ id, spec: `${id}@1.0.0`, observerTargetId: id, reason: 'bounded batch fixture' })) }
    const observations = { targets: { 'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } },
      alpha: { package: { name: 'alpha', version: '1.0.0' } }, beta: { package: { name: 'beta', version: '1.0.0' } } } }
    let durable: DshBatchState | undefined
    const executed: string[] = []
    const options = { installTargets, observations, runtime: { platform: 'linux' as const, architecture: 'arm64' as const },
      now: new Date('2026-09-14T05:01:00.000Z'),
      checkpoint: async (state: DshBatchState) => { durable = structuredClone(state) },
      execute: async (task: DshBatchTask) => {
        assert.ok(durable?.tasks.some(item => item.key === task.key && item.status === 'running'), 'persist before delivery')
        executed.push(task.cell.plugin)
        if (task.cell.plugin === 'alpha@1.0.0' && executed.length === 1) throw new Error('temporary executor fixture failure')
        return nativeReport(task)
      },
    }
    const first = await runDshCompatibilityBatch(options)
    assert.equal(first.state.nativeLedger.entries.length, 1)
    assert.deepEqual(executed, ['alpha@1.0.0', 'beta@1.0.0'])
    const recovered = await runDshCompatibilityBatch({ ...options, state: durable })
    assert.equal(recovered.state.nativeLedger.entries.length, 2)
    assert.deepEqual(executed, ['alpha@1.0.0', 'beta@1.0.0', 'alpha@1.0.0'])
    const unchanged = await runDshCompatibilityBatch({ ...options, state: durable })
    assert.equal(unchanged.executed, 0)
    observations.targets.alpha.package.version = '1.0.1'
    const changed = await runDshCompatibilityBatch({ ...options, state: durable })
    assert.equal(changed.executed, 1)
    assert.equal(executed.at(-1), 'alpha@1.0.1')
    assert.equal(changed.state.nativeLedger.entries.find(cell => cell.targetId === 'alpha')?.plugin, 'alpha@1.0.1')
  })
})
