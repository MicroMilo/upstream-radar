import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderRadarEvent } from '../src/radar-render.js'
import type { CompatibilityEvent, VulnerabilityEvent } from '../src/radar-types.js'

describe('Radar event rendering', () => {
  it('explains whether an affected package comes from the DSH host runtime', () => {
    const event: VulnerabilityEvent = {
      schema: 'upstream-radar.event/v1alpha1',
      id: 'event-1',
      incidentId: 'incident-1',
      kind: 'vulnerability',
      change: 'new',
      detectedAt: '2026-08-16T01:00:00.000Z',
      project: { id: 'demo', name: 'Demo' },
      route: { channels: ['stdout'] },
      plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      affected: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' },
      affectedSources: ['dsh-host', 'profile'],
      paths: [[
        { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
        { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' },
      ]],
      advisory: {
        id: 'GHSA-demo',
        aliases: [],
        summary: 'Demo advisory',
        details: 'Demo details',
        severity: 'high',
        modified: '2026-08-16T01:00:00.000Z',
        fixedVersions: ['0.2.0'],
        references: [],
        sources: ['osv', 'github-advisories'],
        conflicts: [{
          field: 'fixed-versions',
          claims: [
            { source: 'osv', value: '0.2.0' },
            { source: 'github-advisories', value: '0.3.0' },
          ],
        }],
        riskSignals: {
          cisaKev: { knownExploited: true, dateAdded: '2026-08-15' },
          epss: { score: 0.97224, percentile: 0.99999, date: '2026-08-16' },
        },
      },
    }

    const output = renderRadarEvent(event)
    assert.match(output, /Origin: plugin profile \+ DSH host runtime/)
    assert.match(output, /Sources: OSV \+ GitHub Advisory Database/)
    assert.match(output, /Source conflict: fixed versions — OSV=0\.2\.0; GitHub Advisory Database=0\.3\.0/)
    assert.match(output, /Threat signal: CISA KEV lists this CVE as exploited in the wild\./)
    assert.match(output, /FIRST EPSS estimated exploitation probability: 97\.2% \(percentile 100\.0%\)/)
    assert.match(output, /Next: Review @deepseek-ai\/dsh-agent@0\.1\.0-rc\.6 fixed version\(s\) 0\.2\.0 with the DSH Agent before changing the plugin\./)
  })

  it('labels a DSH-core finding that has no plugin dependency edge', () => {
    const event: VulnerabilityEvent = {
      schema: 'upstream-radar.event/v1alpha1',
      id: 'event-dsh-core',
      incidentId: 'incident-dsh-core',
      kind: 'vulnerability',
      change: 'new',
      detectedAt: '2026-08-16T01:00:00.000Z',
      project: { id: 'demo', name: 'Demo' },
      route: { channels: ['stdout'] },
      plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      affectedPlugins: [
        { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
        { ecosystem: 'npm', name: 'second-plugin', version: '1.0.0' },
      ],
      affected: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
      affectedSources: ['dsh-host'],
      paths: [[{ ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }]],
      advisory: {
        id: 'GHSA-dsh-core-demo',
        aliases: [],
        summary: 'DSH core demo advisory',
        details: 'Demo details',
        severity: 'high',
        modified: '2026-08-16T01:00:00.000Z',
        fixedVersions: ['0.1.0-rc.7'],
        references: [],
      },
    }
    const output = renderRadarEvent(event)
    assert.match(output, /Plugins: demo-plugin@1\.0\.0, second-plugin@1\.0\.0/)
    assert.match(output, /Scope: shared DSH host runtime \(one event covers these plugins\)/)
    assert.match(output, /Path note: this one-node path is the exact DSH host-runtime boundary, not a plugin dependency edge\./)
  })

  it('labels a transitive finding that crosses the DSH host boundary', () => {
    const event: VulnerabilityEvent = {
      schema: 'upstream-radar.event/v1alpha1',
      id: 'event-dsh-transitive',
      incidentId: 'incident-dsh-transitive',
      kind: 'vulnerability',
      change: 'new',
      detectedAt: '2026-08-16T01:00:00.000Z',
      project: { id: 'demo', name: 'Demo' },
      route: { channels: ['stdout'] },
      plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      affected: { ecosystem: 'npm', name: 'host-parser', version: '2.0.0' },
      affectedSources: ['dsh-host'],
      paths: [[
        { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
        { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
        { ecosystem: 'npm', name: 'host-parser', version: '2.0.0' },
      ]],
      advisory: {
        id: 'GHSA-dsh-transitive-demo',
        aliases: [],
        summary: 'DSH host dependency demo advisory',
        details: 'Demo details',
        severity: 'high',
        modified: '2026-08-16T01:00:00.000Z',
        fixedVersions: ['3.0.0'],
        references: [],
      },
    }
    const output = renderRadarEvent(event)
    assert.match(output, /Path note: this finding crosses the shared DSH host-runtime boundary; the path does not mean the plugin declared every host package directly\./)
  })

  it('renders a top-level candidate that removes all checked vulnerability paths', () => {
    const candidate = {
      candidate: { ecosystem: 'npm' as const, name: 'demo-plugin', version: '1.3.0' },
      signals: [],
      vulnerabilityRemediation: [{
        incidentId: 'incident-parser',
        advisoryId: 'GHSA-parser',
        affected: { ecosystem: 'npm' as const, name: 'parser', version: '2.9.0' },
        status: 'removed' as const,
        reason: 'The complete candidate graph has no matching finding.',
      }],
    }
    const event: CompatibilityEvent = {
      schema: 'upstream-radar.event/v1alpha1',
      id: 'event-compatibility',
      incidentId: 'incident-compatibility',
      kind: 'compatibility',
      change: 'new',
      detectedAt: '2026-08-16T01:00:00.000Z',
      project: { id: 'demo', name: 'Demo' },
      route: { channels: ['stdout'] },
      plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      installed: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      candidate: { ecosystem: 'npm', name: 'demo-plugin', version: '2.0.0' },
      signals: [{ code: 'candidate', confidence: 'needs-analysis', summary: 'Candidate update.' }],
      upgradePath: {
        evaluated: 2,
        blockedCount: 0,
        vulnerabilityStatus: 'checked',
        dependencyStatus: 'checked',
        remediationCoverage: 'checked',
        firstCandidate: candidate,
        firstCandidateRemovingAllPaths: candidate,
        blocked: [],
      },
    }

    const output = renderRadarEvent(event)
    assert.match(output, /Vulnerability remediation check: complete/)
    assert.match(output, /First checked candidate removing all known vulnerability paths: demo-plugin@1\.3\.0/)
    assert.match(output, /Next: Ask the DSH Agent to inspect project impact before applying demo-plugin@1\.3\.0; it removes all checked vulnerability paths\./)
  })
})
