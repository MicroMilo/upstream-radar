import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { collectDshHostBuildInventory, parseDshHostBuildInventory, collectDshHostNativeLoadFailures } from '../src/dsh-host-builds.js'

const version = '0.1.3-alpha.2'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: ${version}
        version: ${version}(peer@1.0.0)
packages:
  '@deepseek-ai/dsh@${version}': {}
  fs-ext@2.1.1: {}
snapshots:
  '@deepseek-ai/dsh@${version}(peer@1.0.0)':
    dependencies:
      fs-ext: 2.1.1
  fs-ext@2.1.1: {}
`

it('attributes a native module error only to its exact physical DSH host package, never the plugin profile', () => {
  const location = 'pnpm/dlx/key/instance'
  const packageLocation = `${location}/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext`
  const inventory = parseDshHostBuildInventory({ revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts', dshVersion: version,
    pnpmVersion: '11.7.0', installation: { location, manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64),
      lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` }, coverageGaps: [],
    packages: [{ spec: 'fs-ext@2.1.1', location: packageLocation, manifestSha256: '5'.repeat(64),
      lifecycleScripts: { install: 'node-gyp configure build' }, metadataSources: ['pendingBuilds'], reportedLocators: ['fs-ext@2.1.1'] }] })
  const output = `Error: Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- /sandbox/cache/${packageLocation}/fs-ext.js\n`
  const failures = collectDshHostNativeLoadFailures(inventory, '/sandbox/cache', output)
  assert.deepEqual(failures, [{ scope: 'dsh-host-native-load-failure', packageSpec: 'fs-ext@2.1.1', manifestSha256: '5'.repeat(64),
    missingModule: './build/Release/fs_ext.node', requiringFile: `${packageLocation}/fs-ext.js`, outputSha256: hash(output) }])
  for (const changed of [output.replace('/sandbox/cache/', '/sandbox/dsh-home/profiles/web/'),
    output.replace('fs-ext@2.1.1', 'fs-ext@2.0.0'), output.replace('fs_ext.node', 'ordinary.js'),
    `Cannot find module './build/Release/fs_ext.node'\nUnrelated path: /sandbox/cache/${packageLocation}/fs-ext.js`,
    output.replace('./build/Release/fs_ext.node', '../../../outside.node'), output.repeat(10_000)]) {
    assert.deepEqual(collectDshHostNativeLoadFailures(inventory, '/sandbox/cache', changed), [])
  }
  assert.deepEqual(collectDshHostNativeLoadFailures({ ...inventory, coverageGaps: ['metadata incomplete'] }, '/sandbox/cache', output), [])
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'radar-host-builds-'))
  const installation = join(root, 'pnpm/dlx/cache-key/instance')
  const hostDirectory = join(installation, `node_modules/.pnpm/@deepseek-ai+dsh@${version}/node_modules/@deepseek-ai/dsh`)
  const dependencyDirectory = join(installation, 'node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext')
  const manifest = JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } })
  const hostManifest = JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { 'fs-ext': '2.1.1' } })
  const dependencyManifest = JSON.stringify({ name: 'fs-ext', version: '2.1.1', scripts: { install: 'node-gyp configure build' } })
  const cleanup = () => rm(root, { recursive: true, force: true })
  try {
    await mkdir(hostDirectory, { recursive: true })
    await mkdir(dependencyDirectory, { recursive: true })
    await writeFile(join(installation, 'package.json'), manifest)
    await writeFile(join(installation, 'pnpm-lock.yaml'), lockfile)
    // pnpm 11.7 writes JSON to this historical .yaml filename. Under
    // ignoreScripts the relevant field is pendingBuilds, not ignoredBuilds.
    await writeFile(join(installation, 'node_modules/.modules.yaml'), JSON.stringify({
      packageManager: 'pnpm@11.7.0', pendingBuilds: ['fs-ext@2.1.1'], virtualStoreDir: '.pnpm',
    }))
    await writeFile(join(hostDirectory, 'package.json'), hostManifest)
    await writeFile(join(dependencyDirectory, 'package.json'), dependencyManifest)
    await symlink('.pnpm/fs-ext@2.1.1/node_modules/fs-ext', join(installation, 'node_modules/fs-ext'))
    return { root, installation, hostDirectory, dependencyDirectory, manifest, hostManifest, dependencyManifest, cleanup }
  } catch (error) { await cleanup(); throw error }
}

