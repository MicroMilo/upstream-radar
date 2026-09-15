import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { parseDshProfileEnvironment, prepareDshProfileOverrides, selectDshProfileEnvironment, verifyDshProfileOverrides } from '../src/dsh-profile-environment.js'

it('chooses an executable pinned pnpm for the inferred Node major without promoting development settings to profile requirements', () => {
  assert.equal(selectDshProfileEnvironment(undefined, 'headless', 20).pnpmVersion, '10.33.0')
  assert.equal(selectDshProfileEnvironment(undefined, 'headless', 22).pnpmVersion, '11.7.0')
  const development = { packageManagers: [{ name: 'pnpm' as const, version: '11.7.0', scope: 'development' as const,
    evidence: [{ path: 'package.json', quote: '"packageManager":"pnpm@11.7.0"' }] }],
    overrides: [], workflows: [], dshVersions: [] }
  assert.equal(selectDshProfileEnvironment(development, 'headless', 20).pnpmVersion, '10.33.0')
  const profile = { ...development, packageManagers: [{ ...development.packageManagers[0]!, scope: 'profile' as const }] }
  assert.throws(() => selectDshProfileEnvironment(profile, 'headless', 20), /Node 20.*pnpm 11/)
})

it('prepares and verifies only the selected isolated profile without following links or replacing existing settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-profile-settings-'))
  try {
    const environment = parseDshProfileEnvironment({ pnpmVersion: '10.33.0', overrides: { 'host-api': '1.0.0' } })
    const home = join(root, 'dsh-home')
    await mkdir(home)
    await prepareDshProfileOverrides(home, 'web', environment)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'profiles/web/pnpm-workspace.yaml'), 'utf8')).overrides, environment.overrides)
    assert.deepEqual(verifyDshProfileOverrides(environment, '{"host-api":"1.0.0"}'), environment)
    assert.throws(() => verifyDshProfileOverrides(environment, '{"host-api":"2.0.0"}'), /do not match/)
    assert.throws(() => verifyDshProfileOverrides(environment, ' '.repeat(65 * 1024)), /byte budget/)
    await assert.rejects(prepareDshProfileOverrides(home, 'web', environment), /EEXIST/)
    await assert.rejects(prepareDshProfileOverrides(home, '../outside', environment), /unsafe profile/)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'pnpm-workspace.yaml'), 'untouched')
    await symlink(outside, join(home, 'profiles/sdk'))
    await assert.rejects(prepareDshProfileOverrides(home, 'sdk', environment), /regular directory/)
    assert.equal(await readFile(join(outside, 'pnpm-workspace.yaml'), 'utf8'), 'untouched')
  } finally { await rm(root, { recursive: true, force: true }) }
})
