import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectDshWebBootRoster, parseDshWebContractEvidence } from '../src/dsh-web-contract.js'

const wire = { entries: [{ id: 'plugin', url: '/client/plugin.js?rev=opaque', rev: 'opaque',
  inject: ['client-slots'], external: ['react'] }] }

describe('independent bounded DSH browser contract evidence', () => {
  it('preserves actual browser rows and injection edges without inventing package versions', () => {
    const boot = collectDshWebBootRoster(wire)
    assert.match(boot.sha256, /^[a-f0-9]{64}$/)
    const evidence = { revision: 'dsh-web-client-contract/1', peerVersions: 'not-observed', boot,
      client: { platform: 'web', inject: ['client-slots'], entryPoints: ['lib/client.js'] },
      pluginBundle: { sha256: 'a'.repeat(64), bytes: 100 } }
    assert.deepEqual(parseDshWebContractEvidence(evidence), evidence)
    assert.equal('version' in boot.entries[0]!, false)
  })

  it('rejects truncated, malformed, duplicate and non-loopback browser rosters', () => {
    for (const item of [{}, { entries: Array.from({ length: 513 }, () => wire.entries[0]) },
      { entries: [...wire.entries, ...wire.entries] },
      { entries: [{ ...wire.entries[0], external: 'react' }] },
      { entries: [{ ...wire.entries[0], url: 'https://example.org/plugin.js' }] }]) {
      assert.throws(() => collectDshWebBootRoster(item), /boot|roster|entry|loopback|external/)
    }
  })

  it('rejects tampered roster digests and unbounded bundle evidence', () => {
    const evidence = { revision: 'dsh-web-client-contract/1', peerVersions: 'not-observed', boot: collectDshWebBootRoster(wire) }
    assert.throws(() => parseDshWebContractEvidence({ ...evidence, boot: { ...evidence.boot, sha256: 'b'.repeat(64) } }), /digest/)
    assert.throws(() => parseDshWebContractEvidence({ ...evidence, pluginBundle: { sha256: 'a'.repeat(64), bytes: 8 * 1024 * 1024 + 1 } }), /bundle|bytes/)
    assert.throws(() => parseDshWebContractEvidence({ ...evidence, pluginBundle: { sha256: 'a'.repeat(64) + '\n', bytes: 100 } }), /bundle|digest/)
  })
})
