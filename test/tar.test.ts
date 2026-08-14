import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseNpmTarball } from '../src/tar.js'
import { makeTarball } from './helpers/tar.js'

describe('npm tarball parser', () => {
  it('parses regular files rooted under package/', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/lib/index.js', contents: 'export {}\n' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.deepEqual(parsed.entries.map(entry => entry.path), ['package.json', 'lib/index.js'])
    assert.equal(parsed.unpackedBytes, Buffer.byteLength('{"name":"demo"}export {}\n'))
    assert.equal(parsed.findings.length, 0)
    assert.match(parsed.treeDigest, /^sha256:[0-9a-f]{64}$/)
  })

  it('accepts a consistent legacy npm top-level directory', () => {
    const tarball = makeTarball([
      { path: 'node/package.json', contents: '{"name":"@types/node"}' },
      { path: 'node/index.d.ts', contents: 'export {}\n' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.deepEqual(parsed.entries.map(entry => entry.path), ['package.json', 'index.d.ts'])
    assert.equal(parsed.findings.length, 0)
  })

  it('blocks archives with inconsistent top-level directories', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'other/payload.js', contents: 'payload' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-unsafe-path'))
  })

  it('blocks parent traversal entries without materializing them', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/../../outside', contents: 'escape' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-unsafe-path' && finding.severity === 'critical'))
    assert.ok(!parsed.entries.some(entry => entry.path.includes('outside')))
  })

  it('blocks symlinks that escape the package root', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/lib/link', type: 'symlink', linkTarget: '../../outside' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-link-escapes-package'))
  })

  it('detects portable case collisions', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/Lib.js', contents: 'one' },
      { path: 'package/lib.js', contents: 'two' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-path-collision'))
  })

  it('blocks a file that is also the parent of another archive path', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/a', contents: 'file' },
      { path: 'package/a/child.js', contents: 'child' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-path-topology-conflict'))
  })

  it('blocks paths with Windows alternate-stream characters', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/config:secret', contents: 'hidden' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-unsafe-path'))
  })

  it('blocks paths containing terminal control characters', () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"demo"}' },
      { path: 'package/bad\nname.js', contents: 'hidden' },
    ])

    const parsed = parseNpmTarball(tarball)
    assert.ok(parsed.findings.some(finding => finding.code === 'archive-unsafe-path'))
  })

  it('counts unsafe entries against the archive entry budget', () => {
    const tarball = makeTarball([
      { path: 'package/../../one', contents: 'one' },
      { path: 'package/../../two', contents: 'two' },
    ])

    assert.throws(() => parseNpmTarball(tarball, { maxEntries: 1 }), /entry count exceeds/)
  })

  it('counts metadata records against decompression budgets', () => {
    const tarball = makeTarball([
      { path: 'pax-header', contents: '20 path=package/a.js\n', type: 'pax' },
    ])

    assert.throws(() => parseNpmTarball(tarball, { maxFileBytes: 8 }), /per-entry budget/)
  })

  it('rejects PAX size overrides the parser cannot account for safely', () => {
    const tarball = makeTarball([
      { path: 'pax-header', contents: '10 size=1\n', type: 'pax' },
      { path: 'package/a.js', contents: 'x' },
    ])

    assert.throws(() => parseNpmTarball(tarball), /unsupported PAX size override/)
  })
})
