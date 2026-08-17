import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderDshPluginReview, reviewDshPlugin } from '../src/dsh-review.js'
import type { DshLoadMatrixReport } from '../src/dsh-probe.js'
import type { ScanReport } from '../src/types.js'

const digest = 'a'.repeat(64)

function scanReport(): ScanReport {
  return {
    schema: 'upstream-radar.scan/v1alpha1',
    tool: { name: 'upstream-radar', version: '0.0.0' },
    target: {
      kind: 'npm',
      name: 'demo-plugin',
      version: '1.0.0',
      artifactDigest: `sha256:${digest}`,
      spec: 'demo-plugin@1.0.0',
    },
    dsh: { isBundle: true, patch: 'cordis.patch.yml' },
    evidence: {
      filesScanned: 2,
      bytesHashed: 10,
      lockfiles: [],
      packageManager: null,
      lifecycleScripts: [],
      dependencies: [],
      npm: {
        registry: 'https://registry.npmjs.org/',
        tarball: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
        compressedBytes: 10,
        unpackedBytes: 20,
        integrity: { status: 'verified', algorithm: 'sha512', expected: 'expected', actual: 'expected' },
        registrySignature: { status: 'verified', keyIds: [] },
        provenance: { status: 'verified' },
        dependencyAudit: {
          status: 'verified',
          packages: 2,
          resolutionMode: 'strict',
          invalidSignatures: [],
          missingSignatures: [],
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        },
      },
    },
    coverage: {
      staticSource: 'complete',
      artifactIntegrity: 'verified',
      registrySignature: 'verified',
      dependencyResolution: 'resolved',
      provenance: 'verified',
      sourceArtifactMatch: 'not-checked',
      sandboxDetonation: 'not-run',
    },
    findings: [],
    riskVerdict: 'allow',
    coverageVerdict: 'complete',
    verdict: 'allow',
  }
}

function matrixReport(): DshLoadMatrixReport {
  const reports = ['0.1.0-rc.6', '0.1.0-rc.7'].map(dshVersion => ({
    schema: 'upstream-radar.dsh-load-probe/v1alpha1' as const,
    probe: 'dsh-load' as const,
    scope: 'bundle-load-only' as const,
    dshVersion,
    artifact: { path: '/tmp/demo-plugin.tgz', sha256: digest, name: 'demo-plugin', version: '1.0.0' },
    stages: {
      artifact: { status: 'passed' as const },
      profile: { status: 'passed' as const },
      install: { status: 'passed' as const },
      registration: { status: 'passed' as const },
      load: { status: 'passed' as const },
    },
    result: 'compatible' as const,
    reason: 'bundle registered and loaded',
    boundary: 'bundle-load-only',
  }))
  return {
    schema: 'upstream-radar.dsh-load-matrix/v1alpha1',
    probe: 'dsh-matrix',
    scope: 'bundle-load-only',
    artifact: { path: '/tmp/demo-plugin.tgz', sha256: digest, name: 'demo-plugin', version: '1.0.0' },
    dshVersions: reports.map(report => report.dshVersion),
    reports,
    summary: { total: 2, compatible: 2, incompatible: 0, unknown: 0 },
    result: 'compatible',
    reason: 'all requested DSH versions loaded the bundle',
    boundary: 'bundle-load-only',
  }
}

describe('DSH plugin review', () => {
  it('combines exact artifact evidence with a DSH matrix and cleans the temporary artifact', async () => {
    let cleaned = false
    const report = await reviewDshPlugin('demo-plugin@1.0.0', {
      dshVersions: ['0.1.0-rc.6', '0.1.0-rc.7'],
      inspect: async () => scanReport(),
      pack: async () => ({ path: '/tmp/demo-plugin.tgz', cleanup: async () => { cleaned = true } }),
      probe: async options => {
        assert.equal(options.packagePath, '/tmp/demo-plugin.tgz')
        assert.deepEqual(options.dshVersions, ['0.1.0-rc.6', '0.1.0-rc.7'])
        return matrixReport()
      },
    })

    assert.equal(report.status, 'allow')
    assert.equal(report.artifact.matched, true)
    assert.equal(report.execution.llm, false)
    assert.equal(cleaned, true)
    assert.match(renderDshPluginReview(report), /DSH load matrix: COMPATIBLE \(2\/2 versions loaded\)/)
  })
})

