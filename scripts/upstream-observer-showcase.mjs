import { resolve } from 'node:path'

const {
  OBSERVER_TARGETS_SCHEMA,
  emptyObservationState,
  runObserver,
} = await import('../dist/src/upstream-observer.js')
const { buildUpstreamDownstreamIR } = await import('../dist/src/upstream-alignment.js')
const { buildReverseDependencyIndex } = await import('../dist/src/dependency-index.js')

const target = {
  id: 'dsh-showcase',
  ecosystem: 'dsh',
  repository: 'acme/dsh-showcase',
  ref: 'main',
  packageName: 'dsh-showcase',
  packagePath: 'plugin/package.json',
  lockfile: 'plugin/pnpm-lock.yaml',
  lockfileType: 'pnpm',
}

function snapshot(commit, version, graphDigest) {
  const manifest = {
    name: 'dsh-lark-bot',
    version,
    main: './dist/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const packageObservation = {
    name: 'dsh-feishu-bot',
    version,
    integrity: `sha512-${version}`,
  }
  const graph = {
    schema: 'upstream-radar.dependency-graph/v1alpha1',
    rootNodeId: 'root',
    nodes: [
      { id: 'root', name: 'dsh-lark-bot', version },
      { id: 'parser', name: 'parser', version: graphDigest === 'sha256:graph-v2' ? '2.0.0' : '1.0.0' },
    ],
    edges: [{ from: 'root', to: 'parser', kind: 'runtime' }],
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

let current = snapshot('commit-1', '1.0.0', 'sha256:graph-v1')
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
const reverseDependencyIndex = buildReverseDependencyIndex([{
  source: 'downstream/dsh-plugin.json',
  pluginId: 'downstream-plugin@1.0.0',
  plugin: { ecosystem: 'npm', name: 'downstream-plugin', version: '1.0.0' },
  graph: {
    schema: 'upstream-radar.dependency-graph/v1alpha1',
    rootNodeId: 'downstream-root',
    nodes: [
      { id: 'downstream-root', name: 'downstream-plugin', version: '1.0.0' },
      { id: 'parser', name: 'parser', version: '1.0.0' },
    ],
    edges: [{ from: 'downstream-root', to: 'parser', kind: 'runtime' }],
  },
}], { generatedAt: '2026-08-17T00:00:00.000Z' })

const baseline = await runObserver(config, emptyObservationState(), {
  source,
  reverseDependencyIndex,
  now: new Date('2026-08-17T00:00:00.000Z'),
})

current = snapshot('commit-2', '1.1.0', 'sha256:graph-v2')
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
