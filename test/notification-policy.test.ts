import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countPolicyHeldAnalysisTasks,
  createNotificationPolicyMap,
  decideRadarNotification,
  filterNotifiableRadarEvents,
} from '../src/notification-policy.js'
import { createAnalysisTask } from '../src/dsh-analysis.js'
import type { CompatibilityEvent, ProjectInventory, VulnerabilityEvent } from '../src/radar-types.js'

const vulnerability: VulnerabilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-vulnerability',
  incidentId: 'incident-vulnerability',
  kind: 'vulnerability',
  change: 'new',
  detectedAt: '2026-08-16T01:00:00.000Z',
  project: { id: 'project-a', name: 'Project A' },
  route: { channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
  paths: [[
    { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
    { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
  ]],
  advisory: {
    id: 'GHSA-demo',
    aliases: [],
    summary: 'Demo advisory',
    details: 'Demo details',
    severity: 'low',
    modified: '2026-08-16T01:00:00.000Z',
    fixedVersions: [],
    references: [],
  },
}

const compatibility: CompatibilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-compatibility',
  incidentId: 'incident-compatibility',
  kind: 'compatibility',
  change: 'new',
  detectedAt: '2026-08-16T01:00:00.000Z',
  project: { id: 'project-a', name: 'Project A' },
  route: { channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  installed: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
  candidate: { ecosystem: 'npm', name: 'plugin', version: '2.0.0' },
  signals: [{ code: 'major', confidence: 'strong', summary: 'Major update.' }],
}

const inventory: ProjectInventory = {
  schema: 'upstream-radar.inventory/v1alpha1',
  project: { id: 'project-a', name: 'Project A' },
  notificationPolicy: {
    minimumSeverity: 'medium',
    quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
  },
  plugins: [{
    package: { ecosystem: 'npm', name: 'plugin', version: '1.0.0' },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'plugin',
      nodes: [{ id: 'plugin', name: 'plugin', version: '1.0.0' }],
      edges: [],
    },
  }],
}

describe('notification policy', () => {
  it('holds lower-severity vulnerability tasks while preserving critical alerts', () => {
    const policy = { minimumSeverity: 'medium' as const }
    assert.deepEqual(decideRadarNotification(vulnerability, policy), {
      deliver: false,
      reasons: ['below-minimum-severity'],
    })
    const critical = structuredClone(vulnerability)
    critical.advisory.severity = 'critical'
    assert.deepEqual(decideRadarNotification(critical, { minimumSeverity: 'critical' }), {
      deliver: true,
      reasons: [],
    })
    const malware = structuredClone(vulnerability)
    malware.kind = 'malware'
    assert.deepEqual(decideRadarNotification(malware, {
      minimumSeverity: 'critical',
      quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
    }), { deliver: true, reasons: [] })
  })

  it('holds ordinary notices across a quiet window, including a window crossing midnight', () => {
    const policy = { quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' } }
    assert.equal(decideRadarNotification(compatibility, policy, new Date('2026-08-16T15:30:00.000Z')).deliver, false)
    assert.equal(decideRadarNotification(compatibility, policy, new Date('2026-08-16T23:00:00.000Z')).deliver, false)
    assert.equal(decideRadarNotification(compatibility, policy, new Date('2026-08-16T02:00:00.000Z')).deliver, true)
  })

  it('maps policies per project and counts held tasks without removing them', () => {
    const policies = createNotificationPolicyMap([inventory])
    const tasks = [createAnalysisTask(vulnerability), createAnalysisTask(compatibility)]
    assert.equal(countPolicyHeldAnalysisTasks(tasks, policies, new Date('2026-08-16T02:00:00.000Z')), 1)
    assert.deepEqual(filterNotifiableRadarEvents(
      [vulnerability, compatibility],
      policies,
      new Date('2026-08-16T02:00:00.000Z'),
    ), [compatibility])
  })

  it('rejects an invalid decision time', () => {
    assert.throws(
      () => decideRadarNotification(compatibility, {
        quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
      }, new Date(Number.NaN)),
      /notification policy time is invalid/,
    )
  })
})
