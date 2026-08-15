import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('consumer smoke example', () => {
  it('uses a real DSH plugin graph and the published Action contract', async () => {
    const config = JSON.parse(await readFile(`${root}/examples/github-actions/consumer/upstream-radar.config.json`, 'utf8')) as {
      schema?: unknown
      projects?: Array<{
        plugins?: Array<{
          package?: { name?: unknown; version?: unknown }
          manifest?: { dsh?: unknown }
          graph?: { rootNodeId?: unknown; nodes?: unknown[]; edges?: unknown[] }
        }>
      }>
    }
    const workflow = await readFile(`${root}/.github/workflows/action-consumer-smoke.yml`, 'utf8')
    const plugin = config.projects?.[0]?.plugins?.[0]

    assert.equal(config.schema, 'upstream-radar.radar-config/v1alpha1')
    assert.equal(plugin?.package?.name, 'dsh-cloudflare-browser-run')
    assert.equal(plugin?.package?.version, '0.1.1')
    assert.deepEqual(plugin?.manifest?.dsh, { bundle: { patch: './cordis.patch.yml' } })
    assert.equal(plugin?.graph?.rootNodeId, 'node_modules/dsh-cloudflare-browser-run')
    assert.ok((plugin?.graph?.nodes?.length ?? 0) >= 18)
    assert.equal(plugin?.graph?.edges?.length, 65)
    assert.match(workflow, /uses: MicroMilo\/upstream-radar@v0\.22\.0/)
    assert.match(workflow, /config: examples\/github-actions\/consumer\/upstream-radar\.config\.json/)
    assert.match(workflow, /fail-on: high/)
    assert.match(workflow, /contents: read/)
  })
})
