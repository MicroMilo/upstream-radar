import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import { createRadarNext, createRadarStatus, renderRadarNext, renderRadarStatus } from '../src/radar-status.js'
import { emptyRadarState } from '../src/radar.js'
import type { CompatibilityEvent, RadarConfig, SourceHealthEvent, VulnerabilityEvent } from '../src/radar-types.js'

const config: RadarConfig = {
  schema: 'upstream-radar.radar-config/v1alpha1',
  projects: [{
    schema: 'upstream-radar.inventory/v1alpha1',
    project: { id: 'demo', name: 'Demo project' },
    plugins: [{
      package: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      graph: {
        schema: 'upstream-radar.dependency-graph/v1alpha1',
        rootNodeId: 'demo-plugin',
        nodes: [{ id: 'demo-plugin', name: 'demo-plugin', version: '1.0.0' }],
        edges: [],
      },
    }],
  }],
}

const vulnerabilityEvent: VulnerabilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-vulnerability',
  incidentId: 'incident-vulnerability',
  kind: 'vulnerability',
  change: 'new',
  detectedAt: '2026-08-16T01:00:00.000Z',
  project: { id: 'demo', name: 'Demo project' },
  route: { channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
  paths: [[
    { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
  ]],
  advisory: {
    id: 'GHSA-demo',
    aliases: [],
    summary: 'Demo advisory',
    details: 'Demo details',
    severity: 'high',
    modified: '2026-08-16T01:00:00.000Z',
    fixedVersions: ['3.0.0'],
    references: [],
  },
}

const compatibilityEvent: CompatibilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-compatibility',
  incidentId: 'incident-compatibility',
  kind: 'compatibility',
  change: 'new',
  detectedAt: '2026-08-16T01:00:00.000Z',
  project: { id: 'demo', name: 'Demo project' },
  route: { channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  installed: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  candidate: { ecosystem: 'npm', name: 'demo-plugin', version: '2.0.0' },
  signals: [{ code: 'breaking-version-boundary', confidence: 'strong', summary: 'Demo breaking update.' }],
}

const sourceHealthEvent: SourceHealthEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-source-health',
  incidentId: 'incident-source-health',
  kind: 'source-health',
  change: 'new',
  detectedAt: '2026-08-16T01:00:00.000Z',
  project: { id: 'demo', name: 'Demo project' },
  route: { channels: ['stdout'] },
  source: 'osv',
  status: 'degraded',
  failureCount: 3,
  lastAttemptedAt: '2026-08-16T01:00:00.000Z',
  error: 'OSV timeout',
}

