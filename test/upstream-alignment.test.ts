import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildUpstreamDownstreamIR,
  parseUpstreamDownstreamIR,
  UPSTREAM_DOWNSTREAM_IR_SCHEMA,
} from '../src/upstream-alignment.js'

function input(overrides: Record<string, unknown> = {}) {
  return {
    targetId: 'dsh-demo',
    ecosystem: 'dsh' as const,
    source: {
      repository: 'acme/dsh-demo',
      commit: 'commit-1',
      packagePath: 'package.json',
    },
    manifest: {
      name: 'dsh-demo',
      version: '1.0.0',
      main: './dist/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    package: {
      name: 'dsh-demo',
      version: '1.0.0',
    },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1' as const,
      rootNodeId: 'root',
      nodes: [
        { id: 'root', name: 'dsh-demo', version: '1.0.0' },
        { id: 'logger', name: 'logger', version: '2.0.0' },
      ],
      edges: [{ from: 'root', to: 'logger', kind: 'runtime' as const }],
      source: 'pnpm-lock' as const,
      digest: 'sha256:graph',
    },
    ...overrides,
  }
}

describe('upstream/downstream alignment IR', () => {
  it('marks a complete source, published package and graph as aligned', () => {
    const report = buildUpstreamDownstreamIR(input())
    assert.equal(report.schema, UPSTREAM_DOWNSTREAM_IR_SCHEMA)
    assert.equal(report.status, 'aligned')
    assert.equal(report.downstream.graph.status, 'complete')
    assert.deepEqual(report.upstream.coordinate, { name: 'dsh-demo', version: '1.0.0' })
    assert.deepEqual(report.downstream.graph.root, { name: 'dsh-demo', version: '1.0.0' })
    assert.deepEqual(report.checks.map(check => check.status), ['aligned', 'aligned', 'aligned', 'aligned'])
  })

  it('keeps source and published identity mismatches explicit', () => {
    const report = buildUpstreamDownstreamIR(input({
      manifest: { name: 'dsh-lark-bot', version: '0.15.8' },
      package: { name: 'dsh-feishu-bot', version: '0.15.8' },
      graph: {
        schema: 'upstream-radar.dependency-graph/v1alpha1' as const,
        rootNodeId: 'root',
        nodes: [{ id: 'root', name: 'dsh-lark-bot', version: '0.15.8' }],
        edges: [],
        source: 'pnpm-lock' as const,
      },
    }))
    assert.equal(report.status, 'mismatch')
    assert.equal(report.checks.find(check => check.code === 'source-published-identity')?.status, 'mismatch')
    assert.equal(report.checks.find(check => check.code === 'published-graph-root')?.status, 'mismatch')
    assert.match(report.checks.find(check => check.code === 'source-published-identity')?.remediation ?? '', /publish mapping/)
  })

  it('does not call an unavailable graph a clean alignment', () => {
    const report = buildUpstreamDownstreamIR(input({
      package: { name: 'dsh-demo', version: '1.0.0' },
      graphError: 'no supported lockfile found',
      graph: undefined,
    }))
    assert.equal(report.status, 'unknown')
    assert.equal(report.downstream.graph.status, 'unavailable')
    assert.equal(report.checks.find(check => check.code === 'dependency-graph-coverage')?.status, 'unknown')
    assert.match(report.checks.find(check => check.code === 'dependency-graph-coverage')?.remediation ?? '', /empty vulnerability result is not complete coverage/)
  })

  it('treats an explicitly source-only distribution as intentional instead of demanding npm', () => {
    const report = buildUpstreamDownstreamIR(input({
      npmExpected: false,
      package: undefined,
    }))
    assert.equal(report.status, 'aligned')
    assert.equal(report.downstream.npmExpected, false)
    assert.equal(report.checks.find(check => check.code === 'source-published-identity')?.status, 'aligned')
    assert.equal(report.checks.some(check => check.remediation?.includes('npm package')), false)
    assert.deepEqual(parseUpstreamDownstreamIR(report), report)
    assert.throws(() => buildUpstreamDownstreamIR(input({ npmExpected: false })), /source-only alignment/)
  })

  it('validates persisted IR before it is reused', () => {
    const report = buildUpstreamDownstreamIR(input())
    assert.deepEqual(parseUpstreamDownstreamIR(report), report)
    assert.throws(() => parseUpstreamDownstreamIR({ ...report, status: 'aligned', checks: [] }), /checks must contain/)
    assert.throws(() => parseUpstreamDownstreamIR({ ...report, status: 'mismatch' }), /does not match its check statuses/)
    assert.throws(() => parseUpstreamDownstreamIR({ ...report, schema: 'wrong' }), /unsupported schema/)
  })
})
