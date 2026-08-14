import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderTextReport } from '../src/render.js'
import { scanDirectory } from '../src/scan.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('text report rendering', () => {
  it('escapes terminal control characters from package metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-notary-render-'))
    await writeFile(join(root, 'package.json'), '{"name":"demo\\n\\u001b[31mred","version":"1.0.0"}')

    const rendered = renderTextReport(await scanDirectory(root))
    assert.ok(!rendered.includes('\u001b'))
    assert.match(rendered, /demo\\u000a\\u001b\[31mred/)
  })
})
