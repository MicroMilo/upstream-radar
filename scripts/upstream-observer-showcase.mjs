import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const {
  OBSERVER_TARGETS_SCHEMA,
  emptyObservationState,
  runObserver,
} = await import('../dist/src/upstream-observer.js')
const { buildUpstreamDownstreamIR } = await import('../dist/src/upstream-alignment.js')
const { parseReverseDependencyIndex } = await import('../dist/src/dependency-index.js')

const target = {
  id: 'dsh-first-batch-routing',
  ecosystem: 'dsh',
  repository: 'deepseek-ai/deepseek-harness',
  ref: 'main',
  packageName: '@deepseek-ai/cordis',
  packagePath: 'packages/cordis/package.json',
  lockfile: 'pnpm-lock.yaml',
  lockfileType: 'pnpm',
}

const batchIndexPath = resolve(import.meta.dirname, '../examples/dsh/first-batch/reverse-dependency-index.json')
const reverseDependencyIndex = parseReverseDependencyIndex(JSON.parse(await readFile(batchIndexPath, 'utf8')), batchIndexPath)
const realDependency = reverseDependencyIndex.dependencies.find(item => (
  item.dependency.name === '@deepseek-ai/cordis' && item.dependents.length > 0
))
if (realDependency === undefined) throw new Error('first-batch reverse index has no real @deepseek-ai/cordis dependents')
const upstreamPackage = realDependency.dependency
const nextVersion = upstreamPackage.version === '4.0.1' ? '4.0.2' : `${upstreamPackage.version}.next`

function snapshot(commit, version, graphDigest) {
  const manifest = {
    name: upstreamPackage.name,
    version,
    main: './dist/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const packageObservation = {
    name: upstreamPackage.name,
    version,
    integrity: `sha512-${version}`,
  }
  const graph = {
    schema: 'upstream-radar.dependency-graph/v1alpha1',
    rootNodeId: 'root',
    nodes: [
      { id: 'root', name: upstreamPackage.name, version },
    ],
    edges: [],
    source: 'pnpm-lock',
    digest: graphDigest,
  }
  return {
    targetId: target.id,
    ecosystem: target.ecosystem,
    observedAt: '2026-08-17T00:00:00.000Z',
    source: {
      repository: target.repository,
      ref: 'main',
      commit,
      packagePath: target.packagePath,
      lockfile: target.lockfile,
      commitUrl: `https://github.com/${target.repository}/commit/${commit}`,
      packageUrl: `https://raw.githubusercontent.com/${target.repository}/${commit}/plugin/package.json`,
      lockfileUrl: `https://raw.githubusercontent.com/${target.repository}/${commit}/plugin/pnpm-lock.yaml`,
    },
    manifest,
    package: packageObservation,
    graph,
    alignment: buildUpstreamDownstreamIR({
      targetId: target.id,
      ecosystem: target.ecosystem,
      source: {
        repository: target.repository,
        commit,
        packagePath: target.packagePath,
      },
      manifest,
      package: packageObservation,
      graph,
    }),
  }
}

let current = snapshot('commit-1', upstreamPackage.version, 'sha256:graph-v1')
const source = {
  observe: async () => current,
  compare: async (repository, beforeCommit, afterCommit) => ({
    beforeCommit,
    afterCommit,
    comparison: 'complete',
    changedFiles: ['src/index.ts', 'plugin/pnpm-lock.yaml', 'README.md'],
    runtimeFiles: ['src/index.ts', 'plugin/pnpm-lock.yaml'],
    nonRuntimeFiles: ['README.md'],
  }),
}
const config = { schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }

const baseline = await runObserver(config, emptyObservationState(), {
  source,
  reverseDependencyIndex,
  now: new Date('2026-08-17T00:00:00.000Z'),
})

current = snapshot('commit-2', nextVersion, 'sha256:graph-v2')
const changed = await runObserver(config, baseline.state, {
  source,
  reverseDependencyIndex,
  now: new Date('2026-08-17T01:00:00.000Z'),
  agent: async (task, prompt) => ({
    taskId: task.id,
    status: 'succeeded',
    output: JSON.stringify({
      impact: 'unknown',
      confidence: 'low',
      evidence: ['source commit and dependency graph require project-specific review'],
      breaking_change: 'unknown',
      dependency_risk: 'unknown',
      recommended_action: 'Ask the DSH Agent to inspect the plugin entrypoint and lockfile before upgrading.',
      urgency: 'planned',
      reasoning_summary: `The wrapper received ${prompt.length} characters of bounded read-only evidence.`,
    }),
  }),
})

const quiet = await runObserver(config, changed.state, {
  source,
  reverseDependencyIndex,
  now: new Date('2026-08-17T02:00:00.000Z'),
})

process.stdout.write(`${JSON.stringify({
  repository: resolve(import.meta.dirname, '..'),
  reverseIndexSource: batchIndexPath,
  upstreamPackage: `${upstreamPackage.name}@${upstreamPackage.version} -> ${nextVersion}`,
  baseline: {
    targets: baseline.report.baselineTargets,
    alignmentFindings: baseline.report.alignmentFindings.map(item => ({ targetId: item.targetId, status: item.alignment.status })),
    reverseIndex: baseline.report.reverseDependencyIndex,
    agentCalls: baseline.report.agent.attempted,
  },
  changed: {
    changes: changed.report.changes.map(item => ({
      targetId: item.targetId,
      meaningful: item.meaningful,
      reasons: item.reasons,
      alignment: item.current.alignment?.status,
      downstreamImpacts: item.reverseDependencyImpacts?.map(impact => ({
        dependency: impact.dependency.name,
        from: impact.changedFrom,
        to: impact.changedTo,
        plugins: impact.dependents.map(dependent => dependent.pluginId),
        coverage: impact.coverage,
      })),
      taskId: item.taskId,
    })),
    agentCalls: changed.report.agent.attempted,
    reverseIndex: changed.report.reverseDependencyIndex,
    pendingTasks: changed.report.pendingTasks,
  },
  quiet: {
    changes: quiet.report.changes.length,
    agentCalls: quiet.report.agent.attempted,
  },
}, null, 2)}\n`)
