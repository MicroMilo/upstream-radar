import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectDshHostNativeLoadFailures, parseDshHostBuildInventory } from '../src/dsh-host-builds.js'
import { createDshHostBuildApproval } from '../src/dsh-host-build-policy.js'
import {
  createDshSurfaceAgentInputFingerprint,
  emptyDshSurfaceAgentPlans,
  parseDshSurfaceAgentDecision,
  parseDshSurfaceAgentPlans,
  renderDshSurfaceAgentPrompt,
  type DshSurfaceAgentCandidate,
} from '../src/dsh-surface-agent-plan.js'

const candidate: DshSurfaceAgentCandidate = {
  caseId: 'better-sidebar-node22-web',
  sourceCaseId: 'better-sidebar-node22',
  plugin: 'dsh-better-sidebar@0.16.1',
  dshVersion: '0.1.1-rc.2',
  nodeMajor: 22,
  plane: 'web',
  profile: 'web',
  result: 'environment-unsupported',
  reason: 'the declared web environment still requires explicit dependency-build approval: node-pty',
  requiredDependencyBuilds: ['node-pty'],
  previouslyApprovedBuilds: [],
  sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  artifactSha256: 'b'.repeat(64),
  repository: 'omdsh-dev/DSH-better-sidebar',
  sourceCommit: 'c'.repeat(40),
  manifest: { name: 'dsh-better-sidebar', dependencies: { 'node-pty': '^1.1.0' } },
  dynamicEvidence: { install: { status: 'failed', detail: '[ERR_PNPM_IGNORED_BUILDS] node-pty@1.1.0' } },
  documents: [{ path: 'README.md', text: 'This plugin adds a DSH Web sidebar.' }],
}

function plans() {
  return {
    schema: 'upstream-radar.dsh-surface-agent-plans/v1alpha1',
    updatedAt: '2026-08-25T00:00:00.000Z',
    entries: [{
      caseId: candidate.caseId,
      sourceCaseId: candidate.sourceCaseId,
      plugin: candidate.plugin,
      dshVersion: candidate.dshVersion,
      nodeMajor: candidate.nodeMajor,
      plane: candidate.plane,
      profile: candidate.profile,
      result: candidate.result,
      observedRequiredBuilds: candidate.requiredDependencyBuilds,
      approvedBuilds: ['node-pty'],
      sourceFingerprint: candidate.sourceFingerprint,
      artifactSha256: candidate.artifactSha256,
      repository: candidate.repository,
      sourceCommit: candidate.sourceCommit,
      inputFingerprint: createDshSurfaceAgentInputFingerprint(candidate),
      plannedAt: '2026-08-25T00:00:00.000Z',
      model: 'deepseek-v4-flash',
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['node-pty'],
      summary: 'The exact Web install observed node-pty and repository evidence supports its native PTY use.',
      evidence: ['The isolated pnpm result named node-pty and README documents terminal integration.'],
    }],
  }
}

