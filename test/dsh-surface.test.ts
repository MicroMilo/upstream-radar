import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DshCompatibilityLedger } from '../src/dsh-compatibility-ledger.js'
import {
  DSH_SURFACE_OBSERVATION_SCHEMA,
  dshSurfaceProfileStrategy,
  evaluateDshTuiEvidence,
  evaluateDshWebEvidence,
  type DshSurfaceObservationReport,
} from '../src/dsh-surface-observation.js'
import {
  buildDshSurfaceIR,
  buildDshSurfacePlan,
  emptyDshSurfaceLedger,
  mergeDshSurfaceLedger,
  parseDshSurfaceTargets,
  type DshSurfaceExpectedCase,
  type DshSurfaceLedger,
} from '../src/dsh-surface.js'

const SOURCE_STATIC = `sha256:${'a'.repeat(64)}`
const SOURCE_CONTRACT = `sha256:${'b'.repeat(64)}`
const ARTIFACT_SHA = 'c'.repeat(64)

function sourceLedger(overrides: Partial<DshCompatibilityLedger['entries'][number]> = {}): DshCompatibilityLedger {
  return {
    schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
    entries: [{
      caseId: 'web-plugin-node22',
      targetId: 'web-plugin',
      plugin: 'web-plugin@1.2.3',
      dshVersion: '0.1.1-rc.2',
      runtime: {
        nodeMajor: 22,
        nodeVersion: '22.23.2',
        platform: 'linux',
        architecture: 'x64',
        pnpmVersion: '11.7.0',
      },
      staticFingerprint: SOURCE_STATIC,
      contractFingerprint: SOURCE_CONTRACT,
      observedAt: '2026-08-24T00:00:00.000Z',
      result: 'compatible',
      reason: 'headless install and load passed',
      artifact: { lifecycleScripts: [], sha256: ARTIFACT_SHA },
      observer: { schema: 'upstream-radar.dsh-install-observation/v1alpha1', version: '0.43.5' },
      ...overrides,
    }],
  }
}

function webClientGapEntry(
  caseId: string,
  plugin: string,
): DshCompatibilityLedger['entries'][number] {
  const source = sourceLedger().entries[0] as DshCompatibilityLedger['entries'][number]
  return {
    ...source,
    caseId,
    targetId: caseId.replace(/-node22$/, ''),
    plugin,
    result: 'peer-contract-incompatible',
    reason: 'the exact package loaded, but its browser-client peers are absent from headless',
    artifact: { ...source.artifact, sha256: 'd'.repeat(64) },
    resolution: {
      runtimeGraph: {
        digest: `sha256:${'e'.repeat(64)}`,
        nodes: 10,
        edges: 9,
        unresolved: 1,
        unresolvedDependencies: [{
          from: `node_modules/${plugin.split('@')[0]}`,
          name: '@deepseek-ai/dsh-client-ui-primitives',
          spec: '0.1.1-rc.2',
          kind: 'peer',
        }],
      },
    },
  }
}

const targets = {
  schema: 'upstream-radar.dsh-surface-targets/v1alpha1',
  refreshAfterHours: 168,
  surfaces: [
    {
      id: 'web-plugin-web',
      sourceCaseId: 'web-plugin-node22',
      plane: 'web',
      profile: 'web',
      runtimeId: 'web-plugin',
      reason: 'Exercise the published browser entry.',
    },
    {
      id: 'web-plugin-tui',
      sourceCaseId: 'web-plugin-node22',
      plane: 'tui',
      profile: 'plugin-tui',
      runtimeId: 'web-plugin',
      reason: 'Exercise the terminal entry in a PTY.',
    },
  ],
}

