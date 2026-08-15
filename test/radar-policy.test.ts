import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyRadarState } from '../src/radar.js'
import { evaluateRadarPolicy, renderRadarPolicy } from '../src/radar-policy.js'
import type { CompatibilityEvent, VulnerabilityEvent } from '../src/radar-types.js'

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

function compatibilityEvent(incidentId: string, confidence: 'confirmed' | 'strong' | 'needs-analysis'): CompatibilityEvent {
  return {
    schema: 'upstream-radar.event/v1alpha1',
    id: `event-${incidentId}`,
    incidentId,
    kind: 'compatibility',
    change: 'new',
    detectedAt: '2026-08-16T01:00:00.000Z',
    project: { id: incidentId, name: `Project ${incidentId}` },
    route: { channels: ['stdout'] },
    plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    installed: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.5' },
    candidate: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.6' },
    signals: [{ code: 'dsh-peer-incompatible', confidence, summary: 'Candidate peer range excludes the installed DSH package.' }],
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

  it('can fail on deterministic compatibility changes without failing on analysis-only changes', () => {
    const state = emptyRadarState()
    state.activeCompatibility = {
      breaking: { key: 'breaking', event: compatibilityEvent('breaking', 'strong') },
      analysis: { key: 'analysis', event: compatibilityEvent('analysis', 'needs-analysis') },
    }

    const breaking = evaluateRadarPolicy(state, 'never', 'breaking')
    assert.equal(breaking.status, 'fail')
    assert.equal(breaking.compatibilityThreshold, 'breaking')
    assert.deepEqual(breaking.compatibilityMatches?.map(match => match.incidentId), ['breaking'])
    assert.match(renderRadarPolicy(breaking), /Compatibility policy: FAIL/)
    assert.match(renderRadarPolicy(breaking), /BREAKING.*dsh-peer-incompatible/)

    const any = evaluateRadarPolicy(state, 'never', 'any')
    assert.deepEqual(any.compatibilityMatches?.map(match => match.incidentId), ['analysis', 'breaking'])
  })
})
