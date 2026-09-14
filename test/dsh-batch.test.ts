import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runDshCompatibilityBatch, type DshBatchState, type DshBatchTask } from '../src/dsh-batch.js'
import type { DshSurfaceExpectedCase } from '../src/dsh-surface.js'

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
        return { schema: 'upstream-radar.dsh-surface-observation/v1alpha1', executionContract: 'dsh-surface/v1alpha10',
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
