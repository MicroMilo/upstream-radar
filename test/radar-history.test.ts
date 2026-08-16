import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRadarHistory, renderRadarHistory } from '../src/radar-history.js'
import { emptyRadarState } from '../src/radar.js'
import type { CompatibilityEvent, VulnerabilityEvent } from '../src/radar-types.js'

function vulnerability(change: VulnerabilityEvent['change'], detectedAt: string, id: string): VulnerabilityEvent {
  return {
    schema: 'upstream-radar.event/v1alpha1',
    id,
    incidentId: 'incident-parser',
    kind: 'vulnerability',
    change,
    detectedAt,
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
      modified: detectedAt,
      fixedVersions: ['3.0.0'],
      references: [],
    },
  }
}

function compatibility(): CompatibilityEvent {
  return {
    schema: 'upstream-radar.event/v1alpha1',
    id: 'event-compatibility',
    incidentId: 'incident-release',
    kind: 'compatibility',
    change: 'new',
    detectedAt: '2026-08-16T02:00:00.000Z',
    project: { id: 'demo', name: 'Demo project' },
    route: { channels: ['stdout'] },
    plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    installed: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    candidate: { ecosystem: 'npm', name: 'demo-plugin', version: '2.0.0' },
    signals: [{ code: 'major', confidence: 'strong', summary: 'Major version boundary.' }],
  }
}

describe('Radar history', () => {
  it('returns the newest transitions first and keeps resolved events', () => {
    const state = emptyRadarState()
    state.history = [
      vulnerability('new', '2026-08-16T01:00:00.000Z', 'event-new'),
      vulnerability('resolved', '2026-08-16T03:00:00.000Z', 'event-resolved'),
      compatibility(),
    ]
    const report = createRadarHistory(state, {
      configFile: '/tmp/config.json',
      stateFile: '/tmp/config.json.state.json',
      stateExists: true,
      limit: 2,
    })

    assert.equal(report.totalRecorded, 3)
    assert.deepEqual(report.events.map(event => event.id), ['event-resolved', 'event-compatibility'])
    const rendered = renderRadarHistory(report)
    assert.match(rendered, /Showing 2 of 3 recorded transition\(s\)/)
    assert.match(rendered, /RESOLVED\tvulnerability\tDemo project/)
    assert.match(rendered, /parser@2\.9\.0 \(GHSA-demo\)/)
    assert.match(rendered, /compatibility: demo-plugin@1\.0\.0 -> demo-plugin@2\.0\.0/)
  })

  it('renders an empty first-run ledger without requiring a state file', () => {
    const report = createRadarHistory(emptyRadarState(), {
      configFile: '/tmp/config.json',
      stateFile: '/tmp/config.json.state.json',
      stateExists: false,
      limit: 20,
    })
    assert.match(renderRadarHistory(report), /No recorded Radar events/)
  })

  it('keeps advisory evidence in the audit trail details', () => {
    const event = vulnerability('new', '2026-08-16T04:00:00.000Z', 'event-evidence')
    event.advisory.sources = ['osv', 'github-advisories']
    event.advisory.conflicts = [{
      field: 'fixed-versions',
      claims: [
        { source: 'osv', value: '3.0.0' },
        { source: 'github-advisories', value: '3.1.0' },
      ],
    }]
    const report = createRadarHistory({ ...emptyRadarState(), history: [event] }, {
      configFile: '/tmp/config.json',
      stateFile: '/tmp/config.json.state.json',
      stateExists: true,
      limit: 20,
    })
    const rendered = renderRadarHistory(report)
    assert.match(rendered, /sources: OSV \+ GitHub Advisory Database/)
    assert.match(rendered, /source conflict: fixed versions/)
  })
})
