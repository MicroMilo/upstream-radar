import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderRadarEvent } from '../src/radar-render.js'
import type { VulnerabilityEvent } from '../src/radar-types.js'

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
      },
    }

    const output = renderRadarEvent(event)
    assert.match(output, /Origin: plugin profile \+ DSH host runtime/)
    assert.match(output, /Next: Review @deepseek-ai\/dsh-agent@0\.1\.0-rc\.6 fixed version\(s\) 0\.2\.0 with the DSH Agent before changing the plugin\./)
  })
})
