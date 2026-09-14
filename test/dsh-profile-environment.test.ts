import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { parseDshProfileEnvironment, prepareDshProfileOverrides, verifyDshProfileOverrides } from '../src/dsh-profile-environment.js'

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