it('collects exact pending host-build facts from pnpm JSON metadata without treating pending as a verdict', async () => {
  const { root, manifest, hostManifest, dependencyManifest, cleanup } = await fixture()
  try {
    const inventory = await collectDshHostBuildInventory(root, version)
    if (process.platform !== 'linux') {
      assert.deepEqual(inventory.packages, [])
      assert.match(inventory.coverageGaps.join(';'), /requires Linux/)
      return
    }
    assert.deepEqual(inventory.coverageGaps, [])
    assert.equal(inventory.scope, 'dsh-host-build-facts')
    assert.equal(inventory.dshVersion, version)
    assert.equal(inventory.pnpmVersion, '11.7.0')
    assert.equal(inventory.installation?.manifestSha256, hash(manifest))
    assert.equal(inventory.installation?.hostManifestSha256, hash(hostManifest))
    assert.equal(inventory.installation?.lockfileSha256, hash(lockfile))
    assert.match(inventory.installation?.lockGraphDigest ?? '', /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(inventory.packages.map(item => item.spec), ['fs-ext@2.1.1'])
    assert.deepEqual(inventory.packages[0]?.metadataSources, ['pendingBuilds'])
    assert.equal(inventory.packages[0]?.manifestSha256, hash(dependencyManifest))
    assert.deepEqual(inventory.packages[0]?.lifecycleScripts, { install: 'node-gyp configure build' })
    assert.equal(Reflect.get(inventory.packages[0]!, 'buildSucceeded'), undefined)
    assert.equal(Reflect.get(inventory.packages[0]!, 'buildRequired'), undefined)
    assert.deepEqual(parseDshHostBuildInventory(JSON.parse(JSON.stringify(inventory))), inventory)
  } finally { await cleanup() }
})

it('ignores the pnpm virtual-store hoisted alias directory without losing physical build facts', { skip: process.platform !== 'linux' }, async () => {
  const { root, installation, cleanup } = await fixture()
  try {
    const aliases = join(installation, 'node_modules/.pnpm/node_modules')
    await mkdir(aliases)
    await symlink('../fs-ext@2.1.1/node_modules/fs-ext', join(aliases, 'fs-ext'))
    const inventory = await collectDshHostBuildInventory(root, version)
    assert.deepEqual(inventory.coverageGaps, [])
    assert.ok(inventory.installation)
    assert.deepEqual(inventory.packages.map(item => item.spec), ['fs-ext@2.1.1'])
  } finally { await cleanup() }
})

it('preserves duplicate package versions and scoped peer locators as distinct physical facts', { skip: process.platform !== 'linux' }, async () => {
  const { root, installation, cleanup } = await fixture()
  try {
    const additional = [
      { name: 'fs-ext', version: '2.0.0', key: 'fs-ext@2.0.0' },
      { name: '@scope/helper', version: '1.0.0', key: '@scope+helper@1.0.0_peer@2.0.0' },
      { name: '@scope/helper', version: '1.0.0', key: '@scope+helper@1.0.0_peer@3.0.0' },
    ]
    for (const item of additional) {
      const path = join(installation, `node_modules/.pnpm/${item.key}/node_modules/${item.name}`)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'package.json'), JSON.stringify({ name: item.name, version: item.version, scripts: { postinstall: 'operator-owned fixture only' } }))
    }
    await writeFile(join(installation, 'pnpm-lock.yaml'), lockfile.replace('      fs-ext: 2.1.1',
      "      fs-ext: 2.1.1\n      '@scope/helper': 1.0.0(peer@2.0.0)")
      + "  fs-ext@2.0.0: {}\n  '@scope/helper@1.0.0(peer@2.0.0)':\n    dependencies:\n      fs-ext: 2.0.0\n  '@scope/helper@1.0.0(peer@3.0.0)': {}\n")
    await writeFile(join(installation, 'node_modules/.modules.yaml'), JSON.stringify({ packageManager: 'pnpm@11.7.0', virtualStoreDir: '.pnpm',
      pendingBuilds: ['fs-ext@2.1.1', 'fs-ext@2.0.0', '@scope/helper@1.0.0(peer@2.0.0)', '@scope/helper@1.0.0(peer@3.0.0)'],
      ignoredBuilds: ['fs-ext@2.0.0'] }))
    const inventory = await collectDshHostBuildInventory(root, version)
    assert.deepEqual(inventory.coverageGaps, [])
    assert.deepEqual(inventory.packages.map(item => item.spec).sort(), ['@scope/helper@1.0.0', '@scope/helper@1.0.0', 'fs-ext@2.0.0', 'fs-ext@2.1.1'])
    assert.equal(new Set(inventory.packages.map(item => item.location)).size, 4)
    assert.deepEqual(inventory.packages.find(item => item.spec === 'fs-ext@2.0.0')?.metadataSources, ['ignoredBuilds', 'pendingBuilds'])
    assert.deepEqual(inventory.packages[0]?.reportedLocators, ['@scope/helper@1.0.0(peer@2.0.0)', '@scope/helper@1.0.0(peer@3.0.0)'])
  } finally { await cleanup() }
})

