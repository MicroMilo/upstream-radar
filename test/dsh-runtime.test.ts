import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { discoverDshRuntimeNodeModulesDirectory } from '../src/dsh-runtime.js'

describe('DSH runtime dependency discovery', () => {
  it('finds the node_modules directory beside the exact DSH CLI package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-runtime-'))
    try {
      const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
      await mkdir(join(dshRoot, 'lib'), { recursive: true })
      await mkdir(join(dshRoot, 'node_modules', '.bin'), { recursive: true })
      await mkdir(join(root, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
      await writeFile(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }))
      await writeFile(join(dshRoot, 'lib', 'bin.js'), '')

      assert.equal(
        discoverDshRuntimeNodeModulesDirectory(join(dshRoot, 'lib', 'bin.js')),
        await realpath(join(root, 'node_modules')),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not trust an arbitrary package or a missing entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-runtime-'))
    try {
      const packageRoot = join(root, 'node_modules', '@not-dsh', 'dsh')
      await mkdir(join(packageRoot, 'lib'), { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@not-dsh/dsh', version: '1.0.0' }))
      await writeFile(join(packageRoot, 'lib', 'bin.js'), '')

      assert.equal(discoverDshRuntimeNodeModulesDirectory(join(packageRoot, 'lib', 'bin.js')), undefined)
      assert.equal(discoverDshRuntimeNodeModulesDirectory(join(root, 'missing.js')), undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