function compatibleReport(expected: DshSurfaceExpectedCase, plane: 'web' | 'tui' = expected.plane): DshSurfaceObservationReport {
  const common = {
    schema: DSH_SURFACE_OBSERVATION_SCHEMA,
    tool: { name: 'upstream-radar' as const, version: '0.44.0' },
    probe: 'dsh-surface' as const,
    scope: 'surface-runtime-behavior' as const,
    startedAt: '2026-08-25T00:00:00.000Z',
    completedAt: '2026-08-25T00:01:00.000Z',
    caseId: expected.id,
    sourceCaseId: expected.sourceCaseId,
    sourceFingerprint: expected.sourceFingerprint,
    contractFingerprint: expected.contractFingerprint,
    plugin: expected.plugin,
    dshVersion: expected.dshVersion,
    plane,
    profile: expected.profile,
    runtimeId: expected.runtimeId,
    runtime: {
      nodeMajor: expected.nodeMajor,
      nodeVersion: '22.23.2',
      platform: 'linux',
      architecture: 'x64',
      pnpmVersion: '11.7.0',
    },
    artifact: { sha256: expected.artifactSha256, bytes: 1024 },
    stages: {
      runtime: { status: 'passed' as const },
      artifact: { status: 'passed' as const },
      profile: { status: 'passed' as const },
      install: { status: 'passed' as const },
      registration: { status: 'passed' as const },
      host: { status: 'passed' as const },
      surface: { status: 'passed' as const },
      interaction: { status: 'passed' as const },
      shutdown: { status: 'passed' as const },
    },
    result: 'compatible' as const,
    reason: 'the declared surface produced bounded runtime evidence',
    boundary: {
      isolationProviderClaim: 'github-actions-hosted-runner' as const,
      isolationVerifiedByRadar: false as const,
      disposableEnvironmentRequired: true as const,
      inheritedHostSecrets: false as const,
      externalBrowserRequestsBlocked: plane === 'web',
      approvedDependencyBuilds: expected.allowedBuilds === '' ? [] : expected.allowedBuilds.split(','),
      note: 'fixture',
    },
  }
  return plane === 'web'
    ? {
        ...common,
        evidence: {
          plane: 'web',
          url: 'http://127.0.0.1:3080/',
          httpStatus: 200,
          title: 'DSH',
          rootMounted: true,
          bootManifestPresent: true,
          pluginEntryPresent: true,
          pluginBundleStatus: 200,
          applicationMounted: true,
          pluginMaterialized: true,
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          screenshot: 'surface.png',
          trace: 'surface-trace.zip',
        },
      }
    : {
        ...common,
        evidence: {
          plane: 'tui',
          terminal: 'xterm-256color',
          columns: 100,
          rows: 32,
          frameObserved: true,
          inputSent: true,
          exitedAfterShutdown: true,
          exitCode: 0,
          transcript: 'surface.ansi',
          normalizedFrame: 'DeepSeek Harness\nReady',
          capturedBytes: 128,
          truncated: false,
        },
      }
}

describe('DSH execution-plane evidence', () => {
  it('initializes the stock Web profile but lets plugin add create a custom TUI profile', () => {
    assert.equal(dshSurfaceProfileStrategy('web'), 'initialize-stock-profile')
    assert.equal(dshSurfaceProfileStrategy('tui'), 'create-with-plugin-add')
  })

  it('requires DSH to hand off from its boot page after activating the Web client graph', () => {
    assert.deepEqual(evaluateDshWebEvidence({
      driverAvailable: true,
      hostStarted: true,
      httpStatus: 200,
      rootMounted: true,
      bootManifestPresent: true,
      pluginEntryPresent: true,
      pluginBundleStatus: 200,
      applicationMounted: true,
      pluginMaterialized: true,
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    }), {
      result: 'compatible',
      failedStage: undefined,
      reason: 'the Web host mounted and the declared plugin client entry was published, fetched, and materialized',
    })

    const missing = evaluateDshWebEvidence({
      driverAvailable: true,
      hostStarted: true,
      httpStatus: 200,
      rootMounted: true,
      bootManifestPresent: true,
      pluginEntryPresent: true,
      pluginBundleStatus: 200,
      applicationMounted: false,
      pluginMaterialized: false,
      bootFailureText: 'Failed to load plugins dsh-univer-office',
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    })
    assert.equal(missing.result, 'surface-incompatible')
    assert.equal(missing.failedStage, 'surface')
    assert.match(missing.reason, /did not hand off/)
    assert.match(missing.reason, /dsh-univer-office/)
  })

  it('does not turn a missing browser into a plugin incompatibility', () => {
    const result = evaluateDshWebEvidence({
      driverAvailable: false,
      hostStarted: false,
      rootMounted: false,
      bootManifestPresent: false,
      pluginEntryPresent: false,
      applicationMounted: false,
      pluginMaterialized: false,
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    })
    assert.equal(result.result, 'environment-unsupported')
    assert.equal(result.failedStage, 'surface')
  })

  it('requires a TUI frame, PTY input and controlled shutdown', () => {
    assert.equal(evaluateDshTuiEvidence({
      driverAvailable: true,
      frameObserved: true,
      inputSent: true,
      exitedAfterShutdown: true,
      exitCode: 0,
    }).result, 'compatible')

    const empty = evaluateDshTuiEvidence({
      driverAvailable: true,
      frameObserved: false,
      inputSent: false,
      exitedAfterShutdown: true,
      exitCode: 1,
    })
    assert.equal(empty.result, 'surface-incompatible')
    assert.match(empty.reason, /before producing a terminal frame/)
  })
})

