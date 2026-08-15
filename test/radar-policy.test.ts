import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyRadarState } from '../src/radar.js'
import { evaluateRadarPolicy, renderRadarPolicy } from '../src/radar-policy.js'
import type { VulnerabilityEvent } from '../src/radar-types.js'

function event(
  incidentId: string,
  kind: VulnerabilityEvent['kind'],
  severity: VulnerabilityEvent['advisory']['severity'],
): VulnerabilityEvent {
  return {
    schema: 'upstream-radar.event/v1alpha1',
    id: `event-${incidentId}`,
    incidentId,
    kind,
    change: 'new',
    detectedAt: '2026-08-16T01:00:00.000Z',
    project: { id: incidentId, name: `Project ${incidentId}` },
    route: { channels: ['stdout'] },
    plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
    paths: [],
    advisory: {
      id: `GHSA-${incidentId}`,
      aliases: [],
      summary: 'Demo advisory',
      details: 'Demo details',
      severity,
      modified: '2026-08-16T01:00:00.000Z',
      fixedVersions: [],
      references: [],
    },
  }
}

describe('radar policy', () => {
  it('fails on active vulnerabilities at or above the selected severity', () => {
    const state = emptyRadarState()
    const high = event('high', 'vulnerability', 'high')
    const medium = event('medium', 'vulnerability', 'medium')
    const malware = event('malware', 'malware', 'unknown')
    state.activeVulnerabilities = {
      high: { key: 'high', event: high },
      medium: { key: 'medium', event: medium },
      malware: { key: 'malware', event: malware },
    }

    const result = evaluateRadarPolicy(state, 'high')
    assert.equal(result.status, 'fail')
    assert.deepEqual(result.matches.map(match => match.incidentId), ['malware', 'high'])
    assert.equal(result.matches[0]?.severity, 'critical')
    assert.match(renderRadarPolicy(result), /Policy: FAIL/)
    assert.match(renderRadarPolicy(result), /Project malware: parser@2\.9\.0/)
    assert.doesNotMatch(renderRadarPolicy(result), /Project medium/)
  })

  it('does not enforce a threshold when explicitly disabled', () => {
    const state = emptyRadarState()
    state.activeVulnerabilities = {
      high: { key: 'high', event: event('high', 'vulnerability', 'high') },
    }

    const result = evaluateRadarPolicy(state, 'never')
    assert.deepEqual(result, { threshold: 'never', status: 'pass', matches: [] })
    assert.equal(renderRadarPolicy(result), 'Policy: not enforced\n')
  })
})
