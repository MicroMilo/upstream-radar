import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  OBSERVER_TARGETS_SCHEMA,
  OBSERVATION_STATE_SCHEMA,
  UpstreamObserverClient,
  emptyObservationState,
  observerExitCode,
  parseObserverConfigText,
  parseObservationState,
  renderUpstreamChangeAgentPrompt,
  renderObserverReport,
  runDshAgentCommand,
  runOpenAiCompatibleAgent,
  runObserver,
  type ObserverSnapshot,
  type ObserverSource,
  type ObserverTarget,
  type ObserverArtifactReview,
} from '../src/upstream-observer.js'
import { buildUpstreamDownstreamIR } from '../src/upstream-alignment.js'
import { buildReverseDependencyIndex } from '../src/dependency-index.js'

const target: ObserverTarget = {
  id: 'dsh-demo',
  ecosystem: 'dsh',
  repository: 'acme/dsh-demo',
  ref: 'main',
  packageName: 'dsh-demo',
  packagePath: 'plugin/package.json',
  lockfile: 'plugin/pnpm-lock.yaml',
  lockfileType: 'pnpm',
}

function snapshot(commit: string, version: string, digest: string): ObserverSnapshot {
  return {
    targetId: target.id,
    ecosystem: target.ecosystem,
    observedAt: '2026-08-17T00:00:00.000Z',
    source: {
      repository: target.repository,
      ref: 'main',
      commit,
      packagePath: 'plugin/package.json',
      lockfile: 'plugin/pnpm-lock.yaml',
      commitUrl: `https://github.com/${target.repository}/commit/${commit}`,
      packageUrl: `https://raw.githubusercontent.com/${target.repository}/${commit}/plugin/package.json`,
      lockfileUrl: `https://raw.githubusercontent.com/${target.repository}/${commit}/plugin/pnpm-lock.yaml`,
    },
    manifest: {
      name: 'dsh-demo',
      version,
      main: './dist/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    package: {
      name: 'dsh-demo',
      version,
      integrity: `sha512-${version}`,
    },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'root',
      nodes: [
        { id: 'root', name: 'dsh-demo', version },
        { id: 'logger', name: 'logger', version: digest === 'graph-v2' ? '2.0.0' : '1.0.0' },
      ],
      edges: [{ from: 'root', to: 'logger', kind: 'runtime' }],
      source: 'pnpm-lock',
      digest,
    },
  }
}

