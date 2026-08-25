import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  AWESOME_DSH_COHORT_SCHEMA,
  buildDshDirectoryCompatibilityFeed,
  renderDshDirectoryCompatibilityFeed,
} from '../src/dsh-directory-feed.js'
import { DSH_COMPATIBILITY_LEDGER_SCHEMA, type DshCompatibilityLedgerEntry } from '../src/dsh-compatibility-ledger.js'
import { DSH_INSTALL_TARGETS_SCHEMA } from '../src/dsh-install-plan.js'
import { DSH_SURFACE_LEDGER_SCHEMA, type DshSurfaceLedger } from '../src/dsh-surface.js'

function ledgerEntry(targetId: string, result: DshCompatibilityLedgerEntry['result']): DshCompatibilityLedgerEntry {
  return {
    caseId: `${targetId}-node22`,
    targetId,
    plugin: `${targetId}@1.0.0`,
    dshVersion: '0.1.1-rc.2',
    runtime: {
      nodeMajor: 22,
      nodeVersion: '22.23.2',
      platform: 'linux',
      architecture: 'x64',
      pnpmVersion: '11.7.0',
    },
    staticFingerprint: `sha256:${'a'.repeat(64)}`,
    contractFingerprint: `sha256:${'b'.repeat(64)}`,
    observedAt: '2026-08-23T00:00:00.000Z',
    result,
    reason: `${result} evidence`,
    ...(result === 'build-approval-required' ? { requiredDependencyBuilds: ['protobufjs'] } : {}),
    artifact: { lifecycleScripts: [], sha256: 'c'.repeat(64) },
    observer: {
      schema: 'upstream-radar.dsh-install-observation/v1alpha1',
      version: '0.41.0',
    },
  }
}

