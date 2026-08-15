import { assessCompatibilityChange } from './compatibility.js'
import { emptyRadarState } from './radar.js'
import { evaluateRadarPolicy, type RadarCompatibilityFailThreshold } from './radar-policy.js'
import type {
  CompatibilityDependencyCheck,
  CompatibilityEvent,
  PackageManifestSnapshot,
  ProjectInventory,
} from './radar-types.js'

export const COMPATIBILITY_BENCHMARK_SCHEMA = 'upstream-radar.compatibility-benchmark/v1alpha1' as const

type BenchmarkOutcome = 'pass' | 'fail'

interface BenchmarkExpected {
  breaking: BenchmarkOutcome
  any: BenchmarkOutcome
}

interface BenchmarkCase {
  id: string
  title: string
  previous: PackageManifestSnapshot
  candidate: PackageManifestSnapshot
  releaseNotes?: string
  candidateDependencyCheck?: CompatibilityDependencyCheck
  expected: BenchmarkExpected
}

export interface CompatibilityBenchmarkCaseResult {
  id: string
  title: string
  event: boolean
  signals: Array<{ code: string; confidence: string }>
  actual: BenchmarkExpected
  expected: BenchmarkExpected
  passed: boolean
}

export interface CompatibilityBenchmarkReport {
  schema: typeof COMPATIBILITY_BENCHMARK_SCHEMA
  mode: 'offline-rules'
  cases: CompatibilityBenchmarkCaseResult[]
  summary: {
    total: number
    passed: number
    failed: number
  }
  boundary: string
}

const benchmarkInventory: ProjectInventory = {
  schema: 'upstream-radar.inventory/v1alpha1',
  project: {
    id: 'compatibility-benchmark',
    name: 'Compatibility benchmark',
    channels: ['stdout'],
  },
  environment: { nodeVersion: '22.18.0' },
  plugins: [{
    package: { ecosystem: 'npm', name: 'demo-dsh-plugin', version: '1.0.0' },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'demo-dsh-plugin',
      nodes: [
        { id: 'demo-dsh-plugin', name: 'demo-dsh-plugin', version: '1.0.0' },
        { id: 'dsh-agent', name: '@deepseek-ai/dsh-agent', version: '0.0.1-rc.5' },
        { id: 'dsh-invariants', name: '@deepseek-ai/dsh-invariants', version: '0.0.1-rc.5' },
      ],
      edges: [
        { from: 'demo-dsh-plugin', to: 'dsh-agent', kind: 'peer' },
        { from: 'demo-dsh-plugin', to: 'dsh-invariants', kind: 'peer' },
      ],
    },
  }],
}

const dependencyAdvisory = {
  id: 'GHSA-benchmark-transitive',
  aliases: [],
  summary: 'A transitive candidate dependency is vulnerable.',
  details: 'Synthetic benchmark evidence only.',
  severity: 'high' as const,
  modified: '2026-08-16T00:00:00.000Z',
  fixedVersions: ['3.0.0'],
  references: [],
}

