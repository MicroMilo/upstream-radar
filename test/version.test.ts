import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { TOOL_VERSION } from '../src/version.js'

describe('release metadata', () => {
  it('keeps the runtime tool version aligned with package.json', async () => {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown }
    assert.equal(TOOL_VERSION, packageJson.version)
  })
})
