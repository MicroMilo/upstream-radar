import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ReleaseNotesSource } from '../src/github-release.js'
import { packageKey } from '../src/osv.js'
import { emptyRadarState, pollRadar, type AdvisorySource, type ReleaseSource } from '../src/radar.js'
import type { AdvisoryMatch, ProjectInventory } from '../src/radar-types.js'

const inventory: ProjectInventory = {
  schema: 'upstream-radar.inventory/v1alpha1',
  project: {
    id: 'payments-api',
    name: 'Payments API',
    repository: 'https://github.com/acme/payments-api',
    owner: 'payments-platform',
    channels: ['feishu:payments-security'],
  },
  environment: { nodeVersion: '22.18.0' },
  plugins: [{
    package: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'plugin',
      nodes: [
        { id: 'plugin', name: 'plugin', version: '1.0.0' },
        { id: 'logger', name: 'logger', version: '4.0.2' },
        { id: 'parser-old', name: 'parser', version: '2.9.0', source: 'dsh-host' },
      ],
      edges: [
        { from: 'plugin', to: 'logger', kind: 'runtime' },
        { from: 'logger', to: 'parser-old', kind: 'runtime' },
      ],
    },
  }],
}

function source(modified: string, active = true): AdvisorySource {
  return {
    async query(packages): Promise<Map<string, AdvisoryMatch[]>> {
      const results = new Map<string, AdvisoryMatch[]>()
      for (const item of packages) results.set(`${item.ecosystem}:${item.name}@${item.version}`, [])
      if (active) {
        results.set('npm:parser@2.9.0', [{
          package: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
          advisory: {
            id: 'GHSA-demo',
            aliases: ['CVE-2026-1234'],
            summary: 'Unsafe parser input handling',
            details: 'Attackers may trigger an unsafe parser path.',
            severity: 'high',
            published: '2026-08-14T00:00:00.000Z',
            modified,
            fixedVersions: ['3.0.0'],
            references: ['https://example.test/GHSA-demo'],
          },
        }])
      }
      return results
    },
  }
}