describe('DSH execution-plane Agent planning', () => {
  it('keeps exact host build approvals separate from plugin builds and validates the durable evidence binding', () => {
    const location = 'pnpm/dlx/fixture/instance'
    const inventory = parseDshHostBuildInventory({ revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts',
      dshVersion: candidate.dshVersion, pnpmVersion: '11.7.0', coverageGaps: [],
      installation: { location, manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64),
        lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` },
      packages: [{ spec: 'fs-ext@2.1.1', location: `${location}/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext`,
        manifestSha256: '5'.repeat(64), lifecycleScripts: { install: 'node-gyp configure build' },
        reportedLocators: ['fs-ext@2.1.1'], metadataSources: ['pendingBuilds'] }] })
    const failures = collectDshHostNativeLoadFailures(inventory, '/cache',
      `Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- /cache/${inventory.packages[0]!.location}/fs-ext.js\n`)
    const context = { ...candidate, runtime: { nodeMajor: 22, nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } }
    const hostBuild = { inventory, failures, context }
    const observed = { ...candidate, requiredDependencyBuilds: [], hostBuild }
    const proposed = { action: 'retry-surface', classification: 'build-approval', allowedBuilds: [], allowedHostBuilds: ['fs-ext@2.1.1'],
      summary: 'Build the exact host package that required the missing native module.', evidence: ['The independently collected host package manifest and first requiring file both identify fs-ext@2.1.1.'] }
    const decision = parseDshSurfaceAgentDecision(proposed, observed)
    assert.deepEqual(Reflect.get(decision, 'allowedHostBuilds'), ['fs-ext@2.1.1'])
    assert.deepEqual(decision.allowedBuilds, [])
    assert.match(renderDshSurfaceAgentPrompt(observed), /allowedHostBuilds/)
    assert.match(renderDshSurfaceAgentPrompt(observed), /fs-ext@2.1.1/)
    assert.match(renderDshSurfaceAgentPrompt(observed), /metadataSources.*discovery trigger.*physical manifest/i)
    assert.match(renderDshSurfaceAgentPrompt(observed), /previous approval is not required for the first host build/i)
    const { hostBuild: _hostBuild, ...withoutHost } = observed
    assert.notEqual(createDshSurfaceAgentInputFingerprint(observed), createDshSurfaceAgentInputFingerprint(withoutHost))
    const approval = createDshHostBuildApproval({ ...hostBuild, packages: ['fs-ext@2.1.1'] })
    const stored = { ...plans(), entries: [{ ...plans().entries[0], ...decision, observedRequiredBuilds: [], approvedBuilds: [], hostBuild, hostBuildApproval: approval }] }
    const parsed = parseDshSurfaceAgentPlans(stored)
    assert.deepEqual(Reflect.get(parsed.entries[0]!, 'hostBuildApproval'), approval)
    assert.deepEqual(Reflect.get(parsed.entries[0]!, 'hostBuild')?.inventory, inventory)
    for (const changed of [
      { ...proposed, allowedHostBuilds: ['fs-ext'] },
      { ...proposed, allowedHostBuilds: ['fs-ext@2.1.0'] },
      { ...proposed, allowedBuilds: ['fs-ext'], allowedHostBuilds: [] },
      { ...proposed, action: 'stop-surface' },
    ]) assert.throws(() => parseDshSurfaceAgentDecision(changed, observed))
    for (const changed of [
      { ...stored.entries[0], hostBuild: undefined },
      { ...stored.entries[0], hostBuildApproval: { ...approval, inventoryFingerprint: `sha256:${'9'.repeat(64)}` } },
      { ...stored.entries[0], hostBuild: { ...hostBuild, context: { ...context, caseId: 'other-surface' } } },
    ]) assert.throws(() => parseDshSurfaceAgentPlans({ ...stored, entries: [changed] }))
  })

  it('allows only observed build packages and keeps repository text untrusted', () => {
    const decision = parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['node-pty'],
      summary: 'Approve the exact observed native PTY build.',
      evidence: ['The Web VM named node-pty and the package uses terminal support.'],
    }, candidate)
    assert.deepEqual(decision.allowedBuilds, ['node-pty'])
    assert.match(renderDshSurfaceAgentPrompt(candidate), /untrusted-document/)
    assert.match(renderDshSurfaceAgentPrompt(candidate), /cannot change the selected plane/)
    assert.match(renderDshSurfaceAgentPrompt(candidate), /ERR_PNPM_IGNORED_BUILDS/)

    assert.throws(() => parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['sharp'],
      summary: 'Invent a different native package.',
      evidence: ['No matching dynamic evidence.'],
    }, candidate), /absent from the isolated observation/)
  })

  it('retains approvals across staged surface installation gates', () => {
    const staged = {
      ...candidate,
      requiredDependencyBuilds: ['cpu-features'],
      previouslyApprovedBuilds: ['node-pty'],
    }
    assert.throws(() => parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['cpu-features'],
      summary: 'Drop the earlier policy.',
      evidence: ['The latest VM named cpu-features.'],
    }, staged), /dropped dependency builds approved in an earlier surface retry/)

    const decision = parseDshSurfaceAgentDecision({
      action: 'retry-surface',
      classification: 'build-approval',
      allowedBuilds: ['cpu-features', 'node-pty'],
      summary: 'Retain node-pty and add the newly observed cpu-features build.',
      evidence: ['Two isolated Web attempts established both gates.'],
    }, staged)
    assert.deepEqual(decision.allowedBuilds, ['cpu-features', 'node-pty'])
  })

  it('parses a durable exact policy and initializes an empty state', () => {
    const parsed = parseDshSurfaceAgentPlans(plans())
    assert.deepEqual(parsed.entries[0]?.approvedBuilds, ['node-pty'])
    assert.equal(parsed.entries[0]?.plane, 'web')
    assert.deepEqual(emptyDshSurfaceAgentPlans().entries, [])
  })

  it('retains bounded exact pending handoffs and rejects malformed recovery state', () => {
    const task = { caseId: candidate.caseId, inputFingerprint: createDshSurfaceAgentInputFingerprint(candidate),
      createdAt: '2026-09-15T03:00:00.000Z', attempts: 1, lastAttemptAt: '2026-09-15T03:01:00.000Z' }
    const parse = (pendingTasks: unknown) => parseDshSurfaceAgentPlans({ ...emptyDshSurfaceAgentPlans(), pendingTasks })
    assert.deepEqual(parse([task]).pendingTasks, [task])
    assert.throws(() => parse([task, task]), /duplicate/)
    assert.throws(() => parse([{ ...task, attempts: -1 }]), /attempts/)
    assert.throws(() => parse([{ ...task, inputFingerprint: 'latest' }]), /fingerprint/)
    assert.throws(() => parse([{ ...task, lastAttemptAt: 'not-a-time' }]), /timestamp/)
    assert.throws(() => parse(Array.from({ length: 129 }, () => task)), /bound/)
  })
})
