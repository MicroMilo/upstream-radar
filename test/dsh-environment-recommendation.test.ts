import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import type { DshAuthorEnvironment } from '../src/dsh-author-environment.js'
import { buildDshInstallPlan } from '../src/dsh-install-plan.js'
import {
  applyDshEnvironmentRecommendations,
  applyDshEnvironmentRecommendationsToSurfaceTargets,
  createDshEnvironmentRecommendationInputFingerprint,
  DSH_ENVIRONMENT_REVIEW_CONTRACT,
  emptyDshEnvironmentRecommendations,
  parseDshEnvironmentRecommendationDecision,
  parseDshEnvironmentRecommendations,
  renderDshEnvironmentRecommendationPrompt,
  selectDshEnvironmentRecommendationCandidates,
  type DshEnvironmentRecommendationCandidate,
} from '../src/dsh-environment-recommendation.js'

const execFile = promisify(execFileCallback)

const targets = {
  schema: 'upstream-radar.dsh-install-targets/v1alpha1',
  refreshAfterHours: 168,
  runtimeProfiles: [
    { id: 'node22', nodeMajor: 22 },
    { id: 'node24', nodeMajor: 24 },
  ],
  plugins: [{
    id: 'web-plugin',
    spec: 'web-plugin@1.2.2',
    observerTargetId: 'web-plugin-source',
    reason: 'exercise one repository-derived environment recommendation',
  }],
}

