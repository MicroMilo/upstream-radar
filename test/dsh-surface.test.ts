import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { DshCompatibilityLedger } from '../src/dsh-compatibility-ledger.js'
import { collectDshWebBootRoster } from '../src/dsh-web-contract.js'
import { bindDshWebPackageVersions } from '../src/dsh-web-package-provenance.js'
import { collectDshHostNativeLoadFailures, parseDshHostBuildInventory } from '../src/dsh-host-builds.js'
import { createDshHostBuildApproval } from '../src/dsh-host-build-policy.js'
import {
  DSH_SURFACE_EXECUTION_CONTRACT,
  DSH_SURFACE_OBSERVATION_SCHEMA,
  dshSurfaceProfileStrategy,
  evaluateDshTuiEvidence,
  evaluateDshWebEvidence,
  dshWebLaunchUrl,
  dshWebClientDeclared,
  evaluateDshWebObservationError,
  recordDshWebObservationError,
  type DshSurfaceObservationReport,
} from '../src/dsh-surface-observation.js'
import {
  buildDshSurfaceIR,
  buildDshSurfacePlan,
  emptyDshSurfaceLedger,
  hasDshWebClientCoverageGap,
  mergeDshSurfaceLedger,
  parseDshSurfaceTargets,
  type DshSurfaceExpectedCase,
  type DshSurfaceLedger,
} from '../src/dsh-surface.js'

const SOURCE_STATIC = `sha256:${'a'.repeat(64)}`
const SOURCE_CONTRACT = `sha256:${'b'.repeat(64)}`
const ARTIFACT_SHA = 'c'.repeat(64)