it('does not follow a replaced manifest or a symlinked cache ancestor', { skip: process.platform !== 'linux' }, async () => {
  const { root, dependencyDirectory, cleanup } = await fixture()
  try {
    const outside = join(root, 'external-manifest.json')
    await writeFile(outside, JSON.stringify({ name: 'fs-ext', version: '2.1.1', scripts: { install: 'external sentinel must not be read' } }))
    await rename(join(dependencyDirectory, 'package.json'), join(dependencyDirectory, 'package.saved'))
    await symlink(outside, join(dependencyDirectory, 'package.json'))
    const manifest = await collectDshHostBuildInventory(root, version)
    assert.equal(manifest.installation, undefined)
    assert.equal(manifest.packages.length, 0)
    assert.ok(manifest.coverageGaps.length > 0)
    assert.ok(!JSON.stringify(manifest).includes('external sentinel'))
    await rename(join(root, 'pnpm'), join(root, 'moved-pnpm'))
    await symlink('moved-pnpm', join(root, 'pnpm'))
    const ancestor = await collectDshHostBuildInventory(root, version)
    assert.equal(ancestor.installation, undefined)
    assert.equal(ancestor.packages.length, 0)
    assert.ok(ancestor.coverageGaps.length > 0)
  } finally { await cleanup() }
})

it('retains incomplete coverage for unsupported, absent and oversized build metadata', { skip: process.platform !== 'linux' }, async () => {
  const { root, installation, cleanup } = await fixture()
  try {
    for (const metadata of [
      'pendingBuilds:\n  - fs-ext@2.1.1\n',
      JSON.stringify({ packageManager: 'pnpm@11.7.0', virtualStoreDir: '.pnpm' }),
      JSON.stringify({ packageManager: `pnpm@11.7.0-${'a'.repeat(200)}`, virtualStoreDir: '.pnpm', pendingBuilds: ['fs-ext@2.1.1'] }),
      JSON.stringify({ packageManager: 'pnpm@11.7.0', virtualStoreDir: '.pnpm', pendingBuilds: Array(65).fill('fs-ext@2.1.1') }),
      ' '.repeat(4 * 1024 * 1024 + 1),
    ]) {
      await writeFile(join(installation, 'node_modules/.modules.yaml'), metadata)
      const inventory = await collectDshHostBuildInventory(root, version)
      assert.ok(inventory.coverageGaps.length > 0)
      assert.equal(inventory.installation, undefined)
      assert.deepEqual(parseDshHostBuildInventory(inventory), inventory)
    }
    await writeFile(join(installation, 'node_modules/.modules.yaml'), JSON.stringify({ packageManager: 'pnpm@11.7.0',
      virtualStoreDir: '.pnpm', pendingBuilds: ['fs-ext@2.1.1', 'absent-package@1.0.0'] }))
    const missing = await collectDshHostBuildInventory(root, version)
    assert.equal(missing.packages.length, 1)
    assert.match(missing.coverageGaps.join(';'), /absent from.*lock graph/)
    assert.match(missing.coverageGaps.join(';'), /physical manifest unavailable/)
    assert.deepEqual(parseDshHostBuildInventory(missing), missing)
  } finally { await cleanup() }
})

it('never emits a physical package coordinate that its persisted inventory parser cannot accept', { skip: process.platform !== 'linux' }, async () => {
  const { root, installation, cleanup } = await fixture()
  try {
    const name = 'x'.repeat(215)
    const directory = join(installation, 'node_modules/.pnpm/oversized-package/node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { install: 'fixture only' } }))
    await writeFile(join(installation, 'node_modules/.modules.yaml'), JSON.stringify({ packageManager: 'pnpm@11.7.0',
      virtualStoreDir: '.pnpm', pendingBuilds: ['fs-ext@2.1.1', `${name}@1.0.0`] }))
    const inventory = await collectDshHostBuildInventory(root, version)
    assert.ok(inventory.coverageGaps.length > 0)
    assert.ok(!inventory.packages.some(item => item.spec === `${name}@1.0.0`))
    assert.deepEqual(parseDshHostBuildInventory(inventory), inventory)
  } finally { await cleanup() }
})
