import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { collectDshWebBootRoster } from '../src/dsh-web-contract.js'
import { bindDshWebPackageVersions, parseDshWebPackageProvenance } from '../src/dsh-web-package-provenance.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const row = { id: 'fixture-plugin', url: '/plugins/??fixture-plugin/client.js&rev=opaque-1', rev: 'opaque-1', inject: [], external: [] }
const boot = collectDshWebBootRoster({ entries: [row] })
const raw = 'register("fixture-plugin", () => ({}));\n//# sourceMappingURL=client.js.map\n'
// The public single-entry combo representation of DSH's reviewed client-module server.
const served = 'register("fixture-plugin", () => ({}));\n;\n//# sourceMappingURL=/plugins/??fixture-plugin/client.js.map&rev=opaque-1\n'
const artifact = (version: string, client = raw) => ({ location: `profile/node_modules/fixture-plugin-${version}`,
  manifest: Buffer.from(JSON.stringify({ name: 'fixture-plugin', version, dsh: { client: { platform: 'web' } }, exports: { './client': './client.js' } })),
  clientPath: 'client.js', client: Buffer.from(client) })

it('binds an actual fetched browser bundle to its exact manifest and client bytes instead of a Node version or opaque revision', () => {
  const evidence = bindDshWebPackageVersions(boot, [{ id: row.id, url: row.url, status: 200, sha256: hash(served), bytes: Buffer.byteLength(served) }],
    { artifacts: [artifact('1.0.0', 'unrelated bytes'), artifact('2.0.0')], gaps: [] })
  assert.equal(evidence.entries[0]?.status, 'version-observed')
  assert.equal(evidence.entries[0]?.version, '2.0.0')
  assert.equal(evidence.entries[0]?.matches.length, 1)
  const match = evidence.entries[0]!.matches[0]!
  assert.equal(match.manifestSha256, hash(artifact('2.0.0').manifest))
  assert.equal(match.clientSha256, hash(raw))
  assert.equal(match.servedSha256, hash(served))
  assert.equal(match.transform, 'dsh-single-entry-combo/v1')
  assert.equal(evidence.bootSha256, boot.sha256)
})

it('retains duplicate package sources and refuses to choose between versions with identical served bytes', () => {
  const captures = [{ id: row.id, url: row.url, status: 200, sha256: hash(served), bytes: Buffer.byteLength(served) }]
  const inventory = { artifacts: [artifact('1.0.0'), artifact('2.0.0')], gaps: [] }
  const ambiguous = bindDshWebPackageVersions(boot, captures, inventory)
  assert.equal(ambiguous.entries[0]?.status, 'ambiguous')
  assert.equal(ambiguous.entries[0]?.version, undefined)
  assert.deepEqual(ambiguous.entries[0]?.matches.map(match => match.version), ['1.0.0', '2.0.0'])
  const duplicate = bindDshWebPackageVersions(boot, captures, { artifacts: [artifact('2.0.0'), { ...artifact('2.0.0'), location: 'dlx/another-copy' }], gaps: [] })
  assert.equal(duplicate.entries[0]?.status, 'version-observed')
  assert.equal(duplicate.entries[0]?.matches.length, 2)
})

it('keeps versions unconfirmed when the independent package inventory has a coverage gap or malformed manifest', () => {
  const captures = [{ id: row.id, url: row.url, status: 200, sha256: hash(served), bytes: Buffer.byteLength(served) }]
  for (const inventory of [
    { artifacts: [artifact('2.0.0')], gaps: ['dlx could not be inspected'] },
    { artifacts: [artifact('2.0.0'), { ...artifact('1.0.0'), manifest: Buffer.from('{bad') }], gaps: [] },
  ]) {
    const result = bindDshWebPackageVersions(boot, captures, inventory)
    assert.equal(result.entries[0]?.status, 'scan-incomplete')
    assert.equal(result.entries[0]?.version, undefined)
    assert.equal(result.entries[0]?.matches.length, 1)
    assert.ok(result.gaps.length > 0)
  }
})

it('rejects unbounded or contradictory input instead of trusting a supplied digest, URL, or package version', () => {
  const capture = { id: row.id, url: row.url, status: 200, sha256: hash(served), bytes: Buffer.byteLength(served) }
  const inventory = { artifacts: [artifact('2.0.0')], gaps: [] }
  assert.throws(() => bindDshWebPackageVersions({ ...boot, sha256: '0'.repeat(64) }, [capture], inventory), /roster digest/)
  assert.throws(() => bindDshWebPackageVersions(boot, [capture, capture], inventory), /duplicate/)
  assert.throws(() => bindDshWebPackageVersions(boot, [{ ...capture, url: '/different.js' }], inventory), /roster/)
  assert.throws(() => bindDshWebPackageVersions(boot, [{ ...capture, bytes: 9 * 1024 * 1024 }], inventory), /bound/)
  assert.throws(() => bindDshWebPackageVersions(boot, [capture], { artifacts: [{ ...artifact('2.0.0'), client: new Uint8Array(9 * 1024 * 1024) }], gaps: [] }), /bound/)
  assert.throws(() => bindDshWebPackageVersions(boot, [capture], { artifacts: Array.from({ length: 2049 }, () => artifact('2.0.0')), gaps: [] }), /bound/)
  const invalid = bindDshWebPackageVersions(boot, [capture], { artifacts: [artifact('banana')], gaps: [] })
  assert.equal(invalid.entries[0]?.status, 'scan-incomplete')
  assert.equal(invalid.entries[0]?.version, undefined)
})

it('round-trips independent fetch evidence and rejects altered versions, row bindings, and contradictory fetch failures', () => {
  const evidence = bindDshWebPackageVersions(boot, [{ id: row.id, url: row.url, status: 200, sha256: hash(served), bytes: Buffer.byteLength(served) }], { artifacts: [artifact('2.0.0')], gaps: [] })
  assert.deepEqual(parseDshWebPackageProvenance(JSON.parse(JSON.stringify(evidence)), boot), evidence)
  assert.equal(evidence.entries[0]?.capture?.sha256, hash(served))
  const changed = structuredClone(evidence)
  changed.entries[0]!.version = '9.0.0'
  assert.throws(() => parseDshWebPackageProvenance(changed, boot), /status|version|digest/)
  assert.throws(() => parseDshWebPackageProvenance(evidence, collectDshWebBootRoster({ entries: [{ ...row, rev: 'changed' }] })), /roster/)
  const failed = bindDshWebPackageVersions(boot, [{ id: row.id, url: row.url, status: 404 }], { artifacts: [artifact('2.0.0')], gaps: [] })
  assert.equal(failed.entries[0]?.status, 'fetch-failed')
  assert.equal(failed.entries[0]?.version, undefined)
  assert.deepEqual(parseDshWebPackageProvenance(failed, boot), failed)
})