describe('plane-aware surface routing and freshness', () => {
  it('rejects a report that copies an arbitrary expected contract digest without implementing the current surface contract', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const arbitrary = `sha256:${'9'.repeat(64)}`
    const report = { ...compatibleReport(expected), contractFingerprint: arbitrary }
    const accepted = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(),
      expected: [{ ...expected, contractFingerprint: arbitrary }], reports: [report] })
    assert.equal(accepted.acceptedCaseIds.length, 0)
    assert.match(accepted.rejectedReports.join(' '), /contract/)
  })

  it('routes a reviewed host native build into the next exact surface attempt and invalidates it when startup requirements change', () => {
    const source = sourceLedger()
    const scheduled = buildDshSurfacePlan(targets, source, emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const base = compatibleReport(scheduled)
    const location = base.hostBuildInventory!.installation!.location
    const inventory = parseDshHostBuildInventory({ ...base.hostBuildInventory, packages: [{ spec: 'fs-ext@2.1.1',
      location: `${location}/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext`, manifestSha256: '5'.repeat(64),
      lifecycleScripts: { install: 'node-gyp configure build' }, reportedLocators: ['fs-ext@2.1.1'], metadataSources: ['pendingBuilds'] }] })
    const failures = collectDshHostNativeLoadFailures(inventory, '/cache',
      `Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- /cache/${inventory.packages[0]!.location}/fs-ext.js\n`)
    const context = { caseId: scheduled.id, plugin: scheduled.plugin, artifactSha256: scheduled.artifactSha256,
      sourceFingerprint: scheduled.sourceFingerprint, dshVersion: scheduled.dshVersion, plane: 'web' as const,
      profile: 'web', runtime: base.runtime, profileEnvironment: base.profileEnvironment ?? { pnpmVersion: '11.7.0', overrides: {} } }
    const approval = createDshHostBuildApproval({ inventory, failures, context, packages: ['fs-ext@2.1.1'] })
    const failed = { ...base, hostBuildInventory: inventory, hostBuildFailures: failures,
      stages: { ...base.stages, host: { status: 'failed' as const } },
      result: 'environment-unsupported' as const, reason: 'the installed DSH host could not load fs-ext' }
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [scheduled], reports: [failed] })
    assert.deepEqual(merged.rejectedReports, [])
    const plans = { schema: 'upstream-radar.dsh-surface-agent-plans/v1alpha1', updatedAt: '2026-08-25T00:01:00.000Z', entries: [{
      caseId: scheduled.id, sourceCaseId: scheduled.sourceCaseId, plugin: scheduled.plugin, dshVersion: scheduled.dshVersion,
      nodeMajor: scheduled.nodeMajor, plane: 'web', profile: 'web', result: 'environment-unsupported',
      observedRequiredBuilds: [], approvedBuilds: [], sourceFingerprint: scheduled.sourceFingerprint,
      artifactSha256: scheduled.artifactSha256, inputFingerprint: `sha256:${'9'.repeat(64)}`,
      plannedAt: '2026-08-25T00:01:00.000Z', model: 'fixture-model', action: 'retry-surface', classification: 'build-approval',
      allowedBuilds: [], allowedHostBuilds: ['fs-ext@2.1.1'], summary: 'Build the independently identified DSH host package.',
      evidence: ['The first require path and physical host manifest match.'], hostBuild: { inventory, failures, context }, hostBuildApproval: approval,
    }] }
    const plan = buildDshSurfacePlan(targets, source, merged.ledger, new Date('2026-08-25T00:02:00.000Z'), undefined, plans)
    const retry = plan.matrix.include.find(cell => cell.id === scheduled.id)!
    assert.deepEqual(retry.hostBuildApproval, approval)
    assert.equal(retry.allowedBuilds, '')
    assert.notEqual(retry.contractFingerprint, scheduled.contractFingerprint)
    assert.deepEqual(retry.reasons, ['surface-contract-changed'])
    const changedTargets = { ...targets, surfaces: targets.surfaces.map(target => target.id === scheduled.id
      ? { ...target, startupConfiguration: { scope: 'Web bridge disabled', environment: { DSH_LARK_DISABLED: '1' } } }
      : target) }
    const changed = buildDshSurfacePlan(changedTargets, source, merged.ledger, new Date('2026-08-25T00:02:00.000Z'), undefined, plans)
    assert.equal(changed.matrix.include.find(cell => cell.id === scheduled.id)?.hostBuildApproval, undefined)
  })

  it('accepts a scoped host rebuild only when it was requested and its binding survives report ingestion', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const base = compatibleReport(expected)
    const location = base.hostBuildInventory!.installation!.location
    const inventory = parseDshHostBuildInventory({ ...base.hostBuildInventory, packages: [{ spec: 'fs-ext@2.1.1',
      location: `${location}/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext`, manifestSha256: '5'.repeat(64),
      lifecycleScripts: { install: 'node-gyp configure build' }, reportedLocators: ['fs-ext@2.1.1'], metadataSources: ['pendingBuilds'] }] })
    const failures = collectDshHostNativeLoadFailures(inventory, '/cache',
      `Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- /cache/${inventory.packages[0]!.location}/fs-ext.js\n`)
    const approval = createDshHostBuildApproval({ inventory, failures, packages: ['fs-ext@2.1.1'],
      context: { ...base, artifactSha256: expected.artifactSha256 } })
    const previous = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [{ ...base,
      hostBuildInventory: inventory, hostBuildFailures: failures, result: 'environment-unsupported',
      reason: 'the exact DSH host could not load fs-ext', stages: { ...base.stages, host: { status: 'failed' } } }] })
    assert.deepEqual(previous.rejectedReports, [])
    const plans = { schema: 'upstream-radar.dsh-surface-agent-plans/v1alpha1', updatedAt: '2026-08-25T00:01:00.000Z', entries: [{
      caseId: expected.id, sourceCaseId: expected.sourceCaseId, plugin: expected.plugin, dshVersion: expected.dshVersion,
      nodeMajor: expected.nodeMajor, plane: expected.plane, profile: expected.profile, result: 'environment-unsupported',
      observedRequiredBuilds: [], approvedBuilds: [], sourceFingerprint: expected.sourceFingerprint, artifactSha256: expected.artifactSha256,
      inputFingerprint: `sha256:${'9'.repeat(64)}`, plannedAt: '2026-08-25T00:01:00.000Z', model: 'fixture-model',
      action: 'retry-surface', classification: 'build-approval', allowedBuilds: [], allowedHostBuilds: ['fs-ext@2.1.1'],
      summary: 'Review exact host native-load failure.', evidence: ['The physical host manifest and requiring file match.'],
      hostBuild: { inventory, failures, context: { caseId: expected.id, plugin: expected.plugin, artifactSha256: expected.artifactSha256,
        sourceFingerprint: expected.sourceFingerprint, dshVersion: expected.dshVersion, plane: expected.plane, profile: expected.profile,
        runtime: base.runtime, profileEnvironment: base.profileEnvironment } }, hostBuildApproval: approval,
    }] }
    const requested = buildDshSurfacePlan(targets, sourceLedger(), previous.ledger, new Date('2026-08-25T00:02:00.000Z'), undefined, plans)
      .matrix.include.find(cell => cell.id === expected.id)!
    assert.deepEqual(requested.hostBuildApproval, approval)
    const execution = { revision: 'dsh-host-build-execution/1', requestedApproval: approval, status: 'command-completed', bindingVerified: true,
      reason: 'fixture exact rebuild command completed; Web is observed separately', command: { args: ['rebuild', 'fs-ext@2.1.1'], code: 0, signal: null,
        timedOut: false, outputExceeded: false, output: 'fixture completed', outputSha256: createHash('sha256').update('fixture completed').digest('hex') } }
    const report = { ...compatibleReport(requested), hostBuildInventory: inventory, hostBuildExecution: execution,
      boundary: { ...base.boundary, requestedHostBuildApproval: approval } }
    const merge = (value: unknown, cell = requested) => mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [cell], reports: [value] })
    const accepted = merge(report)
    assert.deepEqual(accepted.rejectedReports, [])
    assert.deepEqual(Reflect.get(accepted.ledger.entries[0]!, 'hostBuildExecution'), execution)
    assert.deepEqual(Reflect.get(buildDshSurfaceIR(accepted.ledger).cells[0]!.observation, 'hostBuildExecution'), execution)
    assert.equal(mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] }).acceptedCaseIds.length, 0)
    for (const changed of [
      { ...report, boundary: base.boundary },
      { ...report, hostBuildExecution: undefined },
      { ...report, hostBuildExecution: { ...execution, status: 'failed', bindingVerified: false } },
      { ...report, hostBuildExecution: { ...execution, command: { ...execution.command, output: 'changed evidence' } } },
    ]) assert.equal(merge(changed).acceptedCaseIds.length, 0)
  })

  it('preserves bounded DSH host build facts through report, ledger and IR without approving plugin builds', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const location = 'pnpm/dlx/exact-key/exact-instance'
    const hostBuildInventory = { revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts', dshVersion: expected.dshVersion,
      pnpmVersion: '11.7.0', installation: { location, manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64),
        lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` },
      packages: [{ spec: 'fs-ext@2.1.1', location: `${location}/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext`,
        manifestSha256: '5'.repeat(64), lifecycleScripts: { install: 'node-gyp configure build' },
        reportedLocators: ['fs-ext@2.1.1'], metadataSources: ['pendingBuilds'] }], coverageGaps: [] }
    const report = { ...compatibleReport(expected), hostBuildInventory }
    const merge = (value: unknown) => mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [value] })
    const result = merge(report)
    assert.deepEqual(result.rejectedReports, [])
    assert.deepEqual(Reflect.get(result.ledger.entries[0]!, 'hostBuildInventory'), hostBuildInventory)
    assert.deepEqual(Reflect.get(buildDshSurfaceIR(result.ledger).cells[0]!.observation, 'hostBuildInventory'), hostBuildInventory)
    assert.equal(result.ledger.entries[0]!.approvedDependencyBuilds, undefined)
    assert.equal(result.ledger.entries[0]!.requiredDependencyBuilds, undefined)
    for (const changed of [
      { ...hostBuildInventory, dshVersion: '0.0.1' },
      { ...hostBuildInventory, pnpmVersion: '11.6.0' },
      { ...hostBuildInventory, packages: [{ ...hostBuildInventory.packages[0], location: '../escape' }] },
      { ...hostBuildInventory, coverageGaps: ['metadata is incomplete'] },
    ]) assert.equal(merge({ ...report, hostBuildInventory: changed }).acceptedCaseIds.length, 0)
    const incomplete = merge({ ...report, result: 'unknown', reason: 'host build inventory incomplete',
      hostBuildInventory: { ...hostBuildInventory, coverageGaps: ['metadata is incomplete'] } })
    assert.deepEqual(incomplete.rejectedReports, [])
    assert.deepEqual(Reflect.get(incomplete.ledger.entries[0]!, 'hostBuildInventory'), { ...hostBuildInventory, coverageGaps: ['metadata is incomplete'] })
    const hostBuildFailures = [{ scope: 'dsh-host-native-load-failure', packageSpec: 'fs-ext@2.1.1', manifestSha256: '5'.repeat(64),
      missingModule: './build/Release/fs_ext.node', requiringFile: `${hostBuildInventory.packages[0]!.location}/fs-ext.js`, outputSha256: '6'.repeat(64) }]
    const failedReport = { ...report, result: 'environment-unsupported', reason: 'the host reported an unbuilt native module',
      stages: { ...report.stages, host: { status: 'failed', code: 1 } }, hostBuildFailures }
    const failed = merge(failedReport)
    assert.deepEqual(failed.rejectedReports, [])
    assert.deepEqual(Reflect.get(failed.ledger.entries[0]!, 'hostBuildFailures'), hostBuildFailures)
    assert.deepEqual(Reflect.get(buildDshSurfaceIR(failed.ledger).cells[0]!.observation, 'hostBuildFailures'), hostBuildFailures)
    assert.equal(failed.ledger.entries[0]!.requiredDependencyBuilds, undefined, 'host builds are not plugin-profile builds')
    for (const changed of [
      { ...failedReport, result: 'compatible' },
      { ...failedReport, hostBuildInventory: undefined },
      { ...failedReport, hostBuildFailures: [{ ...hostBuildFailures[0], packageSpec: 'invented@1.0.0' }] },
    ]) assert.equal(merge(changed).acceptedCaseIds.length, 0)
  })

  it('requires the current host inventory collector attempt and rejects pre-collector evidence reuse', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const report = compatibleReport(expected)
    Reflect.deleteProperty(report, 'hostBuildInventory')
    const result = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.equal(result.acceptedCaseIds.length, 0)
    assert.match(result.rejectedReports.join(' '), /host build inventory/)
    const legacy = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected],
      reports: [{ ...compatibleReport(expected), executionContract: 'dsh-surface/v1alpha14' }] })
    assert.equal(legacy.acceptedCaseIds.length, 0)
  })

  it('keeps a disabled startup comparison separate from default startup across planning, reports and unchanged reuse', () => {
    const base = targets.surfaces.find(target => target.plane === 'web')!
    const startupConfiguration = { scope: 'Web settings only; bridge stopped', environment: { DSH_LARK_DISABLED: '1' } }
    const configured = { ...targets, surfaces: [base, { ...base, id: `${base.id}-disabled`, startupConfiguration }] }
    const plan = buildDshSurfacePlan(configured, sourceLedger(), emptyDshSurfaceLedger())
    assert.equal(plan.matrix.include.length, 2)
    const normal = plan.matrix.include.find(cell => cell.id === base.id)!
    const disabled = plan.matrix.include.find(cell => cell.id !== base.id)!
    assert.notEqual(normal.contractFingerprint, disabled.contractFingerprint)
    assert.deepEqual(Reflect.get(disabled, 'startupConfiguration'), startupConfiguration)
    const missing = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [disabled], reports: [compatibleReport(disabled)] })
    assert.equal(missing.acceptedCaseIds.length, 0)
    assert.match(missing.rejectedReports.join(' '), /startup/)
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: plan.matrix.include,
      reports: [compatibleReport(normal), { ...compatibleReport(disabled), startupConfiguration }] })
    assert.deepEqual(merged.rejectedReports, [])
    assert.equal(merged.ledger.entries.length, 2)
    assert.deepEqual(Reflect.get(merged.ledger.entries.find(entry => entry.caseId === disabled.id)!, 'startupConfiguration'), startupConfiguration)
    assert.deepEqual(Reflect.get(buildDshSurfaceIR(merged.ledger).cells.find(cell => cell.id === disabled.id)!, 'startupConfiguration'), startupConfiguration)
    assert.equal(buildDshSurfacePlan(configured, sourceLedger(), merged.ledger, new Date(merged.ledger.entries[0]!.observedAt)).matrix.include.length, 0)
  })

  it('keeps an unsupported author profile out of execution without blocking other profiles', () => {
    const configured = { ...targets, surfaces: targets.surfaces.map((target, index) => ({ ...target,
      ...(index === 0 ? { environmentGap: 'yarn profile runner is unsupported' } : {}),
    })) }
    const plan = buildDshSurfacePlan(configured, sourceLedger(), emptyDshSurfaceLedger())
    assert.ok(!plan.matrix.include.some(cell => cell.id === configured.surfaces[0]!.id))
    assert.match(plan.blocked.find(cell => cell.id === configured.surfaces[0]!.id)?.reason ?? '', /yarn.*unsupported/)
    assert.equal(plan.matrix.include.length, configured.surfaces.length - 1)
  })

  it('carries the planned profile environment into a surface and verifies its observed settings', () => {
    const profileEnvironment = { pnpmVersion: '10.33.0', overrides: { 'host-api': '1.0.0' } }
    const source = sourceLedger({ profileEnvironment, runtime: { nodeMajor: 22, nodeVersion: '22.23.2',
      platform: 'linux', architecture: 'x64', pnpmVersion: '10.33.0' } })
    const expected = buildDshSurfacePlan(targets, source, emptyDshSurfaceLedger()).matrix.include[0]!
    assert.deepEqual(Reflect.get(expected, 'profileEnvironment'), profileEnvironment)
    const explicit = buildDshSurfacePlan({ ...targets, surfaces: targets.surfaces.map(target => ({ ...target, profileEnvironment })) }, sourceLedger(), emptyDshSurfaceLedger())
    assert.deepEqual(Reflect.get(explicit.matrix.include[0]!, 'profileEnvironment'), profileEnvironment)
    const baseline = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include[0]!
    assert.notEqual(expected.contractFingerprint, baseline.contractFingerprint)
    const observed = { ...compatibleReport(expected), profileEnvironment,
      runtime: { ...compatibleReport(expected).runtime, pnpmVersion: '10.33.0' } }
    const merge = (report: unknown) => mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    const result = merge(observed)
    assert.deepEqual(result.rejectedReports, [])
    assert.deepEqual(Reflect.get(result.ledger.entries[0]!, 'profileEnvironment'), profileEnvironment)
    assert.deepEqual(merge({ ...observed, profileEnvironment: { ...profileEnvironment, overrides: {} } }).acceptedCaseIds, [])
  })

  it('routes a React-only gap from exact client metadata, not a DSH package-name prefix', () => {
    const source = sourceLedger({ result: 'unknown', artifact: { sha256: ARTIFACT_SHA, lifecycleScripts: [],
      client: { platform: 'web', inject: [], entryPoints: ['lib/client.js'] } }, resolution: { runtimeGraph: {
        digest: SOURCE_STATIC, nodes: 1, edges: 1, unresolved: 1,
        unresolvedDependencies: [{ from: 'plugin', name: 'react', spec: '^18.2.0', kind: 'peer' }] } } }).entries[0]!
    assert.equal(hasDshWebClientCoverageGap(source), true)
  })

  it('rejects a legacy surface report stamped with the new execution fingerprint', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include[0]!
    const report = compatibleReport(expected)
    delete (report as unknown as Record<string, unknown>).executionContract
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.equal(merged.acceptedCaseIds.length, 0)
    assert.match(merged.rejectedReports.join(' '), /execution contract/)
    const preRebuild = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected],
      reports: [{ ...compatibleReport(expected), executionContract: 'dsh-surface/v1alpha8' }] })
    assert.equal(preRebuild.acceptedCaseIds.length, 0, 'pre-rebuild attribution is historical evidence only')
    const preReadiness = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected],
      reports: [{ ...compatibleReport(expected), executionContract: 'dsh-surface/v1alpha13' }] })
    assert.equal(preReadiness.acceptedCaseIds.length, 0, 'pre-readiness reports cannot satisfy the corrected host observation contract')
  })

  it('requires independent browser roster and bundle evidence for a new green Web report', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const report = compatibleReport(expected)
    if (report.evidence.plane === 'web') delete report.evidence.clientContract
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.equal(merged.acceptedCaseIds.length, 0)
    assert.match(merged.rejectedReports.join(' '), /browser contract/)
  })

  it('requires the independent package collection attempt for a current Web result, even when its versions remain unknown', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const report = compatibleReport(expected)
    if (report.evidence.plane === 'web') delete report.evidence.clientContract!.packageVersions
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.equal(merged.acceptedCaseIds.length, 0)
    assert.match(merged.rejectedReports.join(' '), /package provenance/)
  })
})

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

describe('surface runtime identity binding', () => {
  it('accepts only the locally generated DSH login URL for the expected origin', () => {
    const origin = 'http://127.0.0.1:30880/'
    assert.equal(dshWebLaunchUrl('dsh web: http://127.0.0.1:30880/?token=ephemeral-test-token', origin), origin + '?token=ephemeral-test-token')
    for (const value of ['http://attacker.example/?token=x', 'http://127.0.0.1:30881/?token=x',
      'http://127.0.0.1:30880/path?token=x', 'http://user:secret@127.0.0.1:30880/?token=x',
      'http://127.0.0.1:30880/?token=x&redirect=http://attacker.example']) {
      assert.equal(dshWebLaunchUrl('dsh web: ' + value, origin), origin)
    }
    assert.equal(dshWebLaunchUrl('older DSH without a token', origin), origin)
  })

  it('keeps an unestablished local Web login as incomplete setup, not plugin failure', () => {
    const result = evaluateDshWebEvidence({ driverAvailable: true, hostStarted: true, httpStatus: 401,
      rootMounted: false, bootManifestPresent: false, pluginEntryPresent: false, applicationMounted: false,
      pluginMaterialized: false, consoleErrors: [], pageErrors: [], failedRequests: [] })
    assert.equal(result.result, 'unknown')
    assert.equal(result.failedStage, 'host')
  })
  it('includes the actual source architecture in the planned contract', () => {
    const x64 = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include[0]!
    const arm64 = buildDshSurfacePlan(targets, sourceLedger({ runtime: {
      nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0',
    } }), emptyDshSurfaceLedger()).matrix.include[0]!
    assert.equal(arm64.architecture, 'arm64')
    assert.equal(arm64.platform, 'linux')
    assert.notEqual(arm64.contractFingerprint, x64.contractFingerprint)
  })

  it('rejects a report from another architecture or package-manager version', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include[0]!
    for (const runtime of [{ architecture: 'arm64' }, { platform: 'darwin' }, { pnpmVersion: '11.8.0' }]) {
      const report = compatibleReport(expected)
      Object.assign(report.runtime, runtime)
      const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
      assert.equal(merged.acceptedCaseIds.length, 0)
      assert.equal(merged.rejectedReports.length, 1)
    }
  })

  it('does not silently turn an unsupported source runtime into Linux/x64', () => {
    for (const runtime of [{ platform: 'darwin', architecture: 'arm64' }, { platform: 'linux', architecture: 'ppc64' }]) {
      const source = sourceLedger()
      Object.assign(source.entries[0]!.runtime, runtime)
      const plan = buildDshSurfacePlan(targets, source, emptyDshSurfaceLedger())
      assert.equal(plan.run, false)
      assert.equal(plan.blocked.length, targets.surfaces.length)
      assert.ok(plan.blocked.every(x => /unsupported.*runtime/.test(x.reason)))
    }
  })

  it('retains the independently collected surface graph digest and rejects malformed graph evidence', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include[0]!
    const report = compatibleReport(expected)
    report.resolution!.runtimeGraph!.digest = `sha256:${'f'.repeat(64)}`
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.equal(merged.ledger.entries[0]?.resolution?.runtimeGraph?.digest, report.resolution!.runtimeGraph!.digest)
    report.resolution!.runtimeGraph!.digest = 'not-an-exact-graph'
    assert.equal(mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] }).rejectedReports.length, 1)
  })

  it('rejects compatible surface conclusions without an independently bound exact host graph', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include[0]!
    for (const failure of ['missing', 'wrong-host']) {
      const report = compatibleReport(expected)
      if (failure === 'missing') delete report.resolution
      else report.resolution!.runtimeGraph!.hostRuntime!.dshVersion = '0.1.0-rc.8'
      const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
      assert.equal(merged.acceptedCaseIds.length, 0)
      assert.match(merged.rejectedReports[0] ?? '', /independent.*graph|exact.*host/)
    }
  })
})

function compatibleReport(expected: DshSurfaceExpectedCase, plane: 'web' | 'tui' = expected.plane): DshSurfaceObservationReport {
  const common = {
    schema: DSH_SURFACE_OBSERVATION_SCHEMA,
    tool: { name: 'upstream-radar' as const, version: '0.44.0' },
    probe: 'dsh-surface' as const,
    scope: 'surface-runtime-behavior' as const,
    executionContract: DSH_SURFACE_EXECUTION_CONTRACT,
    profileEnvironment: expected.profileEnvironment ?? { pnpmVersion: '11.7.0', overrides: {} },
    startedAt: '2026-08-25T00:00:00.000Z',
    completedAt: '2026-08-25T00:01:00.000Z',
    caseId: expected.id,
    sourceCaseId: expected.sourceCaseId,
    sourceFingerprint: expected.sourceFingerprint,
    contractFingerprint: expected.contractFingerprint,
    plugin: expected.plugin,
    dshVersion: expected.dshVersion,
    hostBuildInventory: { revision: 'dsh-host-build-inventory/1' as const, scope: 'dsh-host-build-facts' as const,
      dshVersion: expected.dshVersion, pnpmVersion: expected.profileEnvironment?.pnpmVersion ?? '11.7.0', packages: [], coverageGaps: [],
      installation: { location: 'pnpm/dlx/fixture/instance', manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64),
        lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` } },
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
    resolution: { runtimeGraph: {
      digest: `sha256:${'e'.repeat(64)}`, nodes: 2, edges: 1, unresolved: 0,
      hostRuntime: { source: 'dsh-process' as const, resolvedNodes: 1, dshVersion: expected.dshVersion },
    } },
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
          pluginClientDeclared: true,
          clientContract: { revision: 'dsh-web-client-contract/2', peerVersions: 'not-observed',
            client: { platform: 'web', inject: [], entryPoints: ['lib/client.js'] },
            boot: collectDshWebBootRoster({ entries: [{ id: expected.runtimeId, url: '/plugin.js', rev: 'fixture' }] }),
            packageVersions: bindDshWebPackageVersions(collectDshWebBootRoster({ entries: [{ id: expected.runtimeId, url: '/plugin.js', rev: 'fixture' }] }),
              [{ id: expected.runtimeId, url: '/plugin.js', status: 200, sha256: 'a'.repeat(64), bytes: 1024 }], { artifacts: [], gaps: [] }),
            pluginBundle: { sha256: 'a'.repeat(64), bytes: 1024 } },
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
  it('records a silent HTTP startup failure as reusable unknown evidence instead of producing an invalid empty stage detail', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    for (const output of ['', '  \n\t']) {
      const report: DshSurfaceObservationReport = compatibleReport(expected)
      assert.equal(report.evidence.plane, 'web')
      if (report.evidence.plane !== 'web') throw new Error('Expected Web fixture')
      report.evidence.httpStatus = 404
      const evaluation = recordDshWebObservationError(report, 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE',
        { exited: false, code: null, output })
      report.result = evaluation.result
      report.reason = evaluation.reason
      assert.equal(report.result, 'unknown')
      assert.equal(report.stages.host.status, 'failed')
      assert.equal(report.stages.surface.status, 'skipped')
      assert.match(report.stages.host.detail ?? '', /HTTP 404.*incomplete/)
      const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
      assert.deepEqual(merged.rejectedReports, [])
      assert.deepEqual(merged.acceptedCaseIds, [expected.id])
      const next = buildDshSurfacePlan({ ...targets, surfaces: targets.surfaces.filter(surface => surface.id === expected.id) },
        sourceLedger(), merged.ledger, new Date(report.completedAt))
      assert.equal(next.matrix.include.length, 0, 'unchanged unknown evidence must not require another container just to obtain a nonempty log')
      const invalid = structuredClone(report)
      invalid.stages.host.detail = ''
      assert.equal(mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [invalid] }).acceptedCaseIds.length, 0,
        'the incoming-report validator stays strict')
    }
  })

  it('records bounded browser-driver failures as valid unknown evidence even when the driver returns a long error', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    const report: DshSurfaceObservationReport = compatibleReport(expected)
    const evaluation = recordDshWebObservationError(report, `page.goto failed: ${'diagnostic '.repeat(512)}`,
      { exited: false, code: null, output: '' })
    report.result = evaluation.result
    report.reason = evaluation.reason
    assert.equal(report.result, 'unknown')
    assert.equal(report.stages.host.status, 'passed')
    assert.equal(report.stages.surface.status, 'failed')
    assert.match(report.reason, /^the browser driver failed/)
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
    assert.deepEqual(merged.rejectedReports, [])
    assert.deepEqual(merged.acceptedCaseIds, [expected.id])
    assert.ok(report.reason.length <= 2_048)
    assert.equal(report.stages.surface.detail, report.reason)
  })

  it('preserves bounded redacted host diagnostics and an observed host exit when recording a Web error', () => {
    const expected = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger()).matrix.include.find(cell => cell.plane === 'web')!
    for (const output of ['', `dsh web: http://127.0.0.1:19845/?token=disposable_test_token\n${'host diagnostic '.repeat(256)}`]) {
      const report: DshSurfaceObservationReport = compatibleReport(expected)
      const evaluation = recordDshWebObservationError(report, 'page.goto failed', { exited: true, code: 1, output })
      report.result = evaluation.result
      report.reason = evaluation.reason
      assert.equal(report.result, 'surface-incompatible')
      assert.equal(report.stages.host.code, 1)
      assert.equal(report.stages.surface.status, 'skipped')
      assert.doesNotMatch(report.stages.host.detail ?? '', /disposable_test_token/)
      if (output === '') assert.match(report.stages.host.detail ?? '', /exited with 1/)
      else assert.match(report.stages.host.detail ?? '', /ephemeral-token-redacted.*\n.*host diagnostic/)
      const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: [expected], reports: [report] })
      assert.deepEqual(merged.rejectedReports, [])
      assert.deepEqual(merged.acceptedCaseIds, [expected.id])
    }
  })

  it('keeps an observed HTTP startup failure in the host stage without blaming the browser or confirming a plugin defect', () => {
    for (const status of [401, 403, 404, 500]) {
      const result = evaluateDshWebObservationError('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE', undefined, status)
      assert.equal(result.result, 'unknown')
      assert.equal(result.failedStage, 'host')
      assert.match(result.reason, new RegExp(`HTTP ${status}`))
      assert.doesNotMatch(result.reason, /browser driver failed/)
    }
    assert.equal(evaluateDshWebObservationError('page.goto failed', 1, 404).result, 'surface-incompatible')
    assert.equal(evaluateDshWebObservationError('page crashed', undefined, 200).failedStage, 'surface')
  })
  it('does not label an observed DSH process failure as a browser-driver error', () => {
    assert.equal(evaluateDshWebObservationError('page.goto failed', undefined).result, 'unknown')
    const exited = evaluateDshWebObservationError('page.goto failed', 1)
    assert.equal(exited.result, 'surface-incompatible')
    assert.equal(exited.failedStage, 'host')
    assert.match(exited.reason, /exited.*1/)
  })
  it('does not require a browser entry for a host-only plugin installed into Web', () => {
    assert.equal(dshWebClientDeclared({ bundle: { patch: './cordis.patch.yml' } }), false)
    assert.equal(dshWebClientDeclared({ client: { platform: 'web' } }), true)
    assert.throws(() => dshWebClientDeclared({ client: 'malformed' }), /client declaration/)
    const input = { driverAvailable: true, hostStarted: true, httpStatus: 200, rootMounted: true,
      bootManifestPresent: true, pluginEntryPresent: false, applicationMounted: true, pluginMaterialized: false,
      consoleErrors: [], pageErrors: [], failedRequests: [] }
    assert.equal(evaluateDshWebEvidence({ ...input, pluginClientDeclared: false }).result, 'compatible')
    assert.equal(evaluateDshWebEvidence({ ...input, pluginClientDeclared: true }).result, 'surface-incompatible')
  })
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

  it('keeps a browser bundle collection limit as incomplete coverage, not a plugin HTTP failure', () => {
    const result = evaluateDshWebEvidence({ driverAvailable: true, hostStarted: true, httpStatus: 200,
      rootMounted: true, bootManifestPresent: true, pluginEntryPresent: true, pluginBundleStatus: 200,
      pluginBundleCollectionError: 'bundle byte budget exceeded', applicationMounted: true,
      pluginMaterialized: true, consoleErrors: [], pageErrors: [], failedRequests: [] })
    assert.equal(result.result, 'unknown')
    assert.match(result.reason, /collection|coverage/)
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

  it('keeps the complete recommended surface set while scheduling it in bounded batches', () => {
    const manyTargets = Array.from({ length: 40 }, (_, index) => ({
      id: `plugin-${String(index).padStart(2, '0')}-web`,
      sourceCaseId: `plugin-${String(index).padStart(2, '0')}-node22`,
      plane: 'web',
      profile: 'web',
      runtimeId: `plugin-${String(index).padStart(2, '0')}`,
      reason: 'Repository recommendation declares a Web client.',
    }))
    const source = sourceLedger().entries[0] as DshCompatibilityLedger['entries'][number]
    const ledger: DshCompatibilityLedger = {
      schema: 'upstream-radar.dsh-compatibility-ledger/v1alpha1',
      entries: manyTargets.map((target, index) => ({
        ...source,
        caseId: target.sourceCaseId,
        targetId: target.runtimeId,
        plugin: `${target.runtimeId}@1.0.0`,
        artifact: { ...source.artifact, sha256: index.toString(16).padStart(64, '0') },
      })),
    }

    const plan = buildDshSurfacePlan({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1',
      refreshAfterHours: 168,
      surfaces: manyTargets,
    }, ledger, emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))

    assert.equal(plan.matrix.include.length, 32)
    assert.equal(plan.blocked.length, 8)
    assert.equal(plan.blocked.every(item => /bounded 32-cell run budget/.test(item.reason)), true)
  })

  it('automatically routes Web-client headless gaps without duplicating explicit targets or swallowing host-only cases', () => {
    const ledger = sourceLedger({
      ...webClientGapEntry('web-plugin-node22', 'web-plugin@1.2.3'),
      artifact: { lifecycleScripts: [], sha256: ARTIFACT_SHA },
    })
    ledger.entries.push(webClientGapEntry('auto-client-node22', 'auto-client@2.0.0'))
    ledger.entries.push({
      ...webClientGapEntry('mixed-client-node22', 'mixed-client@2.1.0'),
      artifact: { lifecycleScripts: [], sha256: '7'.repeat(64) },
      resolution: {
        runtimeGraph: {
          digest: `sha256:${'2'.repeat(64)}`,
          nodes: 10,
          edges: 9,
          unresolved: 1,
          unresolvedDependencies: [{
            from: 'node_modules/mixed-client',
            name: '@deepseek-ai/dsh-client-ui-primitives',
            spec: '^0.1.0-rc.8',
            kind: 'peer',
          }],
          pluginPeerContracts: {
            declared: 2,
            satisfied: 0,
            mismatched: 1,
            indeterminate: 0,
            missing: 1,
            relations: [{
              name: '@deepseek-ai/dsh-client-ui-primitives',
              required: '^0.1.0-rc.8',
              status: 'missing',
              staticUsage: 'runtime-import-observed',
            }, {
              name: 'react-dom',
              required: '^18.2.0',
              resolvedVersion: '19.2.8',
              status: 'mismatched',
              staticUsage: 'runtime-import-observed',
            }],
            issues: [{
              name: '@deepseek-ai/dsh-client-ui-primitives',
              required: '^0.1.0-rc.8',
              status: 'missing',
              staticUsage: 'runtime-import-observed',
            }, {
              name: 'react-dom',
              required: '^18.2.0',
              resolvedVersion: '19.2.8',
              status: 'mismatched',
              staticUsage: 'runtime-import-observed',
            }],
          },
        },
      },
    })
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
      'mixed-client-node22-web',
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
    assert.equal(plan.matrix.include.some(item => item.sourceCaseId === 'mixed-client-node22'), true)
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

  it('retains an exact dependency-build gate discovered only inside an execution plane', () => {
    const plan = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    const expected = plan.matrix.include.find(item => item.plane === 'web') as DshSurfaceExpectedCase
    const report = compatibleReport(expected)
    report.result = 'environment-unsupported'
    report.reason = 'the declared web environment still requires explicit dependency-build approval: node-pty'
    report.stages.install = { status: 'failed', code: 1, detail: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0' }
    ;(report.boundary as typeof report.boundary & { requiredDependencyBuilds: string[] }).requiredDependencyBuilds = ['node-pty']

    const merged = mergeDshSurfaceLedger({
      ledger: emptyDshSurfaceLedger(),
      expected: [expected],
      reports: [report],
    })

    assert.deepEqual(merged.ledger.entries[0]?.requiredDependencyBuilds, ['node-pty'])
  })

  it('retries only the exact execution-plane cell approved by the surface Agent', () => {
    const initial = buildDshSurfacePlan(targets, sourceLedger(), emptyDshSurfaceLedger(), new Date('2026-08-25T00:00:00.000Z'))
    const expected = initial.matrix.include.find(item => item.plane === 'web') as DshSurfaceExpectedCase
    const report = compatibleReport(expected)
    report.result = 'environment-unsupported'
    report.reason = 'the declared web environment still requires explicit dependency-build approval: node-pty'
    report.stages.install = { status: 'failed', code: 1, detail: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0' }
    ;(report.boundary as typeof report.boundary & { requiredDependencyBuilds: string[] }).requiredDependencyBuilds = ['node-pty']
    const merged = mergeDshSurfaceLedger({
      ledger: emptyDshSurfaceLedger(),
      expected: [expected],
      reports: [report],
    })
    const surfaceAgentPlans = {
      schema: 'upstream-radar.dsh-surface-agent-plans/v1alpha1',
      updatedAt: '2026-08-25T00:02:00.000Z',
      entries: [{
        caseId: expected.id,
        sourceCaseId: expected.sourceCaseId,
        plugin: expected.plugin,
        dshVersion: expected.dshVersion,
        nodeMajor: expected.nodeMajor,
        plane: expected.plane,
        profile: expected.profile,
        result: 'environment-unsupported',
        observedRequiredBuilds: ['node-pty'],
        approvedBuilds: ['node-pty'],
        sourceFingerprint: expected.sourceFingerprint,
        artifactSha256: expected.artifactSha256,
        inputFingerprint: `sha256:${'9'.repeat(64)}`,
        plannedAt: '2026-08-25T00:02:00.000Z',
        model: 'deepseek-v4-flash',
        action: 'retry-surface',
        classification: 'build-approval',
        allowedBuilds: ['node-pty'],
        summary: 'The exact plugin declares node-pty and the isolated Web install observed its build gate.',
        evidence: ['package.json declares node-pty and the Web VM observed only node-pty.'],
      }],
    }

    const retry = buildDshSurfacePlan(
      targets,
      sourceLedger(),
      merged.ledger,
      new Date('2026-08-25T00:03:00.000Z'),
      undefined,
      surfaceAgentPlans,
    )
    assert.equal(retry.matrix.include.find(item => item.id === expected.id)?.allowedBuilds, 'node-pty')
    assert.deepEqual(retry.matrix.include.find(item => item.id === expected.id)?.reasons, ['surface-contract-changed'])
    assert.equal(retry.matrix.include.find(item => item.plane === 'tui')?.allowedBuilds, '')

    const changedArtifact = buildDshSurfacePlan(
      targets,
      sourceLedger({ artifact: { lifecycleScripts: [], sha256: '8'.repeat(64) } }),
      emptyDshSurfaceLedger(),
      new Date('2026-08-25T00:03:00.000Z'),
      undefined,
      surfaceAgentPlans,
    )
    assert.equal(changedArtifact.matrix.include.find(item => item.id === expected.id)?.allowedBuilds, '')
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
