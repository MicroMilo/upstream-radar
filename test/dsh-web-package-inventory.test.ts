import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { collectDshWebPackageInventory } from '../src/dsh-web-package-inventory.js'

it('reads physical pnpm package bytes without following its package aliases, or reports an unsupported safe filesystem API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-web-inventory-'))
  try {
    const location = 'profile/node_modules/.pnpm/fixture@2/node_modules/fixture-plugin'
    await mkdir(join(root, location), { recursive: true })
    const manifest = JSON.stringify({ name: 'fixture-plugin', version: '2.0.0', exports: { './client': './client.js' }, dsh: { client: { platform: 'web' } } })
    await writeFile(join(root, location, 'package.json'), manifest)
    await writeFile(join(root, location, 'client.js'), 'actual client bytes')
    await symlink('.pnpm/fixture@2/node_modules/fixture-plugin', join(root, 'profile/node_modules/fixture-plugin'))
    const inventory = await collectDshWebPackageInventory(root, ['profile'], ['fixture-plugin'])
    if (process.platform !== 'linux') {
      assert.deepEqual(inventory.artifacts, [])
      assert.match(inventory.gaps.join(';'), /requires Linux/)
      return
    }
    assert.deepEqual(inventory.gaps, [])
    assert.equal(inventory.artifacts.length, 1)
    assert.equal(inventory.artifacts[0]?.location, location)
    assert.equal(Buffer.from(inventory.artifacts[0]!.manifest).toString(), manifest)
    assert.equal(Buffer.from(inventory.artifacts[0]!.client).toString(), 'actual client bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('preserves gaps for external package aliases, symlinked client ancestors, malformed metadata and oversized client bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-web-inventory-boundary-'))
  try {
    await mkdir(join(root, 'profile/node_modules/plugin'), { recursive: true })
    await mkdir(join(root, 'outside'), { recursive: true })
    await writeFile(join(root, 'outside/client.js'), 'must not enter the inventory')
    await symlink('../../outside', join(root, 'profile/node_modules/external'))
    await symlink('../../../outside', join(root, 'profile/node_modules/plugin/dist'))
    await writeFile(join(root, 'profile/node_modules/plugin/package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0',
      exports: { './client': './dist/client.js' }, dsh: { client: { platform: 'web' } } }))
    const linked = await collectDshWebPackageInventory(root, ['profile'], ['plugin'])
    assert.equal(linked.artifacts.length, 0)
    assert.ok(linked.gaps.length > 0)
    if (process.platform !== 'linux') return // Linux container execution exercises the physical-file checks below.
    assert.match(linked.gaps.join(';'), /alias/)
    assert.match(linked.gaps.join(';'), /client/)
    await writeFile(join(root, 'profile/node_modules/plugin/package.json'), '{invalid')
    assert.match((await collectDshWebPackageInventory(root, ['profile'], ['plugin'])).gaps.join(';'), /metadata/)
    await writeFile(join(root, 'profile/node_modules/plugin/package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0',
      exports: { './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
    await writeFile(join(root, 'profile/node_modules/plugin/client.js'), Buffer.alloc(9 * 1024 * 1024))
    const large = await collectDshWebPackageInventory(root, ['profile'], ['plugin'])
    assert.equal(large.artifacts.length, 0)
    assert.match(large.gaps.join(';'), /client/)
    await symlink('profile', join(root, 'linked-profile'))
    assert.match((await collectDshWebPackageInventory(root, ['linked-profile'], ['plugin'])).gaps.join(';'), /root unavailable/)
    await assert.rejects(collectDshWebPackageInventory(root, ['../outside'], ['plugin']), /inside/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
