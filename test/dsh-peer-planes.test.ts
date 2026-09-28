import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collectDshPeerPlaneEvidence,
  evaluateDshPeerContractCoverage,
  isExclusiveDshWebPeer,
  parseDshClientContract,
} from '../src/dsh-peer-planes.js'
import type { TarEntry } from '../src/tar.js'

const manifest = {
  main: './lib/host.js',
  exports: { '.': './lib/host.js', './client': { types: './lib/client.d.ts', default: './lib/client.js' } },
  dsh: { client: { platform: 'web', inject: ['client-slots'] } },
}
const file = (path: string, text: string): TarEntry => ({ path, type: 'file', mode: 0o644, digest: 'a'.repeat(64), size: Buffer.byteLength(text), contents: Buffer.from(text) })
const requirements = [{ name: 'react', required: '^18.2.0' }, { name: 'host-api', required: '1.0.0' }]

describe('DSH host and Web-client peer evidence', () => {
  it('preserves exact client platform, injection names and runtime exports, without treating types as executable entries', () => {
    assert.deepEqual(parseDshClientContract(manifest), {
      platform: 'web', inject: ['client-slots'], entryPoints: ['lib/client.js'],
    })
    assert.equal(parseDshClientContract({}), undefined)
    assert.deepEqual(parseDshClientContract({ dsh: { client: { platform: 'web' } } }), {
      platform: 'web', inject: [], entryPoints: [],
    })
  })

  it('rejects malformed, oversized and unsafe client metadata instead of silently reporting no client', () => {
    for (const client of [null, [], 'web', {}, { platform: 'web', inject: 'react' },
      { platform: 'web', inject: ['react', 'react'] }, { platform: 'web', inject: ['bad\nname'] },
      { platform: 'web', inject: ['react\n'] }, { platform: 'web', inject: ['react\u2028'] }, { platform: 'web\n' },
      { platform: 'web', inject: Array.from({ length: 65 }, (_, i) => `service-${i}`) }]) {
      assert.throws(() => parseDshClientContract({ dsh: { client } }), /client|inject/)
    }
    assert.throws(() => parseDshClientContract({ ...manifest, exports: { './client': '../escape.js' } }), /entry|path/)
    assert.throws(() => parseDshClientContract({ ...manifest, exports: { './client': './lib/*.js' } }), /entry|path/)
  })

  it('follows only bounded local file imports and keeps shared imports in both planes', () => {
    const entries = [
      file('lib/host.js', "import 'host-api'; import './shared.js'"),
      file('lib/client.js', "import 'react'; import './shared.js'"),
      file('lib/shared.js', "import 'host-api'"),
      file('lib/client.d.ts', "import type * as React from 'react'"),
    ]
    const evidence = collectDshPeerPlaneEvidence(manifest, entries, requirements)
    assert.equal(evidence[0]?.host, 'no-literal-reference-observed')
    assert.equal(evidence[0]?.webClient, 'runtime-import-observed')
    assert.equal(evidence[1]?.host, 'runtime-import-observed')
    assert.equal(evidence[1]?.webClient, 'runtime-import-observed')
  })

  it('does not attribute unrelated source files or dynamic paths to either runtime entry', () => {
    const entries = [file('lib/host.js', 'export {}'), file('lib/client.js', 'export {}'),
      file('src/unselected.ts', "import 'react'"), file('lib/client.d.ts', "import type * as React from 'react'")]
    const evidence = collectDshPeerPlaneEvidence(manifest, entries, requirements)
    assert.equal(evidence[0]?.host, 'no-literal-reference-observed')
    assert.equal(evidence[0]?.webClient, 'no-literal-reference-observed')
    assert.equal(evidence[0]?.unattributed, 'runtime-import-observed')
  })

  it('keeps unsupported client platforms out of Web evidence and Web-specific peer decisions', () => {
    for (const platform of ['tui', 'desktop']) {
      const clientManifest = { ...manifest, dsh: { client: { platform, inject: ['react'] } } }
      const evidence = collectDshPeerPlaneEvidence(clientManifest,
        [file('lib/host.js', 'export {}'), file('lib/client.js', "import 'react'")], requirements)[0]!
      assert.notEqual(evidence.webClient, 'runtime-import-observed')
      assert.equal(evidence.unattributed, 'runtime-import-observed')
      assert.equal(isExclusiveDshWebPeer({ usageByPlane: evidence, declaredClientInject: true }), false)
    }
  })

  it('does not mistake the client-server host export for the exact client subpath', () => {
    const evidence = collectDshPeerPlaneEvidence({ ...manifest,
      exports: { ...manifest.exports, './client-server': './lib/server.js' } },
    [file('lib/host.js', 'export {}'), file('lib/client.js', 'export {}'), file('lib/server.js', "import 'react'")], requirements)
    assert.equal(evidence[0]?.host, 'runtime-import-observed')
  })

  it('never follows tarball links, and marks missing or oversized entry coverage incomplete', () => {
    const link: TarEntry = { path: 'lib/client.js', type: 'symlink', mode: 0o644, digest: 'a'.repeat(64), size: 0, linkTarget: '../../outside.js' }
    for (const entries of [[file('lib/host.js', 'export {}'), link],
      [file('lib/host.js', 'export {}'), file('lib/client.js', ' '.repeat(8 * 1024 * 1024 + 1))]]) {
      assert.equal(collectDshPeerPlaneEvidence(manifest, entries, requirements)[0]?.webClient, 'scan-incomplete')
    }
  })

  it('does not let a type-only hit hide an uninspected dynamic host import', () => {
    const evidence = collectDshPeerPlaneEvidence(manifest,
      [file('lib/host.js', "import type { Node } from 'react'; import(variable)"), file('lib/client.js', "import 'react'")], requirements)
    assert.equal(evidence[0]?.host, 'scan-incomplete')
  })

  it('keeps missing peers as incomplete coverage, not an author-actionable incompatibility', () => {
    const verdict = evaluateDshPeerContractCoverage({ unresolved: 1, pluginPeerContracts: {
      declared: 1, satisfied: 0, mismatched: 0, indeterminate: 0, missing: 1,
      relations: [{ name: 'react', required: '^18.2.0', status: 'missing', staticUsage: 'runtime-import-observed',
        usageByPlane: { host: 'no-literal-reference-observed', webClient: 'runtime-import-observed', unattributed: 'no-literal-reference-observed' } }],
    } })
    assert.equal(verdict.result, 'unknown')
    assert.match(verdict.reason, /coverage|not.*runtime failure/i)
  })

  it('preserves resolved host declaration mismatches even when the load smoke succeeds', () => {
    assert.equal(evaluateDshPeerContractCoverage({ unresolved: 0, pluginPeerContracts: {
      declared: 1, satisfied: 0, mismatched: 1, indeterminate: 0, missing: 0,
      relations: [{ name: 'host-api', required: '1.0.0', status: 'mismatched', resolvedVersion: '2.0.0',
        staticUsage: 'runtime-import-observed' }],
    } }).result, 'peer-contract-incompatible')
  })

  it('does not use a Node-resolved version as proof of the browser module version', () => {
    assert.equal(evaluateDshPeerContractCoverage({ unresolved: 0, pluginPeerContracts: {
      declared: 1, satisfied: 0, mismatched: 1, indeterminate: 0, missing: 0,
      relations: [{ name: 'react', required: '^18.2.0', status: 'mismatched', resolvedVersion: '19.2.0',
        staticUsage: 'runtime-import-observed', usageByPlane: {
          clientPlatform: 'web', host: 'no-literal-reference-observed', webClient: 'runtime-import-observed', unattributed: 'no-literal-reference-observed',
        } }],
    } }).result, 'unknown')
  })
})