function fixture() {
  const ids = ['clean', 'broken', 'peer-gap', 'approval', 'unknown']
  return {
    cohort: {
      schema: AWESOME_DSH_COHORT_SCHEMA,
      selectedAt: '2026-08-22T00:00:00.000Z',
      source: {
        repository: 'awesome-dsh-plugin/awesome-dsh-plugin',
        commit: 'd'.repeat(40),
        commitUrl: `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/commit/${'d'.repeat(40)}`,
        entryDirectory: 'data/plugins',
        entryCount: 100,
        license: 'CC0-1.0',
      },
      plugins: [...ids, 'source-only'].map(id => ({
        id,
        catalogEntry: `data/plugins/example__${id}.yml`,
        catalogUrl: id === 'source-only'
          ? 'https://github.com/example/source-only/tree/main/packages/plugin'
          : `https://github.com/example/${id}`,
        repository: `example/${id}`,
        category: 'dev',
        distribution: id === 'source-only'
          ? { kind: 'repository-installer', reason: 'no matching public npm artifact' }
          : { kind: 'npm', name: id, selectedVersion: '1.0.0', distTag: 'latest' },
      })),
    },
    installTargets: {
      schema: DSH_INSTALL_TARGETS_SCHEMA,
      refreshAfterHours: 168,
      runtimeProfiles: [{ id: 'node22', nodeMajor: 22 }],
      plugins: ids.map(id => ({
        id,
        spec: `${id}@1.0.0`,
        observerTargetId: id,
        reason: `observe ${id}`,
      })),
    },
    ledger: {
      schema: DSH_COMPATIBILITY_LEDGER_SCHEMA,
      entries: [
        ledgerEntry('clean', 'compatible'),
        ledgerEntry('broken', 'load-failed'),
        ledgerEntry('peer-gap', 'peer-contract-incompatible'),
        ledgerEntry('approval', 'build-approval-required' as DshCompatibilityLedgerEntry['result']),
        ledgerEntry('unknown', 'unknown'),
      ],
    },
    observations: {
      targets: {
        'deepseek-harness': {
          package: { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', distTag: 'next' },
        },
        clean: {
          package: { name: 'clean', version: '2.0.0-beta.1', distTag: 'beta' },
        },
      },
    },
  }
}

function surfaceLedger(
  sourceTargetId: string,
  result: DshSurfaceLedger['entries'][number]['result'] = 'compatible',
  overrides: Partial<DshSurfaceLedger['entries'][number]> = {},
): DshSurfaceLedger {
  const status = result === 'compatible' ? 'passed' as const : 'failed' as const
  return {
    schema: DSH_SURFACE_LEDGER_SCHEMA,
    entries: [{
      caseId: `${sourceTargetId}-web`,
      sourceCaseId: `${sourceTargetId}-node22`,
      plugin: `${sourceTargetId}@1.0.0`,
      dshVersion: '0.1.1-rc.2',
      plane: 'web',
      profile: 'web',
      runtimeId: sourceTargetId,
      sourceFingerprint: `sha256:${'d'.repeat(64)}`,
      contractFingerprint: `sha256:${'e'.repeat(64)}`,
      observedAt: '2026-08-23T00:30:00.000Z',
      runtime: {
        nodeMajor: 22,
        nodeVersion: '22.23.2',
        platform: 'linux',
        architecture: 'x64',
        pnpmVersion: '11.7.0',
      },
      artifact: { sha256: 'c'.repeat(64), bytes: 1_024 },
      stages: {
        runtime: { status: 'passed' },
        artifact: { status: 'passed' },
        profile: { status: 'passed' },
        install: { status: 'passed' },
        registration: { status: 'passed' },
        host: { status: 'passed' },
        surface: { status },
        interaction: { status },
        shutdown: { status: 'passed' },
      },
      evidence: {
        plane: 'web',
        url: 'http://127.0.0.1:3080/',
        httpStatus: 200,
        rootMounted: true,
        bootManifestPresent: true,
        pluginEntryPresent: result === 'compatible',
        pluginBundleStatus: result === 'compatible' ? 200 : 404,
        applicationMounted: result === 'compatible',
        pluginMaterialized: result === 'compatible',
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
      },
      result,
      reason: `${result} Web evidence`,
      observer: {
        schema: 'upstream-radar.dsh-surface-observation/v1alpha1',
        version: '0.44.0',
      },
      ...overrides,
    }],
  }
}

describe('DSH directory compatibility feed', () => {
  it('publishes exact evidence without turning coverage gaps into pass or fail', () => {
    const input = fixture()
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    assert.deepEqual(feed.summary, {
      total: 6,
      'observed-compatible': 0,
      'observed-incompatible': 1,
      'needs-review': 3,
      'update-pending': 1,
      'not-observed': 1,
    })
    assert.equal(feed.plugins.find(item => item.id === 'clean')?.status, 'update-pending')
    assert.deepEqual(feed.plugins.find(item => item.id === 'clean')?.distribution, {
      kind: 'npm',
      name: 'clean',
      selectedVersion: '2.0.0-beta.1',
      distTag: 'beta',
    })
    assert.equal(feed.plugins.find(item => item.id === 'clean')?.cells[0]?.artifact.spec, 'clean@1.0.0')
    assert.equal(feed.plugins.find(item => item.id === 'broken')?.status, 'observed-incompatible')
    assert.equal(feed.plugins.find(item => item.id === 'peer-gap')?.status, 'needs-review')
    assert.equal(feed.plugins.find(item => item.id === 'approval')?.status, 'needs-review')
    assert.deepEqual(feed.plugins.find(item => item.id === 'approval')?.cells[0]?.requiredDependencyBuilds, ['protobufjs'])
    assert.equal(feed.plugins.find(item => item.id === 'unknown')?.status, 'needs-review')
    assert.equal(feed.plugins.find(item => item.id === 'source-only')?.status, 'not-observed')
    assert.equal(
      feed.plugins.find(item => item.id === 'source-only')?.catalogUrl,
      'https://github.com/example/source-only/tree/main/packages/plugin',
    )
    assert.equal(feed.plugins.find(item => item.id === 'clean')?.cells[0]?.recheckDueAt, '2026-08-30T00:00:00.000Z')
    assert.equal(feed.producer.license, 'Apache-2.0')
    assert.deepEqual(feed.selectedHost, {
      package: '@deepseek-ai/dsh',
      version: '0.1.1-rc.2',
    })
  })

  it('does not inherit old green cells after the selected DSH host changes', () => {
    const input = fixture()
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      observations: {
        ...input.observations,
        targets: {
          ...input.observations.targets,
          'deepseek-harness': {
            package: { name: '@deepseek-ai/dsh', version: '0.1.1-rc.3', distTag: 'next' },
          },
        },
      },
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    assert.equal(feed.plugins.find(item => item.id === 'broken')?.status, 'update-pending')
    assert.equal(feed.plugins.find(item => item.id === 'peer-gap')?.status, 'update-pending')
    assert.deepEqual(feed.summary, {
      total: 6,
      'observed-compatible': 0,
      'observed-incompatible': 0,
      'needs-review': 0,
      'update-pending': 5,
      'not-observed': 1,
    })
  })

  it('joins an exact Web cell and lets it cover only a Web-client headless gap', () => {
    const input = fixture()
    const peerGap = input.ledger.entries.find(entry => entry.caseId === 'peer-gap-node22')
    assert.ok(peerGap)
    peerGap.resolution = {
      runtimeGraph: {
        digest: `sha256:${'f'.repeat(64)}`,
        nodes: 10,
        edges: 9,
        unresolved: 1,
        unresolvedDependencies: [{
          from: 'node_modules/peer-gap',
          name: '@deepseek-ai/dsh-client-ui-primitives',
          spec: '0.1.1-rc.2',
          kind: 'peer',
        }],
      },
    }
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      surfaceLedger: surfaceLedger('peer-gap'),
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    const plugin = feed.plugins.find(item => item.id === 'peer-gap')
    assert.equal(plugin?.status, 'observed-compatible')
    assert.deepEqual(plugin?.cells.map(cell => cell.executionPlane), ['headless', 'web'])
    assert.deepEqual(plugin?.cells[0]?.coveredBy, ['peer-gap-web'])
    assert.equal(plugin?.cells[1]?.sourceCaseId, 'peer-gap-node22')
    assert.equal(plugin?.cells[1]?.evidenceSource, 'surface-ledger')
    assert.deepEqual(feed.boundary.executionPlanes, ['headless', 'web'])
  })

  it('keeps a non-client peer mismatch under review even when Web boot succeeds', () => {
    const input = fixture()
    const peerGap = input.ledger.entries.find(entry => entry.caseId === 'peer-gap-node22')
    assert.ok(peerGap)
    peerGap.resolution = {
      runtimeGraph: {
        digest: `sha256:${'f'.repeat(64)}`,
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
            status: 'mismatched',
            staticUsage: 'runtime-import-observed',
            resolvedVersion: '0.1.1-rc.2',
          }],
          issues: [{
            name: '@deepseek-ai/dsh-attachment',
            required: '0.1.0-rc.8',
            status: 'mismatched',
            staticUsage: 'runtime-import-observed',
            resolvedVersion: '0.1.1-rc.2',
          }],
        },
      },
    }
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      surfaceLedger: surfaceLedger('peer-gap'),
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    const plugin = feed.plugins.find(item => item.id === 'peer-gap')
    assert.equal(plugin?.status, 'needs-review')
    assert.equal(plugin?.cells[0]?.coveredBy, undefined)
    assert.equal(plugin?.cells[1]?.status, 'observed-compatible')
  })

  it('ignores a surface report that is not bound to the exact source artifact', () => {
    const input = fixture()
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      surfaceLedger: surfaceLedger('peer-gap', 'compatible', {
        artifact: { sha256: '9'.repeat(64), bytes: 1_024 },
      }),
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    const plugin = feed.plugins.find(item => item.id === 'peer-gap')
    assert.equal(plugin?.status, 'needs-review')
    assert.deepEqual(plugin?.cells.map(cell => cell.executionPlane), ['headless'])
  })

  it('lets an exact surface incompatibility override a green headless load', () => {
    const input = fixture()
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      observations: {
        ...input.observations,
        targets: {
          ...input.observations.targets,
          clean: { package: { name: 'clean', version: '1.0.0', distTag: 'latest' } },
        },
      },
      surfaceLedger: surfaceLedger('clean', 'surface-incompatible'),
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    assert.equal(feed.plugins.find(item => item.id === 'clean')?.status, 'observed-incompatible')
  })

  it('does not let malformed or name-mismatched observation state replace catalog distribution metadata', () => {
    const input = fixture()
    const feed = buildDshDirectoryCompatibilityFeed({
      ...input,
      observations: {
        targets: {
          clean: { package: { name: 'different-package', version: '9.0.0', distTag: 'latest' } },
          broken: { package: { name: 'broken', version: '^2.0.0', distTag: 'next' } },
        },
      },
      generatedAt: '2026-08-23T01:00:00.000Z',
    })

    assert.deepEqual(feed.plugins.find(item => item.id === 'clean')?.distribution, {
      kind: 'npm', name: 'clean', selectedVersion: '1.0.0', distTag: 'latest',
    })
    assert.deepEqual(feed.plugins.find(item => item.id === 'broken')?.distribution, {
      kind: 'npm', name: 'broken', selectedVersion: '1.0.0', distTag: 'latest',
    })
  })

  it('renders a consumer-readable boundary and status table', () => {
    const feed = buildDshDirectoryCompatibilityFeed({
      ...fixture(),
      generatedAt: '2026-08-23T01:00:00.000Z',
    })
    const markdown = renderDshDirectoryCompatibilityFeed(feed)
    assert.match(markdown, /0 observed compatible · 1 observed incompatible · 3 needs review · 1 update pending · 1 not observed/)
    assert.match(markdown, /`clean@2\.0\.0-beta\.1`.*`clean@1\.0\.0`.*`update-pending`/)
    assert.match(markdown, /has no exact cell yet/)
    assert.match(markdown, /must then show it as stale/)
    assert.match(markdown, /not a security review or endorsement/)
  })

  it('joins the checked-in awesome directory cohort to maintained isolated evidence', async () => {
    const cohort = JSON.parse(await readFile('examples/dsh/awesome-observer/cohort.json', 'utf8')) as unknown
    const installTargets = JSON.parse(await readFile('examples/dsh/install-observer/targets.json', 'utf8')) as unknown
    const ledger = JSON.parse(await readFile('compatibility-ledger.json', 'utf8')) as unknown
    const surfaceLedger = JSON.parse(await readFile('surface-ledger.json', 'utf8')) as unknown
    const observations = JSON.parse(await readFile('observations.json', 'utf8')) as unknown
    const checkedInFeed = JSON.parse(await readFile('feeds/dsh-plugin-compatibility.json', 'utf8')) as { generatedAt: string }
    const feed = buildDshDirectoryCompatibilityFeed({
      cohort,
      installTargets,
      ledger,
      surfaceLedger,
      observations,
      generatedAt: checkedInFeed.generatedAt,
    })

    assert.deepEqual(feed, checkedInFeed)
    assert.equal(feed.plugins.length, 100)
    assert.equal(feed.plugins.find(item => item.id === 'dsh-browser')?.status, 'not-observed')
    assert.equal(feed.plugins.find(item => item.id === 'api-relay-audit')?.status, 'not-observed')
    assert.equal(
      feed.plugins.find(item => item.id === 'dsh-browser')?.catalogUrl,
      'https://github.com/Lum1104/dsh-browser/tree/main/packages/browser/bridge-browser',
    )
    assert.equal(Object.values(feed.summary).slice(1).reduce((sum, count) => sum + count, 0), feed.summary.total)
  })
})
