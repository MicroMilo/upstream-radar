import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  dshActiveAgentCaseClosed,
  dshActiveAgentCaseFormerlyClosedForAdapterRepair,
  runDshActiveAgentSupervisor,
  unresolvedFreshDshBuildGateCaseIds,
  type DshActiveAgentCaseSnapshot,
} from '../src/dsh-active-agent-supervisor.js'

const targetId = 'cloudflare-browser'
const launchId = 'a'.repeat(32)
const reasoningFingerprint = `sha256:${'c'.repeat(64)}`

function closedSnapshot(withCoverageGap = false) {
  const summary = { activeLaunchId: launchId, executed: 1,
    authorScopes: [{ id: targetId, recommendation: { inputFingerprint: reasoningFingerprint } }], failedTasks: [], deferredTaskKeys: [],
    nextNativePlan: { matrix: { include: [] }, blocked: withCoverageGap
      ? [{ targetId, reason: 'author Node 18 is outside isolated executor coverage' }] : [] },
    nextSurfacePlan: { matrix: { include: [] } },
    nextAdapterPlan: { matrix: { include: [] } }, orphanedRunningTasks: [] }
  const state = { nativeLedger: { entries: [] }, surfaceLedger: { entries: [] },
    adapterLedger: { entries: [] }, executorIdentity: 'exact-executor', tasks: [] }
  const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary,
    nativeLedger: state.nativeLedger, surfaceLedger: state.surfaceLedger,
    adapterLedger: state.adapterLedger, executorIdentity: state.executorIdentity })).digest('hex')}`
  return { reasoningInput: { targetId, inputFingerprint: reasoningFingerprint },
    launch: { id: launchId, targetId }, launchResult: { id: launchId,
      exitCode: withCoverageGap ? 2 : 0,
    finishedAt: '2026-09-15T16:00:30.000Z' }, summary, state,
    monitor: { schema: 'upstream-radar.dsh-active-case-monitor/v1alpha1', targetId, launchId,
      launchStartedAt: '2026-09-15T16:00:00.000Z',
      lastRunningWatchAt: '2026-09-15T16:00:25.000Z', maxRunningWatchGapMs: 15_000,
      runningWatches: 3, runningEvents: 10 },
    conclusion: { targetId, activeLaunchId: launchId, evidenceDigest,
      modelAuthored: true, compatibilityPass: false, statement: 'Exact bounded account.' } }
}

describe('proactive agent session supervision', () => {
  it('does not accept a premature or stale model conclusion as a completed case', () => {
    const complete = closedSnapshot()
    assert.equal(dshActiveAgentCaseClosed(targetId, complete), true)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete,
      summary: { ...complete.summary, nextSurfacePlan: { matrix: { include: ['web'] } } } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete,
      conclusion: { ...complete.conclusion, activeLaunchId: 'b'.repeat(32) } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete,
      monitor: { ...complete.monitor, runningWatches: 0 } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete,
      monitor: { ...complete.monitor, maxRunningWatchGapMs: 70_000 } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete,
      launchResult: { ...complete.launchResult, id: 'b'.repeat(32) } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete,
      reasoningInput: { targetId, inputFingerprint: `sha256:${'d'.repeat(64)}` } }), false,
    'supplemental repository evidence invalidates the old completed case')
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...complete, reasoningInput: undefined }), false)
  })

  it('does not close an author-declared Feishu headless adapter from generic native evidence alone', () => {
    const id = 'feishu-bot'
    const original = closedSnapshot()
    const summary = { ...original.summary, authorScopes: [{ id,
      recommendation: { inputFingerprint: reasoningFingerprint, executionProfiles: ['headless', 'sdk', 'acp'],
        authorEnvironment: { workflows: [{ kind: 'headless' }, { kind: 'sdk' }, { kind: 'acp' }],
          dshVersions: [{ version: '0.1.0-rc.8' }] } } }] }
    const state = { ...original.state, nativeLedger: { entries: [
      { targetId: id, plugin: 'dsh-feishu-bot@0.19.16', dshVersion: '0.1.5-rc.2', runtime: { nodeMajor: 22 } },
      { targetId: id, plugin: 'dsh-feishu-bot@0.19.16', dshVersion: '0.1.0-rc.8', runtime: { nodeMajor: 22 } },
    ] }, adapterLedger: { entries: ['sdk', 'acp'].flatMap(adapter => ['0.1.5-rc.2', '0.1.0-rc.8'].map(dshVersion =>
      ({ cell: { targetId: id, plugin: 'dsh-feishu-bot@0.19.16', dshVersion, nodeMajor: 22, adapter },
        report: { result: 'initialize-compatible' } }))) } }
    const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary,
      nativeLedger: state.nativeLedger, surfaceLedger: state.surfaceLedger,
      adapterLedger: state.adapterLedger, executorIdentity: state.executorIdentity })).digest('hex')}`
    const snapshot = { ...original, reasoningInput: { targetId: id, inputFingerprint: reasoningFingerprint },
      launch: { ...original.launch, targetId: id }, summary, state,
      monitor: { ...original.monitor, targetId: id },
      conclusion: { ...original.conclusion, targetId: id, evidenceDigest } }
    assert.equal(dshActiveAgentCaseClosed(id, snapshot), false,
      'a generic native headless install is not the author legacy headless adapter initialize handshake')
    assert.equal(dshActiveAgentCaseFormerlyClosedForAdapterRepair(id, snapshot), true,
      'only a previously exact-closed receipt with the newly detected adapter omission may be reopened')
    const completed = { ...snapshot, state: { ...state, adapterLedger: { entries: [
      ...state.adapterLedger.entries,
      ...['0.1.5-rc.2', '0.1.0-rc.8'].map(dshVersion => ({ cell: { targetId: id,
        plugin: 'dsh-feishu-bot@0.19.16', dshVersion, nodeMajor: 22, adapter: 'headless' },
      report: { result: 'unknown' } })),
    ] } } }
    const completeDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary,
      nativeLedger: completed.state.nativeLedger, surfaceLedger: completed.state.surfaceLedger,
      adapterLedger: completed.state.adapterLedger, executorIdentity: completed.state.executorIdentity })).digest('hex')}`
    assert.equal(dshActiveAgentCaseClosed(id, { ...completed,
      conclusion: { ...completed.conclusion, evidenceDigest: completeDigest } }), true,
      'an independently observed unknown result may close as incomplete coverage, never as a compatibility pass')
    assert.equal(dshActiveAgentCaseFormerlyClosedForAdapterRepair(id, { ...completed,
      conclusion: { ...completed.conclusion, evidenceDigest: completeDigest } }), false)
  })

  it('closes a fully observed non-runnable coverage gap without treating a worker failure as closure', () => {
    const gap = closedSnapshot(true)
    assert.equal(dshActiveAgentCaseClosed(targetId, gap), true,
      'exit 2 from an explicit blocked author environment is not a runner crash')
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...gap,
      summary: { ...gap.summary, failedTasks: [{ key: 'failed-worker' }] } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...gap,
      summary: { ...gap.summary, orphanedRunningTasks: [{ key: 'running-worker' }] } }), false)
    assert.equal(dshActiveAgentCaseClosed(targetId, { ...closedSnapshot(),
      launchResult: { ...closedSnapshot().launchResult, exitCode: 2 } }), false,
    'an unexplained nonzero exit is not a coverage gap')
  })

  it('does not close a resolvable dependency-build gate just because its task was accepted', () => {
    const gap = closedSnapshot(true)
    const gate = { caseId: `${targetId}-node22`, targetId, plugin: 'fixture@1.0.0',
      dshVersion: '0.1.6-alpha.1', result: 'build-approval-required',
      requiredDependencyBuilds: ['protobufjs'], artifact: { sha256: 'f'.repeat(64) },
      resolution: { runtimeGraph: { digest: `sha256:${'b'.repeat(64)}` } } }
    const state = { ...gap.state, nativeLedger: { entries: [gate] } }
    const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify({ summary: gap.summary,
      nativeLedger: state.nativeLedger, surfaceLedger: state.surfaceLedger,
      adapterLedger: state.adapterLedger, executorIdentity: state.executorIdentity })).digest('hex')}`
    const gated = { ...gap, state, conclusion: { ...gap.conclusion, evidenceDigest } }
    assert.equal(dshActiveAgentCaseClosed(targetId, gated), false,
      'accepted task status is not proof that its explicit dependency gate was resolved')
    const stopped = { ...gated, buildPlans: { entries: [{ caseId: gate.caseId, targetId,
      action: 'stop-headless', artifactSha256: gate.artifact.sha256,
      dependencyGraphDigest: gate.resolution.runtimeGraph.digest,
      observedRequiredBuilds: gate.requiredDependencyBuilds }], pendingTasks: [] } }
    assert.equal(dshActiveAgentCaseClosed(targetId, stopped), true,
      'a graph-bound explicit stop can close as incomplete coverage without pretending compatibility')
  })

  it('requires a decision for every fresh dependency-build gate before relaunch', () => {
    const first = { caseId: `${targetId}-node22`, targetId, result: 'build-approval-required',
      observedAt: '2026-09-28T09:45:48.329Z', requiredDependencyBuilds: ['protobufjs'],
      artifact: { sha256: 'a'.repeat(64) },
      resolution: { runtimeGraph: { digest: `sha256:${'b'.repeat(64)}` } } }
    const second = { ...first, caseId: `${targetId}-node22-dsh-legacy`,
      artifact: { sha256: 'c'.repeat(64) },
      resolution: { runtimeGraph: { digest: `sha256:${'d'.repeat(64)}` } } }
    const state = { nativeLedger: { entries: [first, second,
      { ...second, caseId: `${targetId}-stale`, observedAt: '2026-09-28T09:39:00.000Z' }] } }
    const plans = { pendingTasks: [], entries: [{ caseId: first.caseId, targetId,
      action: 'retry-headless', artifactSha256: first.artifact.sha256,
      dependencyGraphDigest: first.resolution.runtimeGraph.digest,
      observedRequiredBuilds: first.requiredDependencyBuilds }] }
    assert.deepEqual(unresolvedFreshDshBuildGateCaseIds(targetId, state, plans,
      '2026-09-28T09:42:28.000Z'), [second.caseId],
    'one approved case may not make a second exact DSH baseline gate stale and unrecoverable')
    assert.deepEqual(unresolvedFreshDshBuildGateCaseIds(targetId, state, { ...plans,
      entries: [...plans.entries, { caseId: second.caseId, targetId, action: 'stop-headless',
        artifactSha256: second.artifact.sha256,
        dependencyGraphDigest: second.resolution.runtimeGraph.digest,
        observedRequiredBuilds: second.requiredDependencyBuilds }] }, '2026-09-28T09:42:28.000Z'), [])
  })

  it('wakes the same agent session on a fixed cadence during healthy execution', async () => {
    const complete = closedSnapshot()
    const running = { ...complete, summary: undefined, conclusion: undefined }
    const turns: Array<{ sessionId: string | undefined; reason: string }> = []
    const waits: number[] = []
    let current: DshActiveAgentCaseSnapshot = running
    const result = await runDshActiveAgentSupervisor({ targetId,
      snapshot: async () => current,
      turn: async (input) => {
        turns.push({ sessionId: input.sessionId, reason: input.reason })
        if (turns.length === 3) current = complete
        return { sessionId: '11111111-1111-4111-8111-111111111111' }
      },
      wait: async duration => { waits.push(duration) },
      intervalMs: 15_000, maxTurns: 5,
    })
    assert.equal(result.closed, true)
    assert.equal(result.turns, 3)
    assert.deepEqual(waits, [15_000, 15_000])
    assert.equal(turns[0]!.sessionId, undefined)
    assert.equal(turns[1]!.sessionId, turns[2]!.sessionId)
    assert.deepEqual(turns.map(item => item.reason), ['initial', 'periodic', 'periodic'])
  })

  it('stops at its turn budget instead of certifying an unfinished case', async () => {
    const result = await runDshActiveAgentSupervisor({ targetId,
      snapshot: async () => ({}),
      turn: async () => ({ sessionId: '11111111-1111-4111-8111-111111111111' }),
      wait: async () => {}, intervalMs: 15_000, maxTurns: 2,
    })
    assert.deepEqual(result, { closed: false, turns: 2,
      sessionId: '11111111-1111-4111-8111-111111111111' })
  })

  it('continues the exact recorded model session after a broker repair', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const inputs: Array<{ reason: string; sessionId: string | undefined }> = []
    const result = await runDshActiveAgentSupervisor({ targetId, initialSessionId: sessionId,
      snapshot: async () => ({}), turn: async input => {
        inputs.push({ reason: input.reason, sessionId: input.sessionId })
        return { sessionId }
      }, wait: async () => {}, intervalMs: 8_000, maxTurns: 1 })
    assert.deepEqual(inputs, [{ reason: 'periodic', sessionId }])
    assert.deepEqual(result, { closed: false, turns: 1, sessionId })
  })

  it('immediately resumes an interrupted turn so a long model call cannot replace periodic observation', async () => {
    const waits: number[] = []
    const turns: string[] = []
    const result = await runDshActiveAgentSupervisor({ targetId,
      snapshot: async () => ({}),
      turn: async input => {
        turns.push(input.reason)
        return { sessionId: '11111111-1111-4111-8111-111111111111', interrupted: turns.length === 1 }
      },
      wait: async duration => { waits.push(duration) }, intervalMs: 15_000, maxTurns: 2,
    })
    assert.equal(result.closed, false)
    assert.deepEqual(turns, ['initial', 'periodic'])
    assert.deepEqual(waits, [], 'the watchdog may not add idle time after a timed-out model turn')
  })
})
