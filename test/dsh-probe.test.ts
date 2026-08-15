import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { inspectDshLoadArtifact, probeDshLoad } from '../src/dsh-probe.js'
import { makeTarball } from './helpers/tar.js'

describe('DSH load probe', () => {
  it('preflights an exact DSH tarball without executing package code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-probe-test-'))
    const target = join(root, 'plugin.tgz')
    await writeFile(target, makeTarball([
      { path: 'package/package.json', contents: JSON.stringify({
        name: 'probe-plugin',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }) },
      { path: 'package/cordis.patch.yml', contents: '[]\n' },
    ]))

    try {
      const artifact = await inspectDshLoadArtifact(target)
      assert.equal(artifact.name, 'probe-plugin')
      assert.equal(artifact.version, '1.0.0')
      assert.equal(artifact.bundlePatch, 'cordis.patch.yml')
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses lifecycle scripts before opening a disposable DSH profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-probe-script-test-'))
    const target = join(root, 'plugin.tgz')
    await writeFile(target, makeTarball([
      { path: 'package/package.json', contents: JSON.stringify({
        name: 'probe-script-plugin',
        version: '1.0.0',
        scripts: { postinstall: 'node install.js' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }) },
      { path: 'package/cordis.patch.yml', contents: '[]\n' },
    ]))

    try {
      await assert.rejects(inspectDshLoadArtifact(target), /refuses lifecycle scripts: postinstall/)
      const report = await probeDshLoad({ packagePath: target, dshVersion: '0.1.0-rc.6' })
      assert.equal(report.result, 'unknown')
      assert.equal(report.stages.artifact.status, 'failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires an exact DSH version before touching the artifact', async () => {
    await assert.rejects(
      probeDshLoad({ packagePath: '/tmp/not-used.tgz', dshVersion: 'latest' }),
      /DSH version must be an exact semantic version/,
    )
  })
})