describe('Radar status', () => {
  it('reports a clear first-run snapshot without state or network calls', () => {
    const report = createRadarStatus(config, emptyRadarState(), {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: false,
    })

    assert.equal(report.monitoring, 'not-started')
    assert.equal(report.coverage, 'complete')
    assert.equal(report.unresolvedDependencies, 0)
    assert.equal(report.dshHostDependenciesNotObserved, 0)
    assert.equal(report.dshHostRuntimePlanes, 0)
    assert.deepEqual(report.dshHostRuntimeSources, [])
    assert.equal(report.projects, 1)
    assert.equal(report.pluginBundles, 1)
    assert.equal(report.lastCheckedAt, undefined)
    assert.deepEqual(report.sources.map(source => source.status), ['not-run', 'not-run', 'not-run', 'not-run', 'not-run', 'not-run', 'not-run'])
    assert.match(renderRadarStatus(report), /No completed check is recorded yet/)
  })

  it('counts active incidents and distinguishes a failed source from a healthy run', () => {
    const state = emptyRadarState()
    state.sourceHealth = {
      osv: {
        lastAttemptedAt: '2026-08-16T01:00:00.000Z',
        lastSucceededAt: '2026-08-16T01:00:00.000Z',
        consecutiveFailures: 0,
      },
      'npm-releases': {
        lastAttemptedAt: '2026-08-16T01:01:00.000Z',
        consecutiveFailures: 2,
        lastError: 'temporary registry timeout',
      },
    }
    state.activeVulnerabilities = { vulnerability: { key: 'vulnerability', event: vulnerabilityEvent } }
    state.activeCompatibility = { compatibility: { key: 'compatibility', event: compatibilityEvent } }
    state.activeSourceHealth = { source: { key: 'source', event: sourceHealthEvent } }
    state.pendingAnalysisTasks.push({} as never)

    const report = createRadarStatus(config, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
    })

    assert.equal(report.monitoring, 'degraded')
    assert.equal(report.coverage, 'complete')
    assert.equal(report.lastCheckedAt, '2026-08-16T01:01:00.000Z')
    assert.equal(report.activeVulnerabilities, 1)
    assert.equal(report.activeCompatibility, 1)
    assert.equal(report.activeSourceHealth, 1)
    assert.equal(report.pendingAnalysisTasks, 1)
    assert.equal(report.activeIncidents.length, 3)
    assert.equal(report.activeIncidentOverflow, 0)
    assert.equal(report.sources.find(source => source.source === 'osv')?.status, 'healthy')
    assert.equal(report.sources.find(source => source.source === 'npm-releases')?.status, 'degraded')
    const rendered = renderRadarStatus(report)
    assert.match(rendered, /temporary registry timeout/)
    assert.match(rendered, /parser@2\.9\.0 is affected by GHSA-demo/)
    assert.match(rendered, /Next: run `upstream-radar task show \/tmp\/radar\.json\.state\.json`/)
  })

  it('shows policy-held tasks separately without hiding the active incident', () => {
    const policyConfig = structuredClone(config)
    policyConfig.projects[0]!.notificationPolicy = { minimumSeverity: 'critical' }
    const state = emptyRadarState()
    state.activeVulnerabilities = { vulnerability: { key: 'vulnerability', event: vulnerabilityEvent } }
    state.pendingAnalysisTasks.push(createAnalysisTask(vulnerabilityEvent))
    const report = createRadarStatus(policyConfig, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
      now: new Date('2026-08-16T02:00:00.000Z'),
    })

    assert.equal(report.pendingAnalysisTasks, 1)
    assert.equal(report.notificationPolicyHeldTasks, 1)
    const rendered = renderRadarStatus(report)
    assert.match(rendered, /Held by notification policy: 1/)
    assert.match(rendered, /parser@2\.9\.0 is affected by GHSA-demo/)
  })

  it('keeps a muted incident visible and exposes the resume command', () => {
    const state = emptyRadarState()
    state.activeVulnerabilities = { vulnerability: { key: 'vulnerability', event: vulnerabilityEvent } }
    state.incidentMutes = {
      [vulnerabilityEvent.incidentId]: {
        eventId: vulnerabilityEvent.id,
        mutedUntil: '2026-08-17T00:00:00.000Z',
      },
    }
    state.incidentTriage = {
      [vulnerabilityEvent.incidentId]: {
        eventId: vulnerabilityEvent.id,
        status: 'in-progress',
        owner: 'security-team',
        note: 'Trace the parser input.',
        dueAt: '2026-08-16T01:30:00.000Z',
        updatedAt: '2026-08-16T02:00:00.000Z',
      },
    }
    const report = createRadarStatus(config, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
      now: new Date('2026-08-16T02:00:00.000Z'),
    })
    assert.equal(report.activeIncidents[0]?.mutedUntil, '2026-08-17T00:00:00.000Z')
    assert.deepEqual(report.activeIncidents[0]?.followUp, state.incidentTriage[vulnerabilityEvent.incidentId])
    assert.match(renderRadarStatus(report), /Delivery: muted until 2026-08-17T00:00:00.000Z; active evidence remains visible/)
    assert.match(renderRadarStatus(report), /Follow-up: in progress; owner: security-team; note: Trace the parser input\.; due: 2026-08-16T01:30:00.000Z \(overdue\)/)
    assert.equal(report.activeIncidents[0]?.followUpOverdue, true)

    const next = createRadarNext(report, state)
    assert.match(next.unmuteCommand ?? '', /upstream-radar unmute .*incident-vulnerability/)
    assert.equal(next.triageCommand, undefined)
    assert.match(renderRadarNext(next), /To resume delivery: upstream-radar unmute/)
    assert.match(renderRadarNext(next), /Follow-up: in progress; owner: security-team; note: Trace the parser input\.; due: 2026-08-16T01:30:00.000Z \(overdue\)/)

    const newerState = structuredClone(state)
    const newerEvent: VulnerabilityEvent = {
      ...vulnerabilityEvent,
      id: 'event-vulnerability-updated',
      change: 'updated',
      detectedAt: '2026-08-16T03:00:00.000Z',
      advisory: { ...vulnerabilityEvent.advisory, modified: '2026-08-16T03:00:00.000Z' },
    }
    newerState.activeVulnerabilities = {
      vulnerability: { key: 'vulnerability', event: newerEvent },
    }
    const newerReport = createRadarStatus(config, newerState, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
      now: new Date('2026-08-16T03:00:00.000Z'),
    })
    assert.equal(newerReport.activeIncidents[0]?.followUp, undefined)
    const newerNext = createRadarNext(newerReport, newerState)
    assert.match(newerNext.triageCommand ?? '', /--status in-progress/)
    assert.match(renderRadarNext(newerNext), /Follow-up: open; record an owner\/status with:/)
  })

  it('marks a current follow-up due in the future without calling it overdue', () => {
    const state = emptyRadarState()
    state.activeVulnerabilities = { vulnerability: { key: 'vulnerability', event: vulnerabilityEvent } }
    state.incidentTriage = {
      [vulnerabilityEvent.incidentId]: {
        eventId: vulnerabilityEvent.id,
        status: 'in-progress',
        dueAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-16T02:00:00.000Z',
      },
    }
    const report = createRadarStatus(config, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
      now: new Date('2026-08-16T02:00:00.000Z'),
    })
    assert.equal(report.activeIncidents[0]?.followUpOverdue, undefined)
    assert.match(renderRadarStatus(report), /due: 2026-08-17T00:00:00.000Z(?! \(overdue\))/)
  })

  it('shows advisory sources and conflicts in the daily status summary', () => {
    const state = emptyRadarState()
    const event: VulnerabilityEvent = {
      ...vulnerabilityEvent,
      advisory: {
        ...vulnerabilityEvent.advisory,
        sources: ['osv', 'github-advisories'],
        conflicts: [{
          field: 'fixed-versions',
          claims: [
            { source: 'osv', value: '3.0.0' },
            { source: 'github-advisories', value: '3.1.0' },
          ],
        }],
      },
    }
    state.activeVulnerabilities = { vulnerability: { key: 'vulnerability', event } }
    const report = createRadarStatus(config, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
    })
    const rendered = renderRadarStatus(report)
    assert.match(rendered, /sources: OSV \+ GitHub Advisory Database/)
    assert.match(rendered, /source conflict: fixed versions/)
  })

  it('orders active incidents by exploitation evidence, EPSS, then severity', () => {
    const state = emptyRadarState()
    const knownExploited: VulnerabilityEvent = {
      ...vulnerabilityEvent,
      incidentId: 'incident-known-exploited',
      advisory: {
        ...vulnerabilityEvent.advisory,
        severity: 'low',
        riskSignals: {
          cisaKev: { knownExploited: true },
          epss: { score: 0.1, percentile: 0.7 },
        },
      },
    }
    const highEpss: VulnerabilityEvent = {
      ...vulnerabilityEvent,
      incidentId: 'incident-high-epss',
      advisory: {
        ...vulnerabilityEvent.advisory,
        severity: 'low',
        riskSignals: { epss: { score: 0.99, percentile: 0.99 } },
      },
    }
    const critical: VulnerabilityEvent = {
      ...vulnerabilityEvent,
      incidentId: 'incident-critical',
      advisory: { ...vulnerabilityEvent.advisory, severity: 'critical' },
    }
    state.activeVulnerabilities = {
      knownExploited: { key: knownExploited.incidentId, event: knownExploited },
      highEpss: { key: highEpss.incidentId, event: highEpss },
      critical: { key: critical.incidentId, event: critical },
    }

    const report = createRadarStatus(config, state, {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
    })

    assert.deepEqual(report.activeIncidents.map(incident => incident.incidentId), [
      'incident-known-exploited',
      'incident-high-epss',
      'incident-critical',
    ])
    assert.deepEqual(report.activeIncidents[0]?.triage, {
      severity: 'low',
      knownExploited: true,
      epssScore: 0.1,
      epssPercentile: 0.7,
    })
    const rendered = renderRadarStatus(report)
    assert.match(rendered, /Attention \(ordered by CISA KEV, EPSS, then severity\):/)
    assert.match(rendered, /Triage: CISA KEV known exploited; EPSS 10\.0%; severity low/)
  })

  it('does not treat absent optional platform packages as a required coverage gap', () => {
    const optionalConfig = structuredClone(config)
    const graph = optionalConfig.projects[0]?.plugins[0]?.graph
    assert.ok(graph)
    graph.hostRuntime = { source: 'dsh-profile-fallback', resolvedNodes: 22 }
    graph.unresolved = [{ from: graph.rootNodeId, name: 'native-addon-darwin', kind: 'optional', spec: '1.0.0' }]

    const report = createRadarStatus(optionalConfig, emptyRadarState(), {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: false,
    })

    assert.equal(report.coverage, 'complete')
    assert.equal(report.requiredUnresolvedDependencies, 0)
    assert.equal(report.optionalDependenciesNotInstalled, 1)
    assert.equal(report.dshHostDependenciesNotObserved, 0)
    assert.equal(report.dshHostRuntimePlanes, 1)
    assert.equal(report.dshHostRuntimePackages, 22)
    assert.deepEqual(report.dshHostRuntimeSources, ['dsh-profile-fallback'])
    assert.match(renderRadarStatus(report), /1 optional dependency not installed/)
    assert.match(renderRadarStatus(report), /22 packages observed \(profile fallback\)/)
  })

  it('labels host evidence discovered from the running DSH process', () => {
    const processConfig = structuredClone(config)
    const graph = processConfig.projects[0]?.plugins[0]?.graph
    assert.ok(graph)
    graph.hostRuntime = { source: 'dsh-process', resolvedNodes: 4 }

    const report = createRadarStatus(processConfig, emptyRadarState(), {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: true,
    })

    assert.deepEqual(report.dshHostRuntimeSources, ['dsh-process'])
    assert.match(renderRadarStatus(report), /4 packages observed \(running DSH process\)/)
  })

  it('calls out DSH host peers that are outside the captured profile graph', () => {
    const incompleteConfig = structuredClone(config)
    const graph = incompleteConfig.projects[0]?.plugins[0]?.graph
    assert.ok(graph)
    graph.unresolved = [
      { from: graph.rootNodeId, name: '@deepseek-ai/dsh-agent', kind: 'peer', spec: '^0.1.0' },
      { from: graph.rootNodeId, name: 'ordinary-peer', kind: 'peer', spec: '^1.0.0' },
    ]

    const report = createRadarStatus(incompleteConfig, emptyRadarState(), {
      configFile: '/tmp/radar.json',
      stateFile: '/tmp/radar.json.state.json',
      stateExists: false,
    })

    assert.equal(report.coverage, 'incomplete')
    assert.equal(report.requiredUnresolvedDependencies, 2)
    assert.equal(report.dshHostDependenciesNotObserved, 1)
    assert.match(renderRadarStatus(report), /1 DSH host dependency not observed/)
  })
})