describe('DSH execution-plane reconciliation', () => {
  it('derives exact Web and TUI jobs from the durable headless artifact evidence', () => {
    const plan = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    assert.equal(plan.run, true)
    assert.deepEqual(plan.matrix.include.map(item => item.id), ['web-plugin-tui', 'web-plugin-web'])
    assert.equal(plan.matrix.include.every(item => item.plugin === 'web-plugin@1.2.3'), true)
    assert.equal(plan.matrix.include.every(item => item.dshVersion === '0.1.1-rc.2'), true)
    assert.equal(plan.matrix.include.every(item => item.artifactSha256 === ARTIFACT_SHA), true)
    assert.equal(plan.matrix.include.every(item => item.allowedBuilds === ''), true)
    assert.equal(plan.matrix.include.every(item => item.reasons.includes('missing-evidence')), true)
  })

  it('automatically routes Web-client-only headless gaps without duplicating explicit targets', () => {
    const ledger = sourceLedger({
      ...webClientGapEntry('web-plugin-node22', 'web-plugin@1.2.3'),
      artifact: { lifecycleScripts: [], sha256: ARTIFACT_SHA },
    })
    ledger.entries.push(webClientGapEntry('auto-client-node22', 'auto-client@2.0.0'))
    ledger.entries.push({
      ...webClientGapEntry('host-contract-node22', 'host-contract@3.0.0'),
      artifact: { lifecycleScripts: [], sha256: 'f'.repeat(64) },
      resolution: {
        runtimeGraph: {
          digest: `sha256:${'1'.repeat(64)}`,
          nodes: 10,
          edges: 9,
          unresolved: 1,
          pluginPeerContracts: {
            declared: 1,
            satisfied: 0,
            mismatched: 1,
            indeterminate: 0,
            missing: 0,
            relations: [{
              name: '@deepseek-ai/dsh-attachment',
              required: '0.1.0-rc.8',
              resolvedVersion: '0.1.1-rc.2',
              status: 'mismatched',
              staticUsage: 'runtime-import-observed',
            }],
            issues: [{
              name: '@deepseek-ai/dsh-attachment',
              required: '0.1.0-rc.8',
              resolvedVersion: '0.1.1-rc.2',
              status: 'mismatched',
              staticUsage: 'runtime-import-observed',
            }],
          },
        },
      },
    })

    const plan = buildDshSurfacePlan(
      { ...targets, autoDiscover: { webClientGaps: true } },
      ledger,
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
    )

    assert.deepEqual(plan.matrix.include.map(item => item.id), [
      'auto-client-node22-web',
      'web-plugin-tui',
      'web-plugin-web',
    ])
    const automatic = plan.matrix.include[0]
    assert.equal(automatic?.plane, 'web')
    assert.equal(automatic?.profile, 'web')
    assert.equal(automatic?.runtimeId, 'auto-client')
    assert.deepEqual(automatic?.reasons, ['missing-evidence'])
    assert.equal(plan.matrix.include.filter(item => item.sourceCaseId === 'web-plugin-node22' && item.plane === 'web').length, 1)
    assert.equal(plan.matrix.include.some(item => item.sourceCaseId === 'host-contract-node22'), false)
  })

  it('validates the optional automatic Web routing switch', () => {
    assert.throws(() => parseDshSurfaceTargets({
      ...targets,
      autoDiscover: { webClientGaps: 'yes' },
    }), /autoDiscover\.webClientGaps must be boolean/)
  })

  it('derives the Web module id from the exact package coordinate, not a Cordis loader row id', () => {
    const staleLoaderTarget = {
      ...targets,
      surfaces: targets.surfaces.map(surface => surface.plane === 'web'
        ? { ...surface, runtimeId: 'legacy-cordis-row' }
        : surface),
    }
    const plan = buildDshSurfacePlan(staleLoaderTarget, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    assert.equal(plan.matrix.include.find(item => item.plane === 'web')?.runtimeId, 'web-plugin')
  })

  it('carries the Agent-approved install environment into every execution plane', () => {
    const plan = buildDshSurfacePlan(
      targets,
      sourceLedger({ approvedDependencyBuilds: ['protobufjs', '@google/genai'] }),
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
    )
    assert.equal(plan.matrix.include.every(item => item.allowedBuilds === '@google/genai,protobufjs'), true)
    const merged = mergeDshSurfaceLedger({
      ledger: emptyDshSurfaceLedger(),
      expected: plan.matrix.include,
      reports: plan.matrix.include.map(expected => compatibleReport(expected)),
    })
    assert.deepEqual(merged.ledger.entries[0]?.approvedDependencyBuilds, ['@google/genai', 'protobufjs'])
  })

  it('reuses an exact retained Agent build policy when the headless result moved to another plane', () => {
    const source = sourceLedger({
      result: 'unknown',
      reason: 'the exact artifact loaded, but Web host peers are unresolved in headless',
      resolution: {
        runtimeGraph: {
          digest: `sha256:${'d'.repeat(64)}`,
          nodes: 3,
          edges: 2,
          unresolved: 1,
          unresolvedDependencies: [{
            from: 'node_modules/web-plugin',
            name: '@deepseek-ai/dsh-client-ui-primitives',
            spec: '0.1.1-rc.2',
            kind: 'peer',
          }],
        },
      },
    })
    const agentPlans = {
      schema: 'upstream-radar.dsh-headless-agent-plans/v1alpha1',
      updatedAt: '2026-08-25T00:00:00.000Z',
      entries: [{
        caseId: 'web-plugin-node22',
        targetId: 'web-plugin',
        plugin: 'web-plugin@1.2.3',
        dshVersion: '0.1.1-rc.2',
        nodeMajor: 22,
        result: 'unknown',
        observedRequiredBuilds: ['node-pty', 'ssh2'],
        approvedBuilds: ['node-pty', 'ssh2'],
        artifactSha256: ARTIFACT_SHA,
        inputFingerprint: `sha256:${'9'.repeat(64)}`,
        plannedAt: '2026-08-25T00:00:00.000Z',
        model: 'deepseek-v4-flash',
        action: 'stop-headless',
        classification: 'different-plane',
        allowedBuilds: [],
        summary: 'The retained native builds are justified, but the remaining gap belongs to Web.',
        evidence: ['The exact earlier retries observed and approved node-pty and ssh2.'],
      }],
    }

    const plan = buildDshSurfacePlan(
      targets,
      source,
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
      agentPlans,
    )

    assert.equal(plan.matrix.include.every(item => item.allowedBuilds === 'node-pty,ssh2'), true)

    const changedArtifact = buildDshSurfacePlan(
      targets,
      sourceLedger({
        ...source.entries[0],
        artifact: { lifecycleScripts: [], sha256: '8'.repeat(64) },
      }),
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
      agentPlans,
    )
    assert.equal(changedArtifact.matrix.include.every(item => item.allowedBuilds === ''), true)
  })

  it('routes a bounded headless unknown into its explicitly configured execution plane', () => {
    const plan = buildDshSurfacePlan(
      targets,
      sourceLedger({
        result: 'unknown',
        reason: 'the exact artifact loaded, but Web host peers are unresolved in headless',
        resolution: {
          runtimeGraph: {
            digest: `sha256:${'d'.repeat(64)}`,
            nodes: 3,
            edges: 2,
            unresolved: 1,
          },
        },
      }),
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
    )
    assert.equal(plan.run, true)
    assert.equal(plan.blocked.length, 0)
    assert.equal(plan.matrix.include.every(item => item.artifactSha256 === ARTIFACT_SHA), true)
  })

  it('still blocks a surface run when the headless observer did not bind exact artifact bytes', () => {
    const plan = buildDshSurfacePlan(
      targets,
      sourceLedger({ result: 'unknown', artifact: { lifecycleScripts: [] } }),
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
    )
    assert.equal(plan.run, false)
    assert.equal(plan.blocked.length, 2)
    assert.match(plan.blocked[0]?.reason ?? '', /no exact artifact bytes/)
  })

  it('does not enter a surface while the Agent still needs to approve dependency builds', () => {
    const plan = buildDshSurfacePlan(
      targets,
      sourceLedger({
        result: 'build-approval-required',
        requiredDependencyBuilds: ['node-pty'],
      }),
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:00:00.000Z'),
    )
    assert.equal(plan.run, false)
    assert.equal(plan.blocked.length, 2)
    assert.match(plan.blocked[0]?.reason ?? '', /headless environment must be resolved/)
  })

  it('stays quiet with fresh exact evidence and invalidates both planes after an upstream artifact change', () => {
    const first = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    const reports = first.matrix.include.map(expected => compatibleReport(expected))
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: first.matrix.include, reports })
    const quiet = buildDshSurfacePlan(targets, sourceLedger(), merged.ledger, new Date('2026-08-25T01:00:00.000Z'))
    assert.equal(quiet.run, false)

    const changed = buildDshSurfacePlan(targets, sourceLedger({
      plugin: 'web-plugin@1.2.4',
      artifact: { lifecycleScripts: [], sha256: 'd'.repeat(64) },
    }), merged.ledger, new Date('2026-08-25T01:00:00.000Z'))
    assert.equal(changed.run, true)
    assert.equal(changed.matrix.include.every(item => item.reasons.includes('source-evidence-changed')), true)
  })

  it('rejects a report from the wrong execution plane instead of filling the desired cell', () => {
    const plan = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    const expected = plan.matrix.include.find(item => item.plane === 'web') as DshSurfaceExpectedCase
    const report = compatibleReport(expected, 'tui')
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.deepEqual(merged.acceptedCaseIds, [])
    assert.deepEqual(merged.missingCaseIds, [expected.id])
    assert.equal(merged.rejectedReports.length, 1)
  })

  it('builds an IR that aligns one exact upstream coordinate with plane-specific downstream evidence', () => {
    const plan = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    const merged = mergeDshSurfaceLedger({
      ledger: emptyDshSurfaceLedger(),
      expected: plan.matrix.include,
      reports: plan.matrix.include.map(expected => compatibleReport(expected)),
    })
    const ir = buildDshSurfaceIR(merged.ledger)
    assert.equal(ir.cells.length, 2)
    assert.deepEqual(ir.cells.map(cell => cell.plane), ['tui', 'web'])
    assert.equal(ir.cells.every(cell => cell.plugin.artifactSha256 === ARTIFACT_SHA), true)
    assert.equal(ir.cells.every(cell => cell.upstream.dshVersion === '0.1.1-rc.2'), true)
  })

  it('rejects duplicate targets and nonsensical profile-plane mappings', () => {
    assert.throws(() => parseDshSurfaceTargets({
      ...targets,
      surfaces: [targets.surfaces[0], targets.surfaces[0]],
    }), /duplicate DSH surface target id/)
    assert.throws(() => parseDshSurfaceTargets({
      ...targets,
      surfaces: [{ ...targets.surfaces[0], plane: 'tui', profile: 'web' }],
    }), /TUI target cannot use the reserved web profile/)
  })

  it('preserves a valid ledger through parsing during reconciliation', () => {
    const plan = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    const merged = mergeDshSurfaceLedger({
      ledger: emptyDshSurfaceLedger(),
      expected: plan.matrix.include,
      reports: plan.matrix.include.map(expected => compatibleReport(expected)),
    })
    const ledger: DshSurfaceLedger = merged.ledger
    assert.equal(ledger.entries.length, 2)
    assert.equal(ledger.entries.every(entry => entry.result === 'compatible'), true)
  })
})