const cases: readonly BenchmarkCase[] = [
  {
    id: 'safe-patch',
    title: 'patch with no structural change',
    previous: { name: 'demo-dsh-plugin', version: '1.0.0', main: './dist/index.js' },
    candidate: { name: 'demo-dsh-plugin', version: '1.0.1', main: './dist/index.js' },
    expected: { breaking: 'pass', any: 'pass' },
  },
  {
    id: 'analysis-only-entrypoint-change',
    title: 'entrypoint change needs project analysis',
    previous: { name: 'demo-dsh-plugin', version: '1.0.0', main: './dist/index.js' },
    candidate: { name: 'demo-dsh-plugin', version: '1.1.0', main: './dist/next.js' },
    expected: { breaking: 'pass', any: 'fail' },
  },
  {
    id: 'dsh-peer-incompatible',
    title: 'candidate excludes the installed DSH peer',
    previous: { name: '@deepseek-ai/dsh-agent', version: '0.0.1-rc.5' },
    candidate: {
      name: '@deepseek-ai/dsh-agent',
      version: '0.1.0-rc.6',
      peerDependencies: { '@deepseek-ai/dsh-invariants': '^0.1.0-rc.6' },
    },
    expected: { breaking: 'fail', any: 'fail' },
  },
  {
    id: 'publisher-breaking',
    title: 'publisher explicitly declares a breaking release',
    previous: { name: 'demo-dsh-plugin', version: '1.0.0', main: './dist/index.js' },
    candidate: { name: 'demo-dsh-plugin', version: '1.0.1', main: './dist/index.js' },
    releaseNotes: 'BREAKING CHANGE: the plugin now requires a new project session.',
    expected: { breaking: 'fail', any: 'fail' },
  },
  {
    id: 'candidate-transitive-vulnerability',
    title: 'candidate graph contains a confirmed vulnerability',
    previous: { name: 'demo-dsh-plugin', version: '1.0.0', main: './dist/index.js' },
    candidate: { name: 'demo-dsh-plugin', version: '1.0.1', main: './dist/index.js' },
    candidateDependencyCheck: {
      status: 'checked',
      nodeCount: 3,
      unresolvedCount: 0,
      findings: [{
        package: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
        advisory: dependencyAdvisory,
        paths: [[
          { ecosystem: 'npm', name: 'demo-dsh-plugin', version: '1.0.1' },
          { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
        ]],
      }],
    },
    expected: { breaking: 'fail', any: 'fail' },
  },
  {
    id: 'incomplete-candidate-graph',
    title: 'incomplete graph stays analysis-only under breaking gate',
    previous: { name: 'demo-dsh-plugin', version: '1.0.0', main: './dist/index.js' },
    candidate: { name: 'demo-dsh-plugin', version: '1.0.1', main: './dist/index.js' },
    candidateDependencyCheck: {
      status: 'incomplete',
      nodeCount: 3,
      unresolvedCount: 1,
      findings: [],
    },
    expected: { breaking: 'pass', any: 'fail' },
  },
]

function policyOutcome(event: CompatibilityEvent | undefined, threshold: RadarCompatibilityFailThreshold): BenchmarkOutcome {
  const state = emptyRadarState()
  if (event !== undefined) {
    state.activeCompatibility[event.incidentId] = { key: event.incidentId, event }
  }
  return evaluateRadarPolicy(state, 'never', threshold).status === 'fail' ? 'fail' : 'pass'
}

export function runCompatibilityBenchmark(): CompatibilityBenchmarkReport {
  const results = cases.map((item): CompatibilityBenchmarkCaseResult => {
    const event = assessCompatibilityChange(benchmarkInventory, {
      previous: item.previous,
      candidate: item.candidate,
      detectedAt: '2026-08-16T00:00:00.000Z',
      ...(item.releaseNotes === undefined ? {} : { releaseNotes: item.releaseNotes }),
      ...(item.candidateDependencyCheck === undefined ? {} : {
        candidateDependencyChecks: new Map([['npm:demo-dsh-plugin@1.0.1', item.candidateDependencyCheck]]),
        candidateDependencyStatus: 'checked' as const,
      }),
    })
    const actual = {
      breaking: policyOutcome(event, 'breaking'),
      any: policyOutcome(event, 'any'),
    }
    const passed = actual.breaking === item.expected.breaking && actual.any === item.expected.any
    return {
      id: item.id,
      title: item.title,
      event: event !== undefined,
      signals: event?.signals.map(signal => ({ code: signal.code, confidence: signal.confidence })) ?? [],
      actual,
      expected: item.expected,
      passed,
    }
  })
  const passed = results.filter(item => item.passed).length
  return {
    schema: COMPATIBILITY_BENCHMARK_SCHEMA,
    mode: 'offline-rules',
    cases: results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
    },
    boundary: 'This checks deterministic rule and gate behavior only. It does not load a plugin, run DSH, or prove runtime compatibility.',
  }
}

export function renderCompatibilityBenchmark(report: CompatibilityBenchmarkReport): string {
  const lines = [
    'Compatibility benchmark (offline rules; no network or plugin execution)',
    '',
  ]
  for (const item of report.cases) {
    const mark = item.passed ? 'PASS' : 'FAIL'
    lines.push(`${mark} ${item.id}: ${item.title} — breaking=${item.actual.breaking}, any=${item.actual.any}`)
    if (!item.passed) {
      lines.push(`  expected: breaking=${item.expected.breaking}, any=${item.expected.any}`)
    }
  }
  lines.push('', `Result: ${report.summary.passed}/${report.summary.total} benchmark contracts passed.`)
  lines.push(report.boundary)
  return `${lines.join('\n')}\n`
}
