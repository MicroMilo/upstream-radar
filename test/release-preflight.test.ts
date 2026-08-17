import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = resolve(repository, 'scripts/release-preflight.mjs')

describe('release preflight', () => {
  it('proves the current release candidate is internally installable without publishing', () => {
    const result = spawnSync(process.execPath, [script, '--json'], {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout) as {
      schema: string
      version: string
      passed: boolean
      publishedCheck: boolean
      checks: Array<{ status: string }>
    }
    assert.equal(report.schema, 'upstream-radar.release-preflight/v1alpha1')
    assert.equal(report.version, '0.33.12')
    assert.equal(report.passed, true)
    assert.equal(report.publishedCheck, false)
    assert.ok(report.checks.length >= 4)
    assert.ok(report.checks.every(check => check.status === 'pass'))
  })
})