describe('radar polling', () => {
  it('emits only meaningful new, updated and resolved transitions', async () => {
    const first = await pollRadar([inventory], emptyRadarState(), source('2026-08-14T01:00:00.000Z'), new Date('2026-08-14T01:01:00.000Z'))
    assert.equal(first.events.length, 1)
    assert.equal(first.events[0]?.change, 'new')
    assert.equal(first.analysisTasks.length, 1)
    const firstEvent = first.events[0]
    assert.ok(firstEvent !== undefined)
    assert.equal(firstEvent.kind, 'vulnerability')
    assert.deepEqual(firstEvent.affectedSources, ['dsh-host'])
    assert.deepEqual(firstEvent.paths[0]?.map(item => `${item.name}@${item.version}`), [
      'plugin@1.0.0',
      'logger@4.0.2',
      'parser@2.9.0',
    ])

    const unchanged = await pollRadar([inventory], first.state, source('2026-08-14T01:00:00.000Z'), new Date('2026-08-14T01:31:00.000Z'))
    assert.equal(unchanged.events.length, 0)

    const updated = await pollRadar([inventory], unchanged.state, source('2026-08-14T02:00:00.000Z'), new Date('2026-08-14T02:01:00.000Z'))
    assert.equal(updated.events[0]?.change, 'updated')
    assert.equal(updated.events[0]?.incidentId, first.events[0]?.incidentId)
    assert.equal(updated.state.pendingAnalysisTasks.length, 1)
    assert.equal(updated.state.pendingAnalysisTasks[0]?.event.change, 'updated')

    const resolved = await pollRadar([inventory], updated.state, source('2026-08-14T02:00:00.000Z', false), new Date('2026-08-14T03:01:00.000Z'))
    assert.equal(resolved.events[0]?.change, 'resolved')
    assert.equal(resolved.analysisTasks.length, 0)
    assert.equal(resolved.state.pendingAnalysisTasks.length, 0)
  })

  it('emits one compatibility task when npm observes a new candidate release', async () => {
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '2.0.0', main: './new.js' },
          upgradeCandidates: [
            { name: 'plugin', version: '1.5.0', main: './old.js' },
            { name: 'plugin', version: '2.0.0', main: './new.js' },
          ],
        }]])
      },
    }
    const noVulnerabilities = source('2026-08-14T01:00:00.000Z', false)
    const releaseNotes: ReleaseNotesSource = {
      async query(observations) {
        return new Map(observations
          .filter(observation => observation.candidate.version !== observation.installed.version)
          .map(observation => [
            `${observation.installed.ecosystem}:${observation.installed.name}@${observation.installed.version}`,
            {
              text: 'BREAKING CHANGE: the plugin now requires the project session to be configured.',
              url: `https://github.com/acme/plugin/releases/tag/v${observation.candidate.version}`,
            },
          ]))
      },
    }
    const first = await pollRadar(
      [inventory],
      emptyRadarState(),
      noVulnerabilities,
      new Date('2026-08-14T04:00:00.000Z'),
      releases,
      releaseNotes,
    )
    assert.equal(first.events.length, 1)
    assert.equal(first.events[0]?.kind, 'compatibility')
    assert.equal(first.events[0]?.kind === 'compatibility'
      ? first.events[0].upgradePath?.firstCandidate?.candidate.version
      : undefined, '1.5.0')
    const unchanged = await pollRadar(
      [inventory],
      first.state,
      noVulnerabilities,
      new Date('2026-08-14T04:30:00.000Z'),
      releases,
      releaseNotes,
    )
    assert.equal(unchanged.events.length, 0)

    const nextRelease: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '3.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '3.0.0', main: './next.js' },
        }]])
      },
    }
    const updated = await pollRadar(
      [inventory],
      unchanged.state,
      noVulnerabilities,
      new Date('2026-08-14T05:00:00.000Z'),
      nextRelease,
      releaseNotes,
    )
    assert.equal(updated.events[0]?.kind, 'compatibility')
    assert.equal(updated.events[0]?.change, 'updated')
    assert.equal(updated.state.pendingAnalysisTasks.length, 1)
    const compatibility = updated.events.find(event => event.kind === 'compatibility')
    assert.equal(compatibility?.releaseNotesUrl, 'https://github.com/acme/plugin/releases/tag/v3.0.0')
    assert.equal(compatibility?.releaseNotes?.includes('BREAKING CHANGE'), true)

    const caughtUp: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '1.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '1.0.0', main: './old.js' },
        }]])
      },
    }
    const resolved = await pollRadar(
      [inventory],
      updated.state,
      noVulnerabilities,
      new Date('2026-08-14T05:30:00.000Z'),
      caughtUp,
    )
    assert.equal(resolved.events[0]?.kind, 'compatibility')
    assert.equal(resolved.events[0]?.change, 'resolved')
    assert.equal(resolved.analysisTasks.length, 0)
    assert.equal(resolved.state.pendingAnalysisTasks.length, 0)
  })

  it('skips a known-vulnerable intermediate release when choosing an upgrade path', async () => {
    const calls: string[][] = []
    const candidateAdvisory = {
      id: 'GHSA-known-plugin',
      aliases: [],
      summary: 'Known vulnerable candidate',
      details: 'The candidate is affected.',
      severity: 'high' as const,
      modified: '2026-08-14T04:00:00.000Z',
      fixedVersions: ['1.2.0'],
      references: [],
    }
    const advisories: AdvisorySource = {
      async query(packages) {
        calls.push(packages.map(packageKey))
        return new Map(packages.map(item => [
          packageKey(item),
          item.version === '1.1.0' ? [{ package: item, advisory: candidateAdvisory }] : [],
        ]))
      },
    }
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '2.0.0', main: './new.js' },
          upgradeCandidates: [
            { name: 'plugin', version: '1.1.0', main: './old.js' },
            { name: 'plugin', version: '1.2.0', main: './old.js' },
            { name: 'plugin', version: '2.0.0', main: './new.js' },
          ],
        }]])
      },
    }

    const result = await pollRadar(
      [inventory],
      emptyRadarState(),
      advisories,
      new Date('2026-08-14T04:00:00.000Z'),
      releases,
    )
    const event = result.events.find(candidate => candidate.kind === 'compatibility')
    assert.ok(event?.kind === 'compatibility')
    assert.equal(event.upgradePath?.vulnerabilityStatus, 'checked')
    assert.equal(event.upgradePath?.firstCandidate?.candidate.version, '1.2.0')
    assert.ok(event.upgradePath?.blocked.some(item => item.candidate.version === '1.1.0'
      && item.signals.some(signal => signal.code === 'known-vulnerability')))
    assert.equal(calls.length, 2)
    assert.ok(calls[1]?.includes('npm:plugin@1.1.0'))
  })

  it('withholds the upgrade recommendation when the candidate OSV check fails', async () => {
    let calls = 0
    const advisories: AdvisorySource = {
      async query(packages) {
        calls += 1
        if (calls === 2) throw new Error('OSV candidate timeout')
        return new Map(packages.map(item => [packageKey(item), []]))
      },
    }
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '2.0.0', main: './new.js' },
          upgradeCandidates: [
            { name: 'plugin', version: '1.1.0', main: './old.js' },
            { name: 'plugin', version: '2.0.0', main: './new.js' },
          ],
        }]])
      },
    }
    const result = await pollRadar(
      [inventory],
      emptyRadarState(),
      advisories,
      new Date('2026-08-14T04:00:00.000Z'),
      releases,
    )
    const event = result.events.find(candidate => candidate.kind === 'compatibility')
    assert.ok(event?.kind === 'compatibility')
    assert.equal(event.upgradePath?.vulnerabilityStatus, 'unavailable')
    assert.equal(event.upgradePath?.firstCandidate, undefined)
    assert.deepEqual(result.sourceErrors, [{ source: 'osv', message: 'OSV candidate timeout' }])
    assert.equal(result.state.sourceHealth?.osv?.consecutiveFailures, 1)
  })

  it('ignores an npm latest tag older than the installed package', async () => {
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin') ?? {
          ecosystem: 'npm' as const,
          name: 'plugin',
          version: '1.0.0',
        }
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '0.0.1',
          previous: { name: 'plugin', version: '1.0.0' },
          candidate: { name: 'plugin', version: '0.0.1' },
        }]])
      },
    }
    const result = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T04:00:00.000Z'),
      releases,
    )
    assert.equal(result.events.some(event => event.kind === 'compatibility'), false)

    const newer: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin') ?? {
          ecosystem: 'npm' as const,
          name: 'plugin',
          version: '1.0.0',
        }
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: installed.version },
          candidate: { name: 'plugin', version: '2.0.0' },
        }]])
      },
    }
    const active = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T04:30:00.000Z'),
      newer,
    )
    assert.equal(Object.keys(active.state.activeCompatibility).length, 1)
    const rolledBack = await pollRadar(
      [inventory],
      active.state,
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T05:00:00.000Z'),
      releases,
    )
    assert.equal(rolledBack.events.length, 0)
    assert.equal(Object.keys(rolledBack.state.activeCompatibility).length, 1)
  })

  it('does not lose a vulnerability event when the independent release source is unavailable', async () => {
    const activeRelease: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '2.0.0', main: './new.js' },
        }]])
      },
    }
    const warm = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T04:30:00.000Z'),
      activeRelease,
    )
    const unavailable: ReleaseSource = { async query() { throw new Error('registry unavailable') } }
    const result = await pollRadar(
      [inventory],
      warm.state,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T05:00:00.000Z'),
      unavailable,
    )
    assert.equal(result.events.some(event => event.kind === 'vulnerability'), true)
    assert.equal(result.events.some(event => event.kind === 'compatibility' && event.change === 'resolved'), false)
    assert.equal(Object.keys(result.state.activeCompatibility).length, 1)
    assert.deepEqual(result.sourceErrors, [{ source: 'npm-releases', message: 'registry unavailable' }])
  })

  it('preserves confirmed vulnerability state and pending tasks when OSV is unavailable', async () => {
    const first = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T06:30:00.000Z'),
    )
    const unavailable: AdvisorySource = { async query() { throw new Error('OSV timeout') } }
    const result = await pollRadar(
      [inventory],
      first.state,
      unavailable,
      new Date('2026-08-14T06:31:00.000Z'),
    )
    assert.equal(result.events.length, 0)
    assert.equal(Object.keys(result.state.activeVulnerabilities).length, 1)
    assert.equal(result.state.pendingAnalysisTasks.length, 1)
    assert.deepEqual(result.sourceErrors, [{ source: 'osv', message: 'OSV timeout' }])
  })

  it('creates one DSH source-health incident after three failures and resolves it on recovery', async () => {
    const unavailable: AdvisorySource = { async query() { throw new Error('OSV timeout') } }
    const first = await pollRadar(
      [inventory],
      emptyRadarState(),
      unavailable,
      new Date('2026-08-14T08:00:00.000Z'),
    )
    const second = await pollRadar(
      [inventory],
      first.state,
      unavailable,
      new Date('2026-08-14T08:30:00.000Z'),
    )
    const third = await pollRadar(
      [inventory],
      second.state,
      unavailable,
      new Date('2026-08-14T09:00:00.000Z'),
    )
    assert.equal(first.events.length, 0)
    assert.equal(second.events.length, 0)
    assert.equal(third.events.length, 1)
    assert.equal(third.events[0]?.kind, 'source-health')
    assert.equal(third.events[0]?.change, 'new')
    assert.equal(third.state.sourceHealth?.osv?.consecutiveFailures, 3)
    assert.equal(Object.keys(third.state.activeSourceHealth ?? {}).length, 1)
    assert.equal(third.state.pendingAnalysisTasks.length, 1)

    const fourth = await pollRadar(
      [inventory],
      third.state,
      unavailable,
      new Date('2026-08-14T09:30:00.000Z'),
    )
    assert.equal(fourth.events.length, 0)
    assert.equal(Object.values(fourth.state.activeSourceHealth ?? {})[0]?.event.failureCount, 4)

    const recovered = await pollRadar(
      [inventory],
      fourth.state,
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T10:00:00.000Z'),
    )
    assert.equal(recovered.events.some(event => event.kind === 'source-health' && event.change === 'resolved'), true)
    assert.equal(Object.keys(recovered.state.activeSourceHealth ?? {}).length, 0)
    assert.equal(recovered.state.pendingAnalysisTasks.length, 0)
  })

  it('keeps npm compatibility facts when GitHub release notes are unavailable', async () => {
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '2.0.0', main: './new.js' },
        }]])
      },
    }
    const unavailable: ReleaseNotesSource = { async query() { throw new Error('GitHub rate limit') } }
    const result = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T06:00:00.000Z'),
      releases,
      unavailable,
    )
    assert.equal(result.events.some(event => event.kind === 'compatibility'), true)
    assert.deepEqual(result.sourceErrors, [{ source: 'github-releases', message: 'GitHub rate limit' }])
  })

  it('does not turn a temporary GitHub failure into a duplicate update for the same candidate', async () => {
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === 'plugin')
        assert.ok(installed)
        return new Map([['npm:plugin@1.0.0', {
          installed,
          latestVersion: '2.0.0',
          previous: { name: 'plugin', version: '1.0.0', main: './old.js' },
          candidate: { name: 'plugin', version: '2.0.0', main: './new.js' },
        }]])
      },
    }
    const notes: ReleaseNotesSource = {
      async query() {
        return new Map([['npm:plugin@1.0.0', {
          text: 'BREAKING CHANGE: requires the new session API.',
          url: 'https://github.com/acme/plugin/releases/tag/v2.0.0',
        }]])
      },
    }
    const first = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T07:00:00.000Z'),
      releases,
      notes,
    )
    const unavailable: ReleaseNotesSource = { async query() { throw new Error('temporary GitHub failure') } }
    const second = await pollRadar(
      [inventory],
      first.state,
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T07:30:00.000Z'),
      releases,
      unavailable,
    )
    assert.equal(second.events.length, 0)
    assert.equal(Object.values(second.state.activeCompatibility)[0]?.event.releaseNotesUrl, 'https://github.com/acme/plugin/releases/tag/v2.0.0')
    assert.deepEqual(second.sourceErrors, [{ source: 'github-releases', message: 'temporary GitHub failure' }])
  })
})