describe('upstream observer', () => {
  it('retries one transient upstream request failure before reporting an error', async () => {
    let attempts = 0
    const source = new UpstreamObserverClient({
      fetch: async () => {
        attempts += 1
        if (attempts === 1) {
          const error = new Error('request timed out')
          error.name = 'TimeoutError'
          throw error
        }
        return new Response(JSON.stringify({ files: [{ filename: 'package.json' }] }), { status: 200 })
      },
    })
    const result = await source.compare('acme/dsh-demo', 'commit-1', 'commit-2')
    assert.equal(attempts, 2)
    assert.equal(result.comparison, 'complete')
    assert.deepEqual(result.changedFiles, ['package.json'])
  })

  it('falls back to the after-commit file list when GitHub compare is unavailable', async () => {
    const source = new UpstreamObserverClient({
      fetch: async input => {
        const url = String(input)
        if (url.includes('/compare/')) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        }
        return new Response(JSON.stringify({
          parents: [{ sha: 'commit-1' }],
          files: [{ filename: 'package.json' }, { filename: 'README.md' }],
        }), { status: 200 })
      },
    })
    const result = await source.compare('acme/dsh-demo', 'commit-1', 'commit-2')
    assert.equal(result.comparison, 'complete')
    assert.deepEqual(result.changedFiles, ['package.json', 'README.md'])
    assert.deepEqual(result.runtimeFiles, ['package.json'])
    assert.deepEqual(result.nonRuntimeFiles, ['README.md'])
  })

  it('auto-discovers a committed pnpm lockfile when a target omits lockfile options', async () => {
    const requested: string[] = []
    const source = new UpstreamObserverClient({
      fetch: async input => {
        const url = String(input)
        requested.push(url)
        if (url.includes('/commits/main')) {
          return new Response(JSON.stringify({ sha: 'commit-1' }), { status: 200 })
        }
        if (url.endsWith('/commit-1/package.json')) {
          return new Response(JSON.stringify({
            name: 'dsh-demo',
            version: '1.0.0',
            packageManager: 'pnpm@10.0.0',
          }), { status: 200 })
        }
        if (url.startsWith('https://registry.npmjs.org/')) {
          return new Response('', { status: 404 })
        }
        if (url.endsWith('/commit-1/pnpm-lock.yaml')) {
          return new Response([
            "lockfileVersion: '9.0'",
            '',
            'importers:',
            '  .:',
            '    dependencies:',
            '      logger: 1.0.0',
            '',
            'packages:',
            '  logger@1.0.0: {}',
            '',
            'snapshots:',
            '  logger@1.0.0: {}',
            '',
          ].join('\n'), { status: 200 })
        }
        if (url.endsWith('/commit-1/package-lock.json')) {
          return new Response('', { status: 404 })
        }
        throw new Error(`unexpected request: ${url}`)
      },
    })
    const result = await source.observe({
      id: 'dsh-demo',
      ecosystem: 'dsh',
      repository: 'acme/dsh-demo',
      ref: 'main',
      packageName: 'dsh-demo',
      packagePath: 'package.json',
    }, '2026-08-17T00:00:00.000Z')
    assert.equal(result.source.lockfile, 'pnpm-lock.yaml')
    assert.equal(result.graph?.source, 'pnpm-lock')
    assert.equal(result.graph?.nodes.some(node => node.name === 'logger' && node.version === '1.0.0'), true)
    assert.equal(result.warnings?.length ?? 0, 1)
    assert.match(result.warnings?.[0] ?? '', /dsh-demo was not found/)
    assert.equal(requested.some(url => url.endsWith('/commit-1/pnpm-lock.yaml')), true)
  })

  it('auto-discovers the only nested DSH runtime package for a GitHub target', async () => {
    const requested: string[] = []
    const source = new UpstreamObserverClient({
      fetch: async input => {
        const url = String(input)
        requested.push(url)
        if (url.includes('/commits/main')) {
          return new Response(JSON.stringify({ sha: 'commit-1' }), { status: 200 })
        }
        if (url.includes('/git/trees/commit-1?recursive=1')) {
          return new Response(JSON.stringify({ tree: [
            { path: 'package.json', type: 'blob' },
            { path: 'apps/cli/package.json', type: 'blob' },
          ] }), { status: 200 })
        }
        if (url.endsWith('/commit-1/package.json')) {
          return new Response(JSON.stringify({
            name: 'deepseek-harness',
            version: '0.0.0',
            packageManager: 'pnpm@11.3.0',
          }), { status: 200 })
        }
        if (url.endsWith('/commit-1/apps/cli/package.json')) {
          return new Response(JSON.stringify({
            name: '@deepseek-ai/dsh',
            version: '0.1.0-rc.7',
            packageManager: 'pnpm@11.3.0',
          }), { status: 200 })
        }
        if (url.startsWith('https://registry.npmjs.org/')) {
          return new Response('', { status: 404 })
        }
        if (url.endsWith('/commit-1/pnpm-lock.yaml')) {
          return new Response([
            "lockfileVersion: '9.0'",
            '',
            'importers:',
            '  .: {}',
            '  apps/cli:',
            '    dependencies:',
            '      logger: 1.0.0',
            '',
            'packages:',
            '  logger@1.0.0: {}',
            '',
            'snapshots:',
            '  logger@1.0.0: {}',
            '',
          ].join('\n'), { status: 200 })
        }
        if (url.endsWith('/commit-1/package-lock.json')) {
          return new Response('', { status: 404 })
        }
        throw new Error(`unexpected request: ${url}`)
      },
    })
    const result = await source.observe({
      id: 'dsh-core',
      ecosystem: 'dsh',
      repository: 'acme/dsh-core',
      ref: 'main',
    }, '2026-08-17T00:00:00.000Z')
    assert.equal(result.source.packagePath, 'apps/cli/package.json')
    assert.equal(result.manifest.name, '@deepseek-ai/dsh')
    assert.equal(result.graph?.rootNodeId, 'pnpm:workspace-root:@deepseek-ai/dsh@0.1.0-rc.7')
    assert.equal(result.graph?.nodes.some(node => node.name === 'logger' && node.version === '1.0.0'), true)
    assert.equal(requested.some(url => url.includes('/git/trees/commit-1?recursive=1')), true)
  })

  it('parses the small targets.yml format and normalizes aliases', () => {
    const config = parseObserverConfigText(`
schema: ${OBSERVER_TARGETS_SCHEMA}
targets:
  - id: dsh-demo
    ecosystem: dsh
    repository: acme/dsh-demo
    ref: main
    package: dsh-demo
    package-tag: next
    package-path: plugin/package.json
    lockfile: plugin/pnpm-lock.yaml
    lockfile-type: pnpm
    dsh-versions: ["0.1.0-rc.6", "0.1.0-rc.7"]
`)
    assert.equal(config.schema, OBSERVER_TARGETS_SCHEMA)
    assert.deepEqual(config.targets[0], { ...target, packageTag: 'next', dshVersions: ['0.1.0-rc.6', '0.1.0-rc.7'] })
  })

  it('observes the configured npm release channel instead of assuming latest', async () => {
    const source = new UpstreamObserverClient({
      fetch: async input => {
        const url = String(input)
        if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha: 'commit-1' }), { status: 200 })
        if (url.endsWith('/commit-1/plugin/package.json')) {
          return new Response(JSON.stringify({ name: 'dsh-demo', version: '2.0.0-rc.1' }), { status: 200 })
        }
        if (url.startsWith('https://registry.npmjs.org/')) {
          return new Response(JSON.stringify({
            'dist-tags': { latest: '1.0.0', next: '2.0.0-rc.1' },
            versions: {
              '1.0.0': { dist: { integrity: 'sha512-latest' } },
              '2.0.0-rc.1': { dist: { integrity: 'sha512-next' } },
            },
          }), { status: 200 })
        }
        if (url.endsWith('/commit-1/plugin/pnpm-lock.yaml')) {
          return new Response([
            "lockfileVersion: '9.0'",
            '',
            'importers:',
            '  plugin: {}',
            '',
            'packages: {}',
            '',
            'snapshots: {}',
            '',
          ].join('\n'), { status: 200 })
        }
        throw new Error(`unexpected request: ${url}`)
      },
    })
    const result = await source.observe({ ...target, packageTag: 'next' }, '2026-08-21T00:00:00.000Z')
    assert.equal(result.package?.version, '2.0.0-rc.1')
    assert.equal(result.package?.distTag, 'next')
    assert.equal(result.package?.integrity, 'sha512-next')
  })

  it('creates a baseline, calls the Agent on a meaningful change, and stays quiet without a new change', async () => {
    const first = snapshot('commit-1', '1.0.0', 'graph-v1')
    const second = snapshot('commit-2', '1.1.0', 'graph-v2')
    let current = first
    const source: ObserverSource = {
      observe: async () => current,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts', 'README.md', 'plugin/pnpm-lock.yaml'],
        runtimeFiles: ['src/index.ts', 'plugin/pnpm-lock.yaml'],
        nonRuntimeFiles: ['README.md'],
      }),
    }
    const firstRun = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, emptyObservationState(), {
      source,
      now: new Date('2026-08-17T00:00:00.000Z'),
    })
    assert.deepEqual(firstRun.report.baselineTargets, ['dsh-demo'])
    assert.equal(firstRun.report.changes.length, 0)

    current = second
    let agentCalls = 0
    const secondRun = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, firstRun.state, {
      source,
      now: new Date('2026-08-17T01:00:00.000Z'),
      agent: async (task, prompt) => {
        agentCalls += 1
        assert.equal(task.change.meaningful, true)
        assert.match(prompt, /UPSTREAM RADAR UPSTREAM CHANGE TASK/)
        return { taskId: task.id, status: 'succeeded', output: '{"impact":"unknown"}', parsedOutput: { impact: 'unknown' } }
      },
    })
    assert.equal(secondRun.report.changes.length, 1)
    assert.equal(secondRun.report.agent.attempted, 1)
    assert.equal(secondRun.report.agent.succeeded, 1)
    assert.equal(agentCalls, 1)
    assert.equal(secondRun.state.pendingTasks.length, 0)
    const rendered = renderObserverReport(secondRun.report)
    assert.match(rendered, /Author next step: review added dependency edges/)
    assert.match(rendered, /Exact artifact check: npx --yes upstream-radar@latest inspect npm:dsh-demo@1\.1\.0 --deep/)

    const thirdRun = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, secondRun.state, {
      source: { ...source, observe: async () => ({ ...second, observedAt: '2026-08-17T02:00:00.000Z' }) },
      now: new Date('2026-08-17T02:00:00.000Z'),
      agent: async () => {
        throw new Error('Agent must not be called without a change')
      },
    })
    assert.equal(thirdRun.report.changes.length, 0)
    assert.equal(thirdRun.report.agent.attempted, 0)
    assert.equal(thirdRun.state.targets[target.id]?.observedAt, secondRun.state.targets[target.id]?.observedAt)
  })

  it('routes an upstream dependency version change to downstream plugins from the reverse index', async () => {
    const first = snapshot('commit-1', '1.0.0', 'graph-v1')
    const second = snapshot('commit-2', '1.1.0', 'graph-v2')
    const reverseIndex = buildReverseDependencyIndex([{
      source: 'downstream-plugin.json',
      pluginId: 'downstream-plugin@1.0.0',
      plugin: { ecosystem: 'npm', name: 'downstream-plugin', version: '1.0.0' },
      graph: first.graph!,
    }])
    let current = first
    const source: ObserverSource = {
      observe: async () => current,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['pnpm-lock.yaml'],
        runtimeFiles: ['pnpm-lock.yaml'],
        nonRuntimeFiles: [],
      }),
    }
    const config = { schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }
    const baseline = await runObserver(config, emptyObservationState(), {
      source,
      reverseDependencyIndex: reverseIndex,
      now: new Date('2026-08-17T05:00:00.000Z'),
    })
    assert.equal(baseline.report.changes.length, 0)

    current = second
    const changed = await runObserver(config, baseline.state, {
      source,
      reverseDependencyIndex: reverseIndex,
      now: new Date('2026-08-17T06:00:00.000Z'),
    })
    const impact = changed.report.changes[0]?.reverseDependencyImpacts?.[0]
    assert.ok(impact)
    assert.deepEqual(changed.report.reverseDependencyIndex, {
      observations: 1,
      plugins: 1,
      dependencies: 1,
      completeObservations: 1,
      incompleteObservations: 0,
      unresolvedEdges: 0,
    })
    assert.equal(impact.dependency.name, 'logger')
    assert.deepEqual(impact.changedFrom, ['1.0.0'])
    assert.deepEqual(impact.changedTo, ['2.0.0'])
    assert.deepEqual(impact.dependents.map(item => item.pluginId), ['downstream-plugin@1.0.0'])
    assert.match(renderObserverReport(changed.report), /Downstream impact: logger \(1\.0\.0 → 2\.0\.0\); 1 downstream plugin\(s\)/)
    assert.match(renderUpstreamChangeAgentPrompt(changed.state.pendingTasks[0]!), /reverseDependencyImpacts/)
  })

  it('shows baseline identity alignment findings without waking the Agent', async () => {
    const observed = snapshot('commit-1', '0.15.8', 'graph-v1')
    observed.manifest = { ...observed.manifest, name: 'dsh-lark-bot' }
    observed.package = { name: 'dsh-feishu-bot', version: '0.15.8' }
    observed.alignment = buildUpstreamDownstreamIR({
      targetId: observed.targetId,
      ecosystem: observed.ecosystem,
      source: {
        repository: observed.source.repository,
        commit: observed.source.commit,
        packagePath: observed.source.packagePath,
      },
      manifest: observed.manifest,
      package: observed.package,
      ...(observed.graph === undefined ? {} : { graph: observed.graph }),
    })
    const result = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, emptyObservationState(), {
      source: { observe: async () => observed, compare: async () => { throw new Error('compare must not run for a baseline') } },
      now: new Date('2026-08-17T01:30:00.000Z'),
      agent: async () => { throw new Error('baseline alignment must not call Agent') },
    })
    assert.equal(result.report.changes.length, 0)
    assert.equal(result.report.alignmentFindings[0]?.alignment.status, 'mismatch')
    assert.match(renderObserverReport(result.report), /Upstream\/downstream alignment findings/)
    assert.match(renderObserverReport(result.report), /source-published-identity/)
    assert.equal(result.state.targets[target.id]?.alignment?.status, 'mismatch')
  })

  it('upgrades a legacy observation point and reports the IR once without creating a task', async () => {
    const legacy = snapshot('commit-1', '1.0.0', 'graph-v1')
    const current = structuredClone(legacy)
    current.alignment = buildUpstreamDownstreamIR({
      targetId: current.targetId,
      ecosystem: current.ecosystem,
      source: {
        repository: current.source.repository,
        commit: current.source.commit,
        packagePath: current.source.packagePath,
      },
      manifest: current.manifest,
      ...(current.package === undefined ? {} : { package: current.package }),
      ...(current.graph === undefined ? {} : { graph: current.graph }),
    })
    const source: ObserverSource = {
      observe: async () => current,
      compare: async () => { throw new Error('compare must not run for an unchanged legacy point') },
    }
    const first = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: legacy },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T01:45:00.000Z') })
    assert.equal(first.report.changes.length, 0)
    assert.equal(first.report.alignmentFindings.length, 1)
    assert.equal(first.report.pendingTasks.length, 0)
    const second = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, first.state, {
      source,
      now: new Date('2026-08-17T02:00:00.000Z'),
    })
    assert.equal(second.report.alignmentFindings.length, 0)
    assert.equal(second.report.changes.length, 0)
  })

  it('reviews the exact published artifact only for a meaningful change and carries author findings into the task', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v2')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      }),
    }
    const calls: string[] = []
    const review = (spec: string): ObserverArtifactReview => ({
      spec,
      verdict: 'review',
      riskVerdict: 'review',
      coverageVerdict: 'complete',
      artifactIntegrity: 'verified',
      registrySignature: 'verified',
      provenance: 'missing',
      dependencyResolution: 'resolved',
      dependencyAuditStatus: 'findings',
      resolutionMode: 'strict',
      graphDigest: 'sha256:artifact-graph',
      packages: 12,
      unresolved: 0,
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      installScriptPackages: ['logger@1.0.0'],
      installScriptDetails: [{
        package: 'logger@1.0.0',
        scripts: [{ name: 'postinstall', command: 'node scripts/postinstall.js' }],
      }],
      findings: [{
        code: 'dependency-install-script-present',
        severity: 'high',
        summary: 'Resolved dependency graph contains install-time scripts',
        detail: 'The exact graph includes a postinstall script.',
        remediation: 'Review the package before allowing a normal install.',
      }],
      dshCompatibility: {
        result: 'compatible',
        versions: ['0.1.0-rc.6', '0.1.0-rc.7'],
        summary: { total: 2, compatible: 2, incompatible: 0, unknown: 0 },
        reports: [
          { dshVersion: '0.1.0-rc.6', result: 'compatible', reason: 'bundle registered and loaded' },
          { dshVersion: '0.1.0-rc.7', result: 'compatible', reason: 'bundle registered and loaded' },
        ],
      },
    })
    const targetWithMatrix: ObserverTarget = { ...target, dshVersions: ['0.1.0-rc.6', '0.1.0-rc.7'] }
    const firstRun = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [targetWithMatrix] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, {
      source,
      artifactReviewer: async (spec, observedTarget) => {
        calls.push(spec)
        assert.deepEqual(observedTarget.dshVersions, ['0.1.0-rc.6', '0.1.0-rc.7'])
        return review(spec)
      },
      now: new Date('2026-08-17T02:30:00.000Z'),
    })
    const change = firstRun.report.changes[0]
    assert.ok(change)
    assert.deepEqual(calls, ['npm:dsh-demo@1.1.0'])
    assert.equal(change.artifactReview?.spec, 'npm:dsh-demo@1.1.0')
    assert.equal(firstRun.state.pendingTasks[0]?.change.artifactReview?.installScriptPackages[0], 'logger@1.0.0')
    assert.match(renderObserverReport(firstRun.report), /Exact artifact review: REVIEW/)
    assert.match(renderObserverReport(firstRun.report), /Artifact install scripts: logger@1\.0\.0 postinstall: node scripts\/postinstall\.js/)
    assert.match(renderObserverReport(firstRun.report), /Artifact remediation: Review the package before allowing a normal install\./)
    assert.match(renderObserverReport(firstRun.report), /DSH load matrix: COMPATIBLE \(2\/2 versions loaded\)/)
    assert.match(renderObserverReport(firstRun.report), /DSH 0\.1\.0-rc\.7: COMPATIBLE/)
    const prompt = renderUpstreamChangeAgentPrompt(firstRun.state.pendingTasks[0]!)
    assert.match(prompt, /artifactReview/)
    assert.match(prompt, /dependency-install-script-present/)
  })

  it('keeps the upstream change when exact artifact review fails', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v2')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      }),
    }
    const result = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, {
      source,
      artifactReviewer: async () => { throw new Error('registry temporarily unavailable') },
      now: new Date('2026-08-17T02:45:00.000Z'),
    })
    assert.equal(result.report.errors.length, 0)
    assert.equal(result.report.changes.length, 1)
    assert.equal(result.report.changes[0]?.artifactReview?.verdict, 'review')
    assert.match(result.report.changes[0]?.artifactReview?.error ?? '', /registry temporarily unavailable/)
    assert.equal(result.state.pendingTasks.length, 1)
  })

  it('advances the observation point for docs-only changes without waking the Agent', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.0.0', 'graph-v1')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['README.md'],
        runtimeFiles: [],
        nonRuntimeFiles: ['README.md'],
      }),
    }
    const result = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, {
      source,
      now: new Date('2026-08-17T03:00:00.000Z'),
      agent: async () => {
        throw new Error('Agent must not be called for docs-only changes')
      },
    })
    assert.equal(result.report.changes.length, 0)
    assert.equal(result.report.agent.attempted, 0)
    assert.equal(result.state.targets[target.id]?.source.commit, 'commit-2')
  })

  it('does not report unchanged root edges as dependency changes when the root version bumps', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v1')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['package.json'],
        runtimeFiles: ['package.json'],
        nonRuntimeFiles: [],
      }),
    }
    const result = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T03:30:00.000Z') })
    const change = result.report.changes[0]
    assert.ok(change)
    assert.deepEqual(change.graph, {
      addedNodes: [],
      removedNodes: [],
      addedEdges: [],
      removedEdges: [],
      addedUnresolved: [],
      removedUnresolved: [],
    })
    assert.doesNotMatch(change.reasons.join('\n'), /dependency graph changed/)
    assert.match(change.reasons.join('\n'), /source manifest identity changed/)
  })

  it('keeps a task when no Agent is configured and accepts the state shape again', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v2')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      }),
    }
    const result = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T04:00:00.000Z') })
    assert.equal(result.report.agent.configured, false)
    assert.equal(result.report.agent.skipped, 1)
    assert.equal(result.state.pendingTasks.length, 1)
    assert.equal(result.report.pendingTaskDetails.length, 1)
    assert.equal(result.report.pendingTaskDetails[0]?.beforeCommit, 'commit-1')
    assert.equal(result.report.pendingTaskDetails[0]?.afterCommit, 'commit-2')
    assert.equal(result.report.pendingTaskDetails[0]?.sourceManifestBefore, 'dsh-demo@1.0.0')
    assert.equal(result.report.pendingTaskDetails[0]?.sourceManifestAfter, 'dsh-demo@1.1.0')
    assert.match(result.report.pendingTaskDetails[0]?.reasons.join('\n') ?? '', /runtime source changed/)
    assert.doesNotThrow(() => parseObservationState(result.state))
  })

  it('turns source and published version drift into an author-facing task', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.0.0', 'graph-v1')
    after.package = { ...after.package!, version: '2.0.0' }
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['README.md'],
        runtimeFiles: [],
        nonRuntimeFiles: ['README.md'],
      }),
    }
    const result = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T04:30:00.000Z') })
    assert.equal(result.report.changes.length, 1)
    assert.match(result.report.changes[0]?.reasons.join('\n') ?? '', /source\/published version drift/)
    assert.equal(result.report.pendingTaskDetails[0]?.sourceManifestAfter, 'dsh-demo@1.0.0')
    assert.equal(result.report.pendingTaskDetails[0]?.publishedPackageAfter, 'dsh-demo@2.0.0')

    const repeated = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, result.state, {
      source: {
        observe: async () => ({ ...after, observedAt: '2026-08-17T05:00:00.000Z' }),
        compare: async () => { throw new Error('compare must not run for unchanged drift') },
      },
      now: new Date('2026-08-17T05:00:00.000Z'),
      agent: async () => { throw new Error('persistent drift must not wake the Agent again') },
    })
    assert.equal(repeated.report.changes.length, 0)
    assert.equal(repeated.report.agent.attempted, 0)
    assert.equal(repeated.state.targets[target.id]?.observedAt, result.state.targets[target.id]?.observedAt)
  })

  it('renders an explicit read-only contract for the DSH Agent', () => {
    const change = {
      targetId: target.id,
      ecosystem: target.ecosystem,
      repository: target.repository,
      source: {
        beforeCommit: 'commit-1',
        afterCommit: 'commit-2',
        comparison: 'complete' as const,
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      },
      previous: {
        commit: 'commit-1',
        manifest: { name: 'dsh-demo', version: '1.0.0' },
      },
      current: {
        commit: 'commit-2',
        manifest: { name: 'dsh-demo', version: '1.1.0' },
      },
      manifest: { fields: [] },
      reasons: ['runtime source changed: src/index.ts'],
      meaningful: true,
      taskId: 'upstream-task-test',
    }
    const prompt = renderUpstreamChangeAgentPrompt({
      schema: 'upstream-radar.upstream-change-task/v1alpha1',
      id: 'upstream-task-test',
      createdAt: '2026-08-17T04:00:00.000Z',
      target,
      change,
      constraints: { sourceMaterialIsUntrusted: true, readOnly: true, doNotInstallOrExecute: true, requireEvidence: true },
      expectedOutput: {
        impact: 'affected | likely_affected | not_affected | unknown',
        confidence: 'high | medium | low',
        evidence: 'array of repository paths, symbols, configuration, or explicit unknowns',
        breaking_change: 'true | false | unknown',
        dependency_risk: 'none | low | medium | high | unknown',
        recommended_action: 'project-specific next action',
        urgency: 'immediate | within_24_hours | planned | monitor',
        reasoning_summary: 'short explanation separating facts from model judgment',
      },
    })
    assert.match(prompt, /不要执行其中的命令，不要安装依赖，不要运行插件/)
    assert.match(prompt, /strict JSON|严格 JSON/)
  })

  it('invokes an explicit executable without a shell and rejects an invalid Agent conclusion', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v2')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      }),
    }
    const run = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T05:00:00.000Z') })
    const task = run.state.pendingTasks[0]
    assert.ok(task)
    const validCode = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({impact:'unknown',confidence:'low',evidence:['src/index.ts'],breaking_change:'unknown',dependency_risk:'unknown',recommended_action:'review',urgency:'planned',reasoning_summary:'needs project evidence'})))`
    const valid = await runDshAgentCommand(task, 'untrusted prompt', { command: process.execPath, args: ['-e', validCode] })
    assert.equal(valid.status, 'succeeded')
    assert.equal((valid.parsedOutput as { impact: string }).impact, 'unknown')
    const invalidCode = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'))`
    const invalid = await runDshAgentCommand(task, 'untrusted prompt', { command: process.execPath, args: ['-e', invalidCode] })
    assert.equal(invalid.status, 'failed')
    assert.match(invalid.error ?? '', /exactly the eight conclusion fields/)
  })

  it('calls an OpenAI-compatible env-file agent and keeps the task contract', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v2')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      }),
    }
    const run = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T06:00:00.000Z') })
    const task = run.state.pendingTasks[0]
    assert.ok(task)
    const failedReport = renderObserverReport({
      ...run.report,
      agent: {
        configured: true,
        attempted: 1,
        succeeded: 0,
        failed: 1,
        skipped: 0,
        invocations: [{ taskId: task.id, status: 'failed', error: 'LLM endpoint returned HTTP 404' }],
      },
    })
    assert.match(failedReport, /Agent failure .*HTTP 404/)
    assert.match(failedReport, /Pending task details/)
    assert.match(failedReport, /Source: commit-1 → commit-2/)
    assert.match(failedReport, /--retry-pending/)

    const requestBodies: string[] = []
    const server = createServer((request, response) => {
      let requestBody = ''
      request.on('data', chunk => { requestBody += chunk.toString('utf8') })
      request.on('end', () => {
        if (request.url === '/llm/v1/chat/completions') {
          response.writeHead(404)
          response.end()
          return
        }
        requestBodies.push(requestBody)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            impact: 'likely_affected',
            confidence: 'medium',
            evidence: { source: ['src/index.ts'] },
            breaking_change: 'false',
            dependency_risk: 'low',
            recommended_action: 'Review the changed entrypoint before upgrading.',
            urgency: 'planned',
            reasoning_summary: 'The source changed, but the project-specific impact needs review.',
          }) } }],
        }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not expose an address')
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-llm-agent-'))
    try {
      const envFile = join(root, 'issue-locator.env')
      await writeFile(envFile, [
        `ISSUE_LOCATOR_LLM_BASE_URL=http://127.0.0.1:${address.port}/llm/v1`,
        'ISSUE_LOCATOR_LLM_API_KEY=test-only',
        'MODEL=deepseek-v4-flash',
        '',
      ].join('\n'))
      const invocation = await runOpenAiCompatibleAgent(task, 'read-only task prompt', { envFile })
      assert.equal(invocation.status, 'succeeded')
      assert.equal((invocation.parsedOutput as { impact: string }).impact, 'likely_affected')
      assert.equal((invocation.parsedOutput as { breaking_change: boolean }).breaking_change, false)
      assert.deepEqual((invocation.parsedOutput as { evidence: string[] }).evidence, ['source: ["src/index.ts"]'])
      assert.equal(requestBodies.length, 1)
      assert.equal(JSON.parse(requestBodies[0]!).model, 'deepseek-v4-flash')
      assert.deepEqual(JSON.parse(requestBodies[0]!).thinking, { type: 'disabled' })
      assert.match(JSON.parse(requestBodies[0]!).messages[0].content, /严格 JSON 对象/)
      assert.equal(JSON.parse(requestBodies[0]!).max_tokens, 2_048)
      assert.match(JSON.parse(requestBodies[0]!).messages[1].content, /read-only task prompt/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }

    const notFoundServer = createServer((request, response) => {
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      notFoundServer.once('error', reject)
      notFoundServer.listen(0, '127.0.0.1', () => resolve())
    })
    const notFoundAddress = notFoundServer.address()
    if (notFoundAddress === null || typeof notFoundAddress === 'string') throw new Error('404 test server did not expose an address')
    const notFoundRoot = await mkdtemp(join(tmpdir(), 'upstream-radar-llm-404-'))
    try {
      const notFoundEnvFile = join(notFoundRoot, 'issue-locator.env')
      await writeFile(notFoundEnvFile, [
        `ISSUE_LOCATOR_LLM_BASE_URL=http://127.0.0.1:${notFoundAddress.port}/llm/v1`,
        'ISSUE_LOCATOR_LLM_API_KEY=test-only',
        'ISSUE_LOCATOR_LLM_MODEL=test-model',
        '',
      ].join('\n'))
      const invocation = await runOpenAiCompatibleAgent(task, '404 task prompt', { envFile: notFoundEnvFile })
      assert.equal(invocation.status, 'failed')
      assert.match(invocation.error ?? '', /all known OpenAI-compatible paths/)
      assert.match(invocation.error ?? '', /\/llm\/v1\/chat\/completions/)
      assert.match(invocation.error ?? '', /\/llm\/openai\/v1\/chat\/completions/)
    } finally {
      await rm(notFoundRoot, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => notFoundServer.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('does not turn a failed optional Agent/model attempt into a failed static observation', async () => {
    const before = snapshot('commit-1', '1.0.0', 'graph-v1')
    const after = snapshot('commit-2', '1.1.0', 'graph-v2')
    const source: ObserverSource = {
      observe: async () => after,
      compare: async (repository, beforeCommit, afterCommit) => ({
        beforeCommit,
        afterCommit,
        comparison: 'complete',
        changedFiles: ['src/index.ts'],
        runtimeFiles: ['src/index.ts'],
        nonRuntimeFiles: [],
      }),
    }
    const run = await runObserver({ schema: OBSERVER_TARGETS_SCHEMA, targets: [target] }, {
      schema: OBSERVATION_STATE_SCHEMA,
      targets: { [target.id]: before },
      pendingTasks: [],
    }, { source, now: new Date('2026-08-17T07:00:00.000Z') })
    const report = {
      ...run.report,
      agent: {
        configured: true,
        attempted: 1,
        succeeded: 0,
        failed: 1,
        skipped: 0,
        invocations: [{ taskId: run.state.pendingTasks[0]!.id, status: 'failed' as const, error: 'LLM endpoint returned HTTP 404' }],
      },
    }
    assert.equal(observerExitCode(report), 0)
    assert.equal(observerExitCode({ ...report, errors: [{ targetId: target.id, message: 'source unavailable' }] }), 1)
    assert.equal(report.pendingTasks.length, 1)
  })
})
