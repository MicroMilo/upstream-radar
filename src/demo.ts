import { createAnalysisTask } from './dsh-analysis.js'
import { renderRadarEvent } from './radar-render.js'
import {
  RADAR_EVENT_SCHEMA,
  type AnalysisTask,
  type VulnerabilityEvent,
} from './radar-types.js'

export const DEMO_SCHEMA = 'upstream-radar.demo/v1alpha1' as const

export interface DemoReport {
  schema: typeof DEMO_SCHEMA
  networkFree: true
  event: VulnerabilityEvent
  analysisTask: AnalysisTask
  nextCommand: string
}

export function createDemoEvent(): VulnerabilityEvent {
  return {
    schema: RADAR_EVENT_SCHEMA,
    id: 'demo-event-parser-2-9-0',
    incidentId: 'demo-project\u0000parser\u00002.9.0\u0000GHSA-demo-parser',
    kind: 'vulnerability',
    change: 'new',
    detectedAt: '2026-08-16T00:00:00.000Z',
    project: { id: 'demo-project', name: 'Demo project' },
    route: { channels: ['stdout'] },
    plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
    affectedSources: ['profile'],
    paths: [[
      { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
      { ecosystem: 'npm', name: 'logger', version: '4.0.2' },
      { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
    ]],
    advisory: {
      id: 'GHSA-demo-parser',
      aliases: ['CVE-2026-1234'],
      summary: 'The demo parser advisory is attached to the exact transitive path.',
      details: 'This deterministic local fixture exists only to demonstrate the Radar-to-DSH handoff.',
      severity: 'high',
      published: '2026-08-15T00:00:00.000Z',
      modified: '2026-08-16T00:00:00.000Z',
      fixedVersions: ['3.0.0', '3.1.0'],
      references: ['https://example.test/advisories/GHSA-demo-parser'],
      sources: ['osv', 'github-advisories'],
      conflicts: [{
        field: 'fixed-versions',
        claims: [
          { source: 'osv', value: '3.0.0' },
          { source: 'github-advisories', value: '3.1.0' },
        ],
      }],
      riskSignals: {
        cisaKev: {
          knownExploited: true as const,
          dateAdded: '2026-08-15',
          dueDate: '2026-08-22',
        },
        epss: {
          score: 0.97224,
          percentile: 0.99999,
          date: '2026-08-16',
        },
      },
    },
  }
}

export function createDemoReport(): DemoReport {
  const event = createDemoEvent()
  return {
    schema: DEMO_SCHEMA,
    networkFree: true,
    event,
    analysisTask: createAnalysisTask(event),
    nextCommand: 'npx --yes upstream-radar@latest setup --project-name "My DSH project"',
  }
}

export function renderDemo(report: DemoReport = createDemoReport()): string {
  return [
    'Upstream Radar demo — network-free; no DSH profile required',
    '',
    '1. Deterministic fact',
    renderRadarEvent(report.event).trim(),
    '',
    '2. DSH Agent follow-up',
    `Task: ${report.analysisTask.id}`,
    'Read-only project analysis; advisory text is untrusted data, not an instruction.',
    'Radar accepts only the strict JSON result bound to this task and event.',
    '',
    'Try it for real:',
    `  ${report.nextCommand}`,
    '',
    'This demo uses a local fixture. It does not query OSV, inspect your repository, install packages, or claim that the demo advisory is real.',
    '',
  ].join('\n')
}