const observations = {
  targets: {
    'deepseek-harness': {
      source: {
        repository: 'deepseek-ai/deepseek-harness',
        commit: 'd'.repeat(40),
        packagePath: 'apps/cli/package.json',
      },
      manifest: {
        name: '@deepseek-ai/dsh',
        version: '0.1.5-rc.2',
        engines: { node: '>=18' },
      },
      package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', integrity: 'sha512-dsh' },
    },
    'web-plugin-source': {
      source: {
        repository: 'example/web-plugin',
        commit: 'a'.repeat(40),
        packagePath: 'packages/plugin/package.json',
      },
      manifest: {
        name: 'web-plugin',
        version: '1.2.3',
        engines: { node: '>=18' },
        exports: { '.': './lib/index.js', './client': './lib/client.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      },
      package: { name: 'web-plugin', version: '1.2.3', integrity: 'sha512-plugin' },
    },
  },
}

const documents = new Map([
  ['web-plugin', [
    { path: 'README.md', text: 'CI uses Node 22; development uses Node 24. Install this package into the DSH Web profile.' },
    { path: '.nvmrc', text: '24\n' },
  ]],
])

function candidate(): DshEnvironmentRecommendationCandidate {
  const selected = selectDshEnvironmentRecommendationCandidates(targets, observations, documents)
  assert.equal(selected.length, 1)
  return selected[0] as DshEnvironmentRecommendationCandidate
}

function decision() {
  return {
    status: 'recommended',
    preferredNodeMajor: 24,
    nodeMajors: [22, 24],
    executionProfiles: ['headless', 'web'],
    authorEnvironment: { packageManagers: [], overrides: [], workflows: [], dshVersions: [] } as DshAuthorEnvironment,
    summary: 'The package supports both configured runtimes, recommends Node 24 for development, and declares a Web client.',
    evidence: ['source-manifest', '.nvmrc', 'README.md'],
  }
}

function recommendations(overrides: Record<string, unknown> = {}) {
  const selected = candidate()
  return {
    schema: 'upstream-radar.dsh-environment-recommendations/v1alpha1',
    updatedAt: '2026-09-11T00:00:00.000Z',
    pendingTasks: [{
      targetId: selected.targetId,
      plugin: selected.plugin,
      dshVersion: selected.dshVersion,
      sourceFingerprint: selected.sourceFingerprint,
      inputFingerprint: createDshEnvironmentRecommendationInputFingerprint(selected),
      createdAt: '2026-09-11T00:00:00.000Z',
    }],
    entries: [{
      reviewContract: DSH_ENVIRONMENT_REVIEW_CONTRACT,
      targetId: selected.targetId,
      plugin: selected.plugin,
      dshVersion: selected.dshVersion,
      repository: selected.repository,
      sourceCommit: selected.sourceCommit,
      sourceFingerprint: selected.sourceFingerprint,
      inputFingerprint: createDshEnvironmentRecommendationInputFingerprint(selected),
      plannedAt: '2026-09-11T00:00:00.000Z',
      model: 'deepseek-chat',
      ...decision(),
      ...overrides,
    }],
  }
}

describe('DSH repository environment recommendation', () => {
  it('carries collector gaps into the reasoning input and deterministically preserves incomplete coverage', () => {
    const selected = candidate()
    const incomplete = { ...selected, collectionGaps: ['README_EN.md exceeds the per-file evidence byte budget.'] }
    const parsed = parseDshEnvironmentRecommendationDecision(decision(), incomplete)
    assert.match(parsed.coverageGaps?.join(' ') ?? '', /repository evidence collection is incomplete/i)
    assert.match(renderDshEnvironmentRecommendationPrompt(incomplete), /README_EN\.md exceeds/)
    assert.notEqual(createDshEnvironmentRecommendationInputFingerprint(selected), createDshEnvironmentRecommendationInputFingerprint(incomplete))
    assert.throws(() => parseDshEnvironmentRecommendationDecision(decision(), {
      ...selected, collectionGaps: Array.from({ length: 17 }, (_, index) => `omitted-${index}.md`),
    }), /collectionGaps/)
  })

  it('preserves bounded untested author workflows instead of turning smoke coverage into a full pass', () => {
    const coverageGaps = ['Author SDK default profile has not been exercised.']
    const parsed = parseDshEnvironmentRecommendationDecision({ ...decision(), coverageGaps }, candidate())
    assert.deepEqual(parsed.coverageGaps, coverageGaps)
    const applied = applyDshEnvironmentRecommendations(targets, observations, recommendations({ coverageGaps }))
    assert.deepEqual(applied.plugins[0]?.environmentRecommendation?.coverageGaps, coverageGaps)
    assert.match(renderDshEnvironmentRecommendationPrompt(candidate()), /SDK.*ACP/)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(), coverageGaps: [coverageGaps[0], coverageGaps[0]],
    }, candidate()), /coverageGaps.*unique/)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(), coverageGaps: ['x'.repeat(513)],
    }, candidate()), /coverageGaps/)
  })

  it('presents bounded repository evidence before execution and accepts an evidenced recommendation', () => {
    const selected = candidate()
    const parsed = parseDshEnvironmentRecommendationDecision(decision(), selected)

    assert.equal(parsed.preferredNodeMajor, 24)
    assert.deepEqual(parsed.nodeMajors, [22, 24])
    assert.deepEqual(parsed.executionProfiles, ['headless', 'web'])
    assert.match(renderDshEnvironmentRecommendationPrompt(selected), /before any plugin code executes/)
    assert.match(renderDshEnvironmentRecommendationPrompt(selected), /untrusted-document/)
    assert.match(renderDshEnvironmentRecommendationPrompt(selected), /source-manifest/)

    assert.throws(() => selectDshEnvironmentRecommendationCandidates(targets, observations, new Map([
      ['web-plugin', [{ path: '../README.md', text: 'escape' }]],
    ])), /clean repository-relative path/)
  })

  it('retains evidenced package managers, overrides and the author SDK workflow through planning', () => {
    const selected = candidate()
    selected.documents.push({ path: 'package.json', text: JSON.stringify({
      name: 'web-plugin', version: '1.2.3', packageManager: 'pnpm@10.33.0',
      pnpm: { overrides: { '@deepseek-ai/dsh-llm': '0.1.0-rc.8' } },
    }) })
    selected.documents.push({ path: 'docs/COMPATIBILITY.md', text:
      'The default adapter is sdk. Launch with --profile author-sdk. Verified DSH 0.1.0-rc.8.' })
    const authorEnvironment = {
      packageManagers: [{ name: 'pnpm', version: '10.33.0', scope: 'development',
        evidence: [{ path: 'package.json', quote: '"packageManager":"pnpm@10.33.0"' }] }],
      overrides: [{ scope: 'development', values: { '@deepseek-ai/dsh-llm': '0.1.0-rc.8' },
        evidence: [{ path: 'package.json', quote: '"overrides":{"@deepseek-ai/dsh-llm":"0.1.0-rc.8"}' }] }],
      workflows: [{ kind: 'sdk', profile: 'author-sdk', role: 'primary', evidence: [{
        path: 'docs/COMPATIBILITY.md', quote: 'The default adapter is sdk. Launch with --profile author-sdk.',
      }] }],
      dshVersions: [{ version: '0.1.0-rc.8', evidence: [{ path: 'docs/COMPATIBILITY.md', quote: 'Verified DSH 0.1.0-rc.8.' }] }],
    }
    const parsed = parseDshEnvironmentRecommendationDecision({ ...decision(), authorEnvironment }, selected)
    assert.deepEqual(Reflect.get(parsed, 'authorEnvironment'), authorEnvironment)
    const state = recommendations()
    state.entries[0] = { ...state.entries[0]!, ...parsed }
    const applied = applyDshEnvironmentRecommendations(targets, observations, state)
    assert.deepEqual(Reflect.get(applied.plugins[0]!.environmentRecommendation!, 'authorEnvironment'), authorEnvironment)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({ ...decision(), authorEnvironment: {
      ...authorEnvironment, packageManagers: [{ ...authorEnvironment.packageManagers[0], version: '11.7.0' }],
    } }, selected), /package manager.*evidence/i)
  })

  it('requires a current complete review instead of reusing a pre-rebuild recommendation', () => {
    const legacy = recommendations()
    Reflect.deleteProperty(legacy.entries[0]!, 'reviewContract')
    Reflect.deleteProperty(legacy.entries[0]!, 'authorEnvironment')
    assert.equal(parseDshEnvironmentRecommendations(legacy).entries.length, 1, 'historical reviews stay readable')
    const applied = applyDshEnvironmentRecommendations({ ...targets, environmentRecommendationsRequired: true }, observations, legacy)
    assert.equal(applied.plugins[0]!.environmentRecommendation, undefined, 'history is not current execution authority')
    const incomplete = decision()
    Reflect.deleteProperty(incomplete, 'authorEnvironment')
    assert.throws(() => parseDshEnvironmentRecommendationDecision(incomplete, candidate()), /authorEnvironment.*required/)
    assert.match(renderDshEnvironmentRecommendationPrompt(candidate()), /authorEnvironment/)
  })

  it('rejects executable override sources and mismatched key/value evidence', () => {
    const selected = candidate()
    const quote = '"overrides":{"peer-a":"1.0.0","peer-b":"2.0.0"}'
    selected.documents.push({ path: 'package.json', text: `{${quote}}` })
    for (const value of ['file:../outside', 'git+https://example.com/repo', '2.0.0']) {
      assert.throws(() => parseDshEnvironmentRecommendationDecision({ ...decision(), authorEnvironment: {
        ...decision().authorEnvironment,
        overrides: [{ scope: 'development', values: { 'peer-a': value }, evidence: [{ path: 'package.json', quote }] }],
      } }, selected), /override/)
    }
  })

  it('plans evidenced profile package managers and overrides without importing development settings', () => {
    const environment: DshAuthorEnvironment = {
      ...decision().authorEnvironment,
      packageManagers: [{ name: 'pnpm', version: '10.33.0', scope: 'profile',
        evidence: [{ path: 'README.md', quote: 'Use pnpm 10.33.0 for the profile.' }] }],
      overrides: [{ scope: 'profile', values: { 'host-api': '1.0.0' },
        evidence: [{ path: 'README.md', quote: 'overrides: {"host-api":"1.0.0"}' }] }],
    }
    const plan = (authorEnvironment: DshAuthorEnvironment) => buildDshInstallPlan(
      applyDshEnvironmentRecommendations(targets, observations, recommendations({ authorEnvironment })), observations, { changes: [] },
    )
    const profilePlan = plan(environment)
    assert.equal(profilePlan.blocked.length, 0)
    assert.deepEqual(Reflect.get(profilePlan.matrix.include[0]!, 'profileEnvironment'), {
      pnpmVersion: '10.33.0', overrides: { 'host-api': '1.0.0' },
    })
    const developmentPlan = plan({ ...environment,
      packageManagers: environment.packageManagers.map(item => ({ ...item, scope: 'development' })),
      overrides: environment.overrides.map(item => ({ ...item, scope: 'development' })),
    })
    assert.deepEqual(Reflect.get(developmentPlan.matrix.include[0]!, 'profileEnvironment'), { pnpmVersion: '11.7.0', overrides: {} })
    assert.notEqual(profilePlan.matrix.include[0]!.contractFingerprint, developmentPlan.matrix.include[0]!.contractFingerprint)
    const unsupported = plan({ ...environment, packageManagers: [{ ...environment.packageManagers[0]!, name: 'yarn' }] })
    assert.equal(unsupported.matrix.include.length, 0)
    assert.match(unsupported.blocked[0]?.reason ?? '', /yarn.*unsupported/)
  })

  it('applies a named Web profile requirement only to that profile', () => {
    const selected = candidate()
    selected.documents.push({ path: 'docs/setup.md', text: 'Use pnpm 10.33.0 with --profile web. overrides: {"host-api":"1.0.0"}' })
    const raw = { ...decision(), authorEnvironment: {
      ...decision().authorEnvironment,
      packageManagers: [{ name: 'pnpm', version: '10.33.0', scope: 'profile', profile: 'web',
        evidence: [{ path: 'docs/setup.md', quote: 'Use pnpm 10.33.0 with --profile web.' }] }],
      overrides: [{ scope: 'profile', profile: 'web', values: { 'host-api': '1.0.0' },
        evidence: [{ path: 'docs/setup.md', quote: 'Use pnpm 10.33.0 with --profile web. overrides: {"host-api":"1.0.0"}' }] }],
    } }
    const parsed = parseDshEnvironmentRecommendationDecision(raw, selected)
    const review = recommendations(parsed as unknown as Record<string, unknown>)
    const applied = applyDshEnvironmentRecommendations(targets, observations, review)
    const native = buildDshInstallPlan(applied, observations, { changes: [] })
    assert.deepEqual(native.matrix.include[0]!.profileEnvironment, { pnpmVersion: '11.7.0', overrides: {} })
    const surfaces = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [],
    }, targets, observations, review)
    assert.ok(surfaces.surfaces.length > 0)
    assert.ok(surfaces.surfaces.every(target => target.profileEnvironment?.pnpmVersion === '10.33.0'))
    assert.ok(surfaces.surfaces.every(target => target.profileEnvironment?.overrides['host-api'] === '1.0.0'))
    const unsupported = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1', surfaces: [],
    }, targets, observations, recommendations({ ...parsed, authorEnvironment: {
      ...parsed.authorEnvironment!, packageManagers: parsed.authorEnvironment!.packageManagers.map(item => ({ ...item, name: 'yarn' })),
    } }))
    assert.ok(unsupported.surfaces.every(target => /yarn.*unsupported/.test(String(Reflect.get(target, 'environmentGap')))))
    assert.ok(unsupported.surfaces.every(target => target.profileEnvironment === undefined))
  })

  it('keeps repository Node intent independent from configured runtimes and rejects engine conflicts', () => {
    const selected = candidate()
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      preferredNodeMajor: 16,
      nodeMajors: [16],
    }, selected), /violates the plugin's declared Node engine/)

    const node18Decision = parseDshEnvironmentRecommendationDecision({
      ...decision(),
      preferredNodeMajor: 18,
      nodeMajors: [18],
    }, selected)
    assert.deepEqual(node18Decision.nodeMajors, [18])

    const node24Only = {
      ...selected,
      manifest: { ...selected.manifest as object, engines: { node: '>=24.11.0' } },
      publishedManifest: undefined,
    }
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      preferredNodeMajor: 22,
      nodeMajors: [22],
    }, node24Only), /violates the plugin's declared Node engine/)

    const unevaluableEngine = {
      ...selected,
      manifest: { ...selected.manifest as object, engines: { node: '22 - 24' } },
    }
    assert.throws(() => parseDshEnvironmentRecommendationDecision(decision(), unevaluableEngine), /cannot be evaluated safely/)

    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      preferredNodeMajor: 24,
      nodeMajors: Array.from({ length: 17 }, (_, index) => index + 18),
    }, selected), /at most 16 Node.js majors/)
  })

  it('keeps declared support, CI testing and author recommendations distinguishable', () => {
    const selected = {
      ...candidate(),
      documents: [...candidate().documents, {
        path: '.github/workflows/check.yml', text: 'with:\n  node-version: 24\n',
      }],
    }
    const withBasis = {
      ...decision(), evidence: [...decision().evidence, '.github/workflows/check.yml'],
      nodeEvidence: [
        { nodeMajor: 22, kind: 'declared-support', evidence: ['README.md'] },
        { nodeMajor: 24, kind: 'ci-tested', evidence: ['.github/workflows/check.yml'] },
      ],
    }
    const parsed = parseDshEnvironmentRecommendationDecision(withBasis, selected)
    assert.deepEqual(parsed.nodeEvidence, withBasis.nodeEvidence)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...withBasis,
      nodeEvidence: [{ nodeMajor: 22, kind: 'ci-tested', evidence: ['source-manifest'] },
        withBasis.nodeEvidence[1]],
    }, selected), /CI evidence/)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...withBasis,
      nodeEvidence: [{ nodeMajor: 22, kind: 'author-recommended', evidence: ['README.md'] },
        withBasis.nodeEvidence[1]],
    }, selected), /explicit recommendation/)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...withBasis, nodeEvidence: [withBasis.nodeEvidence[1]],
    }, selected), /every selected Node major/)
  })

  it('uses the exact published manifest as the Node constraint when source is ahead', () => {
    const selected = candidate()
    const sourceAhead: DshEnvironmentRecommendationCandidate = {
      ...selected,
      manifest: {
        name: 'web-plugin',
        version: '1.3.0',
        engines: { node: '>=24.11.0' },
        dsh: { client: { platform: 'web' } },
      },
      publishedManifest: {
        name: 'web-plugin',
        version: '1.2.3',
        engines: { node: '>=22.19.0' },
        dsh: { client: { platform: 'web' } },
      },
    }
    const parsed = parseDshEnvironmentRecommendationDecision({
      ...decision(),
      preferredNodeMajor: 22,
      nodeMajors: [22],
      evidence: ['published-manifest', 'README.md'],
    }, sourceAhead)
    assert.deepEqual(parsed.nodeMajors, [22])
  })

  it('does not let reasoning omit a deterministically declared Web plane or cite absent evidence', () => {
    const selected = candidate()
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      executionProfiles: ['headless'],
    }, selected), /declares the Web execution profile/)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      evidence: ['hallucinated-file.md'],
    }, selected), /not present in the bounded repository evidence/)
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      command: 'npm install',
    }, selected), /unexpected keys: command/)

    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      executionProfiles: ['headless', 'web', 'tui'],
      evidence: ['published-manifest'],
    }, {
      ...selected,
      publishedManifest: {
        name: 'web-plugin',
        version: '1.2.3',
        engines: { node: '^22 || >=24' },
        dsh: { client: { platform: 'web' } },
      },
      documents: [],
    }), /TUI recommendation requires an explicit TUI\/terminal repository document/)

    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...decision(),
      preferredNodeMajor: 26,
      nodeMajors: [26],
    }, selected), /none of its cited evidence names that major/)
  })

  it('retains an author-declared TUI profile instead of inventing another name', () => {
    const selected: DshEnvironmentRecommendationCandidate = {
      ...candidate(),
      manifest: { name: 'web-plugin', version: '1.2.3', engines: { node: '>=18' } },
      documents: [{ path: 'README.md', text: 'TUI requires Node 24. Start with dsh --profile dsh-tui.' }],
    }
    const parsed = parseDshEnvironmentRecommendationDecision({
      ...decision(), nodeMajors: [24], executionProfiles: ['headless', 'tui'],
      tuiProfile: 'dsh-tui', evidence: ['README.md'],
    }, selected)
    assert.equal(parsed.tuiProfile, 'dsh-tui')
    assert.throws(() => parseDshEnvironmentRecommendationDecision({
      ...parsed, tuiProfile: 'unmentioned-tui',
    }, selected), /TUI profile.*cited/)
    const state = { ...observations, targets: {
      ...observations.targets,
      'web-plugin-source': { ...observations.targets['web-plugin-source'], manifest: selected.manifest },
    } }
    const c = selectDshEnvironmentRecommendationCandidates(targets, state, new Map([['web-plugin', selected.documents]]))[0]!
    const rs = recommendations({ ...parsed, sourceFingerprint: c.sourceFingerprint,
      inputFingerprint: createDshEnvironmentRecommendationInputFingerprint(c) })
    const surfaceTargets = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1', refreshAfterHours: 168, surfaces: [],
    }, targets, state, rs)
    assert.equal(surfaceTargets.surfaces[0]?.profile, 'dsh-tui')
  })

  it('overlays the exact recommendation onto Node and execution-profile planners', () => {
    const installTargets = applyDshEnvironmentRecommendations(targets, observations, recommendations())
    assert.deepEqual(installTargets.plugins[0]?.runtimeProfiles, ['node22', 'node24'])
    assert.deepEqual(installTargets.plugins[0]?.environmentRecommendation?.nodeMajors, [22, 24])
    assert.deepEqual(installTargets.plugins[0]?.environmentRecommendation?.executionProfiles, ['headless', 'web'])

    const surfaceTargets = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1',
      refreshAfterHours: 168,
      autoDiscover: { webClientGaps: true },
      surfaces: [{
        id: 'manual-tui',
        sourceCaseId: 'web-plugin-node24',
        plane: 'tui',
        profile: 'web-plugin-tui',
        runtimeId: 'web-plugin',
        reason: 'A manually reviewed TUI contract remains authoritative.',
      }],
    }, targets, observations, recommendations())

    assert.deepEqual(surfaceTargets.surfaces.map(item => `${item.sourceCaseId}:${item.plane}`).sort(), [
      'web-plugin-node22:web',
      'web-plugin-node24:tui',
      'web-plugin-node24:web',
    ].sort())
    assert.equal(surfaceTargets.surfaces.find(item => item.id === 'manual-tui')?.reason, 'A manually reviewed TUI contract remains authoritative.')

    const inferredNode18 = applyDshEnvironmentRecommendations(targets, observations, recommendations({
      preferredNodeMajor: 18,
      nodeMajors: [18],
    }))
    assert.equal(inferredNode18.runtimeProfiles.find(item => item.nodeMajor === 18), undefined)
    assert.deepEqual(inferredNode18.plugins[0]?.runtimeProfiles, [])
    assert.deepEqual(inferredNode18.plugins[0]?.environmentRecommendation?.unavailableNodeMajors, [18])
  })

  it('ignores recommendations after the exact source evidence changes', () => {
    const stale = recommendations({ sourceFingerprint: `sha256:${'f'.repeat(64)}` })
    const installTargets = applyDshEnvironmentRecommendations(targets, observations, stale)
    assert.equal(installTargets.plugins[0]?.runtimeProfiles, undefined)

    const surfaceTargets = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1',
      refreshAfterHours: 168,
      surfaces: [],
    }, targets, observations, stale)
    assert.deepEqual(surfaceTargets.surfaces, [])
  })

  it('parses durable recommendation state and initializes an empty state', () => {
    const parsed = parseDshEnvironmentRecommendations(recommendations())
    assert.equal(parsed.entries[0]?.status, 'recommended')
    assert.equal(parsed.entries[0]?.preferredNodeMajor, 24)
    assert.equal(parsed.pendingTasks[0]?.targetId, 'web-plugin')
    assert.deepEqual(emptyDshEnvironmentRecommendations().entries, [])
    assert.deepEqual(emptyDshEnvironmentRecommendations().pendingTasks, [])
  })

  it('persists a pending task before an unavailable Agent can block planning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upstream-radar-environment-recommendation-'))
    try {
      const targetsPath = join(directory, 'targets.json')
      const observationsPath = join(directory, 'observations.json')
      const recommendationsPath = join(directory, 'recommendations.json')
      const reportPath = join(directory, 'recommendations.md')
      const candidatesPath = join(directory, 'candidates.json')
      const { source: _dshSource, ...dshWithoutSource } = observations.targets['deepseek-harness']
      const { source: _pluginSource, ...pluginWithoutSource } = observations.targets['web-plugin-source']
      const localObservations = {
        targets: {
          'deepseek-harness': dshWithoutSource,
          'web-plugin-source': pluginWithoutSource,
        },
      }
      await Promise.all([
        writeFile(targetsPath, JSON.stringify(targets), 'utf8'),
        writeFile(observationsPath, JSON.stringify(localObservations), 'utf8'),
      ])
      const env = { ...process.env }
      delete env.ISSUE_LOCATOR_LLM_BASE_URL
      delete env.ISSUE_LOCATOR_LLM_API_KEY
      delete env.ISSUE_LOCATOR_LLM_MODEL

      const recoveryPath = join(directory, 'last-complete-state.json')
      const initialState = JSON.stringify(emptyDshEnvironmentRecommendations())
      await writeFile(recommendationsPath, initialState)
      await link(recommendationsPath, recoveryPath)

      await assert.rejects(execFile(process.execPath, [
        'scripts/plan-dsh-environment-recommendations.mjs',
        targetsPath,
        observationsPath,
        recommendationsPath,
        reportPath,
        candidatesPath,
      ], { cwd: process.cwd(), env }), (error: unknown) => (
        typeof error === 'object' && error !== null && (error as { code?: number }).code === 2
      ))

      const persisted = parseDshEnvironmentRecommendations(JSON.parse(await readFile(recommendationsPath, 'utf8')))
      assert.equal(await readFile(recoveryPath, 'utf8'), initialState, 'state replacement must not truncate the last complete recovery snapshot')
      assert.equal(persisted.pendingTasks.length, 1)
      assert.equal(persisted.pendingTasks[0]?.targetId, 'web-plugin')
      assert.deepEqual(persisted.entries, [])
      assert.match(await readFile(reportPath, 'utf8'), /agent-failed/)
      const captured = JSON.parse(await readFile(candidatesPath, 'utf8'))
      assert.equal(captured[0].targetId, 'web-plugin')
      assert.equal(captured[0].plugin, 'web-plugin@1.2.3')
      assert.deepEqual(captured[0].documents, [])

      const firstState = await readFile(recommendationsPath, 'utf8')
      await assert.rejects(execFile(process.execPath, [
        'scripts/plan-dsh-environment-recommendations.mjs',
        targetsPath,
        observationsPath,
        recommendationsPath,
        reportPath,
      ], { cwd: process.cwd(), env }))
      assert.equal(await readFile(recommendationsPath, 'utf8'), firstState)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('eventually reviews deferred plugins when the first full batch repeatedly fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upstream-radar-environment-fairness-'))
    const received: string[] = []
    let persistFailure: string | undefined
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const targetId = /\nTarget: (task-\d+)/.exec(body.messages[1].content)?.[1] ?? 'missing-target'
      received.push(targetId)
      const durable = parseDshEnvironmentRecommendations(JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8')))
      if (!durable.pendingTasks.some(task => task.targetId === targetId)) persistFailure = targetId
      if (targetId !== 'task-32') { response.writeHead(503).end('temporary fixture failure'); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        status: 'insufficient-evidence', nodeMajors: [], executionProfiles: [],
        authorEnvironment: { packageManagers: [], overrides: [], workflows: [], dshVersions: [] },
        summary: 'The exact manifest alone does not establish the intended environment.', evidence: ['source-manifest'],
      }) } }] }))
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address !== null && typeof address === 'object')
      const plugins = Array.from({ length: 33 }, (_, index) => {
        const id = `task-${String(index).padStart(2, '0')}`
        return { id, observerTargetId: id, spec: `${id}@1.0.0`, reason: 'exercise bounded durable scheduling' }
      })
      await writeFile(join(directory, 'targets.json'), JSON.stringify({ ...targets, plugins }))
      await writeFile(join(directory, 'observations.json'), JSON.stringify({ targets: {
        'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' } },
        ...Object.fromEntries(plugins.map(plugin => [plugin.id, {
          manifest: { name: plugin.id, version: '1.0.0' }, package: { name: plugin.id, version: '1.0.0' },
        }])),
      } }))
      const env = { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
        ISSUE_LOCATOR_LLM_API_KEY: 'local-test-value', ISSUE_LOCATOR_LLM_MODEL: 'fixture' }
      const run = () => execFile(process.execPath, ['scripts/plan-dsh-environment-recommendations.mjs',
        ...['targets.json', 'observations.json', 'recommendations.json', 'report.md'].map(file => join(directory, file)),
      ], { cwd: process.cwd(), env, timeout: 15_000 })
      await assert.rejects(run(), (error: unknown) => (error as { code?: number }).code === 2)
      assert.equal(received.length, 32)
      assert.ok(!received.includes('task-32'))
      await assert.rejects(run(), (error: unknown) => (error as { code?: number }).code === 2)
      const after = parseDshEnvironmentRecommendations(JSON.parse(await readFile(join(directory, 'recommendations.json'), 'utf8')))
      assert.ok(after.entries.some(entry => entry.targetId === 'task-32'), 'a failed prefix must not starve a healthy deferred plugin')
      assert.equal(after.pendingTasks.length, 32)
      assert.equal(persistFailure, undefined, 'every delivered task must already be durable')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
