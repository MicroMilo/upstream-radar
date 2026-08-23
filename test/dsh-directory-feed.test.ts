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
    artifact: { lifecycleScripts: [], sha256: 'c'.repeat(64) },
    observer: {
      schema: 'upstream-radar.dsh-install-observation/v1alpha1',
      version: '0.41.0',
    },
  }
}

function fixture() {
  const ids = ['clean', 'broken', 'peer-gap', 'unknown']
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
        ledgerEntry('unknown', 'unknown'),
      ],
    },
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
      total: 5,
      'observed-compatible': 1,
      'observed-incompatible': 1,
      'needs-review': 2,
      'not-observed': 1,
    })
    assert.equal(feed.plugins.find(item => item.id === 'clean')?.status, 'observed-compatible')
    assert.equal(feed.plugins.find(item => item.id === 'broken')?.status, 'observed-incompatible')
    assert.equal(feed.plugins.find(item => item.id === 'peer-gap')?.status, 'needs-review')
    assert.equal(feed.plugins.find(item => item.id === 'unknown')?.status, 'needs-review')
    assert.equal(feed.plugins.find(item => item.id === 'source-only')?.status, 'not-observed')
    assert.equal(
      feed.plugins.find(item => item.id === 'source-only')?.catalogUrl,
      'https://github.com/example/source-only/tree/main/packages/plugin',
    )
    assert.equal(feed.plugins.find(item => item.id === 'clean')?.cells[0]?.recheckDueAt, '2026-08-30T00:00:00.000Z')
    assert.equal(feed.producer.license, 'Apache-2.0')
  })

  it('renders a consumer-readable boundary and status table', () => {
    const feed = buildDshDirectoryCompatibilityFeed({
      ...fixture(),
      generatedAt: '2026-08-23T01:00:00.000Z',
    })
    const markdown = renderDshDirectoryCompatibilityFeed(feed)
    assert.match(markdown, /1 observed compatible · 1 observed incompatible · 2 needs review · 1 not observed/)
    assert.match(markdown, /must then show it as stale/)
    assert.match(markdown, /not a security review or endorsement/)
  })

  it('joins the checked-in awesome directory cohort to maintained isolated evidence', async () => {
    const cohort = JSON.parse(await readFile('examples/dsh/awesome-observer/cohort.json', 'utf8')) as unknown
    const installTargets = JSON.parse(await readFile('examples/dsh/install-observer/targets.json', 'utf8')) as unknown
    const ledger = JSON.parse(await readFile('compatibility-ledger.json', 'utf8')) as unknown
    const checkedInFeed = JSON.parse(await readFile('feeds/dsh-plugin-compatibility.json', 'utf8')) as { generatedAt: string }
    const feed = buildDshDirectoryCompatibilityFeed({
      cohort,
      installTargets,
      ledger,
      generatedAt: checkedInFeed.generatedAt,
    })

    assert.deepEqual(feed, checkedInFeed)
    assert.equal(feed.plugins.length, 50)
    assert.equal(feed.plugins.find(item => item.id === 'dsh-browser')?.status, 'not-observed')
    assert.equal(feed.plugins.find(item => item.id === 'api-relay-audit')?.status, 'not-observed')
    assert.equal(
      feed.plugins.find(item => item.id === 'dsh-browser')?.catalogUrl,
      'https://github.com/Lum1104/dsh-browser/tree/main/packages/browser/bridge-browser',
    )
    assert.equal(Object.values(feed.summary).slice(1).reduce((sum, count) => sum + count, 0), feed.summary.total)
  })
})
