import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ReleaseNotesSource } from '../src/github-release.js'
import { packageKey } from '../src/osv.js'
import { emptyRadarState, pollRadar, type AdvisorySource, type CandidateDependencySource, type ReleaseSource } from '../src/radar.js'
import type { AdvisoryMatch, AdvisoryRiskSignals, DependencyGraph, ProjectInventory, VulnerabilityAdvisory } from '../src/radar-types.js'
import type { ThreatIntelSourceBinding } from '../src/threat-intel.js'

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

function source(modified: string, active = true, fixedVersions = ['3.0.0']): AdvisorySource {
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
            fixedVersions,
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
    assert.equal(first.state.history?.length, 1)
    assert.equal(first.state.history?.[0]?.change, 'new')
    const firstEvent = first.events[0]
    assert.ok(firstEvent !== undefined)
    assert.equal(firstEvent.kind, 'vulnerability')
    assert.deepEqual(firstEvent.affectedSources, ['dsh-host'])
    assert.deepEqual(firstEvent.advisory.sources, ['osv'])
    assert.deepEqual(firstEvent.paths[0]?.map(item => `${item.name}@${item.version}`), [
      'plugin@1.0.0',
      'logger@4.0.2',
      'parser@2.9.0',
    ])
    const firstTask = first.state.pendingAnalysisTasks[0]
    assert.ok(firstTask)
    first.state.analysisResults = {
      [firstEvent.incidentId]: {
        schema: 'upstream-radar.analysis-result/v1alpha1',
        taskId: firstTask.id,
        incidentId: firstEvent.incidentId,
        eventId: firstEvent.id,
        deliveryId: 'delivery-test',
        receivedAt: '2026-08-14T01:02:00.000Z',
        sessionId: 'session-test',
        userMessageId: 'message-test',
        assistantMessageId: 'assistant-test',
        project_exposure: 'unknown',
        confidence: 'low',
        evidence: ['src/index.ts'],
        recommended_action: 'Inspect the path.',
        urgency: 'planned',
        reasoning_summary: 'Evidence is incomplete.',
      },
    }

    const unchanged = await pollRadar([inventory], first.state, source('2026-08-14T01:00:00.000Z'), new Date('2026-08-14T01:31:00.000Z'))
    assert.equal(unchanged.events.length, 0)
    assert.equal(Object.keys(unchanged.state.analysisResults ?? {}).length, 1)
    assert.equal(unchanged.state.history?.length, 1)

    const updated = await pollRadar([inventory], unchanged.state, source('2026-08-14T02:00:00.000Z'), new Date('2026-08-14T02:01:00.000Z'))
    assert.equal(updated.events[0]?.change, 'updated')
    assert.equal(updated.events[0]?.incidentId, first.events[0]?.incidentId)
    assert.equal(updated.state.pendingAnalysisTasks.length, 1)
    assert.equal(updated.state.pendingAnalysisTasks[0]?.event.change, 'updated')
    assert.equal(Object.keys(updated.state.analysisResults ?? {}).length, 0)
    assert.equal(updated.state.history?.length, 2)

    const resolved = await pollRadar([inventory], updated.state, source('2026-08-14T02:00:00.000Z', false), new Date('2026-08-14T03:01:00.000Z'))
    assert.equal(resolved.events[0]?.change, 'resolved')
    assert.equal(resolved.analysisTasks.length, 0)
    assert.equal(resolved.state.pendingAnalysisTasks.length, 0)
    assert.equal(Object.keys(resolved.state.analysisResults ?? {}).length, 0)
    assert.equal(resolved.state.history?.length, 3)
    assert.deepEqual(resolved.state.history?.map(event => event.change), ['new', 'updated', 'resolved'])
  })

  it('reopens analysis when an advisory later publishes its first fixed version', async () => {
    const first = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', true, []),
      new Date('2026-08-14T01:01:00.000Z'),
    )
    assert.equal(first.events[0]?.change, 'new')
    assert.deepEqual(first.events[0]?.kind === 'vulnerability' ? first.events[0].advisory.fixedVersions : undefined, [])

    const unchanged = await pollRadar(
      [inventory],
      first.state,
      source('2026-08-14T01:00:00.000Z', true, []),
      new Date('2026-08-14T02:01:00.000Z'),
    )
    assert.equal(unchanged.events.length, 0)

    const fixed = await pollRadar(
      [inventory],
      unchanged.state,
      source('2026-08-15T01:00:00.000Z', true, ['3.0.0']),
      new Date('2026-08-15T01:01:00.000Z'),
    )
    assert.equal(fixed.events.length, 1)
    assert.equal(fixed.events[0]?.change, 'updated')
    assert.deepEqual(fixed.events[0]?.kind === 'vulnerability' ? fixed.events[0].advisory.fixedVersions : undefined, ['3.0.0'])
    assert.equal(fixed.analysisTasks.length, 1)
    assert.equal(fixed.state.pendingAnalysisTasks[0]?.event.change, 'updated')
    assert.deepEqual(fixed.state.history?.map(event => event.change), ['new', 'updated'])
  })

  it('deduplicates and bounds the durable transition history', async () => {
    const first = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T01:01:00.000Z'),
    )
    const seed = first.events[0]
    assert.ok(seed !== undefined)
    const state = first.state
    state.history = Array.from({ length: 1_001 }, (_, index) => ({
      ...structuredClone(seed),
      id: `event-history-${index}`,
      detectedAt: new Date(index * 1_000).toISOString(),
    }))
    const next = await pollRadar(
      [inventory],
      state,
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-14T02:01:00.000Z'),
    )
    assert.equal(next.state.history?.length, 1_000)
    assert.equal(new Set(next.state.history?.map(event => event.id)).size, 1_000)
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

  it('monitors the exact DSH executable package as a host-runtime release stream', async () => {
    const dshInventory = structuredClone(inventory)
    dshInventory.plugins[0]!.graph.hostRuntime = {
      source: 'dsh-process',
      resolvedNodes: 3,
      package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
    }
    const releases: ReleaseSource = {
      async query(packages) {
        const installed = packages.find(item => item.name === '@deepseek-ai/dsh')
        assert.ok(installed)
        assert.equal(packages.some(item => item.name === 'plugin'), true)
        return new Map([['npm:@deepseek-ai/dsh@0.1.0-rc.6', {
          installed,
          latestVersion: '0.1.0-rc.7',
          previous: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
          candidate: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' },
        }]])
      },
    }
    const result = await pollRadar(
      [dshInventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z', false),
      new Date('2026-08-16T01:00:00.000Z'),
      releases,
    )
    const event = result.events.find(item => item.kind === 'compatibility')
    assert.ok(event?.kind === 'compatibility')
    assert.equal(event.installed.name, '@deepseek-ai/dsh')
    assert.equal(event.candidate.version, '0.1.0-rc.7')
    assert.equal(event.plugin.name, 'plugin')
    assert.equal(event.signals.some(signal => signal.code === 'dsh-developer-preview-change'), true)
    assert.equal(result.releasePackagesQueried, 2)
  })

  it('alerts on a DSH executable vulnerability without inventing a plugin dependency edge', async () => {
    const dshInventory = structuredClone(inventory)
    dshInventory.plugins[0]!.graph.hostRuntime = {
      source: 'dsh-process',
      resolvedNodes: 3,
      package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
    }
    const advisory: AdvisoryMatch = {
      package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
      advisory: {
        id: 'GHSA-dsh-core-demo',
        aliases: [],
        summary: 'The DSH executable is affected.',
        details: 'A deterministic test advisory for the DSH host boundary.',
        severity: 'high',
        modified: '2026-08-16T01:00:00.000Z',
        fixedVersions: ['0.1.0-rc.7'],
        references: [],
      },
    }
    const result = await pollRadar(
      [dshInventory],
      emptyRadarState(),
      {
        async query(packages) {
          return new Map(packages.map(item => [
            packageKey(item),
            item.name === '@deepseek-ai/dsh' && item.version === '0.1.0-rc.6' ? [advisory] : [],
          ]))
        },
      },
      new Date('2026-08-16T01:00:00.000Z'),
    )
    const event = result.events.find(item => item.kind === 'vulnerability')
    assert.ok(event?.kind === 'vulnerability')
    assert.equal(event.affected.name, '@deepseek-ai/dsh')
    assert.deepEqual(event.affectedSources, ['dsh-host'])
    assert.deepEqual(event.paths, [[{
      ecosystem: 'npm',
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.6',
    }]])
    assert.equal(result.packagesQueried, 4)
  })

  it('coalesces one shared DSH host finding across plugin roots and keeps paths deterministic', async () => {
    const multiPluginInventory = structuredClone(inventory)
    const secondPlugin = structuredClone(inventory.plugins[0]!)
    secondPlugin.package = { ecosystem: 'npm', name: 'plugin-two', version: '1.0.0' }
    secondPlugin.graph = {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'plugin-two',
      nodes: [
        { id: 'plugin-two', name: 'plugin-two', version: '1.0.0' },
        { id: 'shared-parser', name: 'parser', version: '2.9.0', source: 'dsh-host' },
      ],
      edges: [{ from: 'plugin-two', to: 'shared-parser', kind: 'runtime' }],
    }
    multiPluginInventory.plugins.push(secondPlugin)

    const first = await pollRadar(
      [multiPluginInventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T01:01:00.000Z'),
    )
    assert.equal(first.events.length, 1)
    assert.equal(first.analysisTasks.length, 1)
    assert.equal(Object.keys(first.state.activeVulnerabilities).length, 1)
    const event = first.events[0]
    assert.ok(event?.kind === 'vulnerability')
    assert.deepEqual(event.affectedPlugins?.map(packageKey), [
      'npm:plugin-two@1.0.0',
      'npm:plugin@1.0.0',
    ])
    assert.deepEqual(event.paths.map(path => path.map(packageKey)), [
      ['npm:plugin-two@1.0.0', 'npm:parser@2.9.0'],
      ['npm:plugin@1.0.0', 'npm:logger@4.0.2', 'npm:parser@2.9.0'],
    ])

    const reordered = structuredClone(multiPluginInventory)
    reordered.plugins.reverse()
    const stable = await pollRadar(
      [reordered],
      first.state,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T01:31:00.000Z'),
    )
    assert.equal(stable.events.length, 0)
  })

  it('migrates legacy per-plugin DSH host keys without emitting a fake resolution', async () => {
    const single = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T01:01:00.000Z'),
    )
    const legacy = structuredClone(single.state)
    const currentEntry = Object.values(legacy.activeVulnerabilities)[0]
    assert.ok(currentEntry)
    const legacyKey = [
      inventory.project.id,
      'npm:plugin@1.0.0',
      'npm:parser@2.9.0',
      'GHSA-demo',
    ].join('\0')
    const legacyEvent = {
      ...currentEntry.event,
      id: 'event-legacy-host',
      incidentId: 'incident-legacy-host',
    }
    delete legacy.activeVulnerabilities[Object.keys(legacy.activeVulnerabilities)[0]!]
    legacy.activeVulnerabilities[legacyKey] = { key: legacyKey, event: legacyEvent }
    legacy.pendingAnalysisTasks = legacy.pendingAnalysisTasks.map(task => ({
      ...task,
      id: 'analysis-legacy-host',
      event: legacyEvent,
    }))

    const multiPluginInventory = structuredClone(inventory)
    const secondPlugin = structuredClone(inventory.plugins[0]!)
    secondPlugin.package = { ecosystem: 'npm', name: 'plugin-two', version: '1.0.0' }
    secondPlugin.graph = {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'plugin-two',
      nodes: [
        { id: 'plugin-two', name: 'plugin-two', version: '1.0.0' },
        { id: 'shared-parser', name: 'parser', version: '2.9.0', source: 'dsh-host' },
      ],
      edges: [{ from: 'plugin-two', to: 'shared-parser', kind: 'runtime' }],
    }
    multiPluginInventory.plugins.push(secondPlugin)

    const result = await pollRadar(
      [multiPluginInventory],
      legacy,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T02:01:00.000Z'),
    )
    assert.deepEqual(result.events.map(event => event.change), ['updated'])
    assert.notEqual(result.events[0]?.incidentId, legacyEvent.incidentId)
    assert.equal(Object.keys(result.state.activeVulnerabilities).length, 1)
    assert.equal(Object.keys(result.state.activeVulnerabilities)[0]?.includes('\0dsh-host\0'), true)
    assert.equal(result.state.pendingAnalysisTasks.length, 1)
    assert.notEqual(result.state.pendingAnalysisTasks[0]?.event.incidentId, legacyEvent.incidentId)
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

  it('blocks a candidate whose transitive dependency graph contains a known vulnerability', async () => {
    let queryCount = 0
    const advisory = {
      id: 'GHSA-transitive-candidate',
      aliases: [],
      summary: 'Candidate parser vulnerability',
      details: 'The candidate graph contains a vulnerable parser.',
      severity: 'high' as const,
      modified: '2026-08-14T04:00:00.000Z',
      fixedVersions: ['3.0.0'],
      references: [],
    }
    const advisories: AdvisorySource = {
      async query(packages) {
        queryCount += 1
        const result = new Map(packages.map(item => [packageKey(item), [] as AdvisoryMatch[]]))
        if (packages.some(item => item.name === 'parser' && item.version === '2.9.0')) {
          result.set('npm:parser@2.9.0', [{
            package: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
            advisory,
          }])
        }
        return result
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
    const candidateGraphs: CandidateDependencySource = {
      async query(packages) {
        return new Map(packages.map(candidate => {
          const parserVersion = candidate.version === '1.1.0' ? '2.9.0' : '3.0.0'
          const loggerVersion = candidate.version === '1.1.0' ? '4.1.0' : '4.2.0'
          const graph: DependencyGraph = {
            schema: 'upstream-radar.dependency-graph/v1alpha1',
            rootNodeId: 'plugin',
            nodes: [
              { id: 'plugin', name: 'plugin', version: candidate.version },
              { id: 'logger', name: 'logger', version: loggerVersion },
              { id: 'parser', name: 'parser', version: parserVersion },
            ],
            edges: [
              { from: 'plugin', to: 'logger', kind: 'runtime' },
              { from: 'logger', to: 'parser', kind: 'runtime' },
            ],
          }
          return [packageKey(candidate), { candidate, status: 'checked' as const, graph }]
        }))
      },
    }

    const profileInventory = structuredClone(inventory)
    profileInventory.plugins[0]!.graph.nodes.find(node => node.name === 'parser')!.source = 'profile'

    const result = await pollRadar(
      [profileInventory],
      emptyRadarState(),
      advisories,
      new Date('2026-08-14T04:00:00.000Z'),
      releases,
      undefined,
      candidateGraphs,
    )
    const event = result.events.find(item => item.kind === 'compatibility')
    assert.ok(event?.kind === 'compatibility')
    assert.equal(event.upgradePath?.dependencyStatus, 'checked')
    assert.equal(event.upgradePath?.firstCandidate?.candidate.version, '1.2.0')
    assert.equal(event.upgradePath?.remediationCoverage, 'checked')
    assert.equal(event.upgradePath?.firstCandidateRemovingAllPaths?.candidate.version, '1.2.0')
    assert.equal(event.upgradePath?.firstCandidateRemovingAllPaths?.vulnerabilityRemediation?.[0]?.status, 'removed')
    assert.ok(event.upgradePath?.blocked.some(item => item.candidate.version === '1.1.0'
      && item.signals.some(signal => signal.code === 'candidate-dependency-vulnerability')))
    assert.deepEqual(event.upgradePath?.blocked[0]?.dependencyCheck?.findings[0]?.paths[0]?.map(item => `${item.name}@${item.version}`), [
      'plugin@1.1.0',
      'logger@4.1.0',
      'parser@2.9.0',
    ])
    assert.equal(queryCount, 3)
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

  it('merges one advisory reported by OSV and GitHub without a duplicate incident', async () => {
    const githubAdvisories: AdvisorySource = {
      async query(packages) {
        const results = new Map(packages.map(item => [packageKey(item), [] as AdvisoryMatch[]]))
        results.set('npm:parser@2.9.0', [{
          package: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
          advisory: {
            id: 'GHSA-github-copy',
            aliases: ['CVE-2026-1234'],
            summary: 'Parser issue from the GitHub advisory feed',
            details: 'The second source describes the same affected parser.',
            severity: 'medium',
            modified: '2026-08-14T03:00:00.000Z',
            fixedVersions: ['3.1.0'],
            references: ['https://github.com/advisories/GHSA-github-copy'],
          },
        }])
        return results
      },
    }
    const result = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T02:00:00.000Z'),
      new Date('2026-08-14T03:01:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{ name: 'github-advisories', source: githubAdvisories }],
    )
    const events = result.events.filter(event => event.kind === 'vulnerability')
    assert.equal(events.length, 1)
    const event = events[0]
    assert.ok(event?.kind === 'vulnerability')
    assert.equal(event.advisory.id, 'GHSA-demo')
    assert.deepEqual(event.advisory.aliases, ['CVE-2026-1234', 'GHSA-github-copy'])
    assert.deepEqual(event.advisory.fixedVersions, ['3.0.0', '3.1.0'])
    assert.deepEqual(event.advisory.sources, ['osv', 'github-advisories'])
    assert.deepEqual(event.advisory.conflicts, [
      {
        field: 'severity',
        claims: [
          { source: 'osv', value: 'high' },
          { source: 'github-advisories', value: 'medium' },
        ],
      },
      {
        field: 'fixed-versions',
        claims: [
          { source: 'osv', value: '3.0.0' },
          { source: 'github-advisories', value: '3.1.0' },
        ],
      },
    ])
    assert.equal(result.sourceErrors.length, 0)
    assert.equal(result.state.sourceHealth?.osv?.consecutiveFailures, 0)
    assert.equal(result.state.sourceHealth?.['github-advisories']?.consecutiveFailures, 0)
  })

  it('keeps the last confirmed advisory evidence during a partial source outage', async () => {
    const githubAdvisories: AdvisorySource = {
      async query(packages) {
        const results = new Map(packages.map(item => [packageKey(item), [] as AdvisoryMatch[]]))
        results.set('npm:parser@2.9.0', [{
          package: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
          advisory: {
            id: 'GHSA-github-copy',
            aliases: ['CVE-2026-1234'],
            summary: 'The same parser issue from GitHub.',
            details: 'GitHub independently confirms the parser issue.',
            severity: 'medium',
            modified: '2026-08-14T03:00:00.000Z',
            fixedVersions: ['3.1.0'],
            references: ['https://github.com/advisories/GHSA-github-copy'],
          },
        }])
        return results
      },
    }
    const initial = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T02:00:00.000Z'),
      new Date('2026-08-14T03:01:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{ name: 'github-advisories', source: githubAdvisories }],
    )
    const initialEvent = initial.events.find(event => event.kind === 'vulnerability')
    assert.ok(initialEvent?.kind === 'vulnerability')

    const outage = await pollRadar(
      [inventory],
      initial.state,
      source('2026-08-14T02:00:00.000Z'),
      new Date('2026-08-14T03:31:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{
        name: 'github-advisories',
        source: { async query() { throw new Error('GitHub advisory timeout') } },
      }],
    )
    assert.equal(outage.events.filter(event => event.kind === 'vulnerability').length, 0)
    const active = Object.values(outage.state.activeVulnerabilities)[0]?.event
    assert.ok(active?.kind === 'vulnerability')
    assert.equal(active.incidentId, initialEvent.incidentId)
    assert.deepEqual(active.advisory.sources, ['osv', 'github-advisories'])
    assert.deepEqual(active.advisory.fixedVersions, ['3.0.0', '3.1.0'])
  })

  it('attaches KEV and EPSS signals, then preserves them when one enrichment source is unavailable', async () => {
    const healthyThreatSources: ThreatIntelSourceBinding[] = [
      {
        name: 'cisa-kev' as const,
        source: {
          async query(advisories: readonly VulnerabilityAdvisory[]): Promise<Map<string, AdvisoryRiskSignals>> {
            return new Map(advisories.map(advisory => [advisory.id, {
              cisaKev: { knownExploited: true as const, dateAdded: '2026-08-15' },
            } satisfies AdvisoryRiskSignals]))
          },
        },
      },
      {
        name: 'epss' as const,
        source: {
          async query(advisories: readonly VulnerabilityAdvisory[]): Promise<Map<string, AdvisoryRiskSignals>> {
            return new Map(advisories.map(advisory => [advisory.id, {
              epss: { score: 0.97224, percentile: 0.99999, date: '2026-08-16' },
            } satisfies AdvisoryRiskSignals]))
          },
        },
      },
    ]
    const initial = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T02:00:00.000Z'),
      new Date('2026-08-16T01:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      [],
      healthyThreatSources,
    )
    const first = initial.events.find(event => event.kind === 'vulnerability')
    assert.ok(first?.kind === 'vulnerability')
    assert.deepEqual(first.advisory.riskSignals, {
      cisaKev: { knownExploited: true, dateAdded: '2026-08-15' },
      epss: { score: 0.97224, percentile: 0.99999, date: '2026-08-16' },
    })
    assert.equal(initial.state.sourceHealth?.['cisa-kev']?.consecutiveFailures, 0)
    assert.equal(initial.state.sourceHealth?.epss?.consecutiveFailures, 0)

    const outage = await pollRadar(
      [inventory],
      initial.state,
      source('2026-08-14T02:00:00.000Z'),
      new Date('2026-08-16T02:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      [],
      [
        { name: 'cisa-kev', source: { async query() { throw new Error('CISA KEV timeout') } } },
        healthyThreatSources[1]!,
      ],
    )
    assert.equal(outage.events.filter(event => event.kind === 'vulnerability').length, 0)
    const active = Object.values(outage.state.activeVulnerabilities)[0]?.event
    assert.ok(active?.kind === 'vulnerability')
    assert.deepEqual(active.advisory.riskSignals, first.advisory.riskSignals)
    assert.deepEqual(outage.sourceErrors, [{ source: 'cisa-kev', message: 'CISA KEV timeout' }])
    assert.equal(outage.state.sourceHealth?.['cisa-kev']?.consecutiveFailures, 1)
  })

  it('keeps the confirmed finding during a GitHub outage and resolves only source health on recovery', async () => {
    const githubUnavailable: AdvisorySource = {
      async query() {
        throw new Error('GitHub advisory timeout')
      },
    }
    const seeded = await pollRadar(
      [inventory],
      emptyRadarState(),
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T04:00:00.000Z'),
    )
    const firstFailure = await pollRadar(
      [inventory],
      seeded.state,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T04:30:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{ name: 'github-advisories', source: githubUnavailable }],
    )
    const secondFailure = await pollRadar(
      [inventory],
      firstFailure.state,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T05:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{ name: 'github-advisories', source: githubUnavailable }],
    )
    const thirdFailure = await pollRadar(
      [inventory],
      secondFailure.state,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T05:30:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{ name: 'github-advisories', source: githubUnavailable }],
    )
    assert.equal(Object.keys(thirdFailure.state.activeVulnerabilities).length, 1)
    assert.equal(thirdFailure.events.filter(event => event.kind === 'vulnerability').length, 0)
    assert.equal(thirdFailure.state.sourceHealth?.['github-advisories']?.consecutiveFailures, 3)
    assert.equal(thirdFailure.events.some(event => event.kind === 'source-health' && event.change === 'new'), true)
    assert.deepEqual(thirdFailure.sourceErrors, [{ source: 'github-advisories', message: 'GitHub advisory timeout' }])

    const recovered = await pollRadar(
      [inventory],
      thirdFailure.state,
      source('2026-08-14T01:00:00.000Z'),
      new Date('2026-08-14T06:00:00.000Z'),
      undefined,
      undefined,
      undefined,
      [{
        name: 'github-advisories',
        source: {
          async query(packages) {
            return new Map(packages.map(item => [packageKey(item), [] as AdvisoryMatch[]]))
          },
        },
      }],
    )
    assert.equal(Object.keys(recovered.state.activeVulnerabilities).length, 1)
    assert.equal(recovered.events.some(event => event.kind === 'vulnerability' && event.change === 'resolved'), false)
    assert.equal(recovered.events.some(event => event.kind === 'source-health' && event.change === 'resolved'), true)
    assert.equal(recovered.state.sourceHealth?.['github-advisories']?.consecutiveFailures, 0)
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
