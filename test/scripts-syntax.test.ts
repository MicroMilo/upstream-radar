import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scriptsDirectory = resolve(repository, 'scripts')

describe('executable script syntax', () => {
  it('keeps every checked-in .mjs script parseable by the current Node runtime', async () => {
    const entries = await readdir(scriptsDirectory, { withFileTypes: true })
    const scripts = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
      .map(entry => resolve(scriptsDirectory, entry.name))
      .sort()
    assert.ok(scripts.length > 0)

    for (const script of scripts) {
      const result = spawnSync(process.execPath, ['--check', script], {
        cwd: repository,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      })
      assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`)
    }
  })
})
