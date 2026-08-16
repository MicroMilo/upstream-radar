import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const summaryScript = resolve(repository, 'scripts/action-summary.mjs')

describe('GitHub Action summary', () => {
  it('turns the machine report into a concise escaped job summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-action-summary-'))
    try {
      const report = join(root, 'report.json')
      await writeFile(report, JSON.stringify({
        packagesQueried: 3,
        releasePackagesQueried: 1,
        events: [{
          kind: 'vulnerability',
          change: 'new',
          affected: { name: 'parser', version: '2.9.0' },
          advisory: { id: 'GHSA-`demo`', severity: 'high' },
          paths: [[
            { name: 'plugin', version: '1.0.0' },
            { name: 'parser', version: '2.9.0' },
          ]],
        }],
        sourceErrors: [{ source: 'osv', message: 'temporary outage' }],
        policy: { status: 'fail' },
      }))
      const result = spawnSync(process.execPath, [summaryScript, report], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /## Upstream Radar/)
      assert.match(result.stdout, /source check incomplete/)
      assert.match(result.stdout, /HIGH · vulnerability/)
      assert.match(result.stdout, /plugin@1\.0\.0/)
      assert.match(result.stdout, /GHSA-\\`demo\\`/)
      assert.match(result.stdout, /### Source warnings/)
      assert.match(result.stdout, /temporary outage/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

