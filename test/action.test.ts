import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

describe('reusable GitHub Action', () => {
  it('keeps the published Action thin, pinned, and frozen', async () => {
    const actionPath = fileURLToPath(new URL('../../action.yml', import.meta.url))
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const action = await readFile(actionPath, 'utf8')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown }

    assert.equal(typeof packageJson.version, 'string')
    assert.match(action, /runs:\n\s+using: composite/)
    assert.match(action, new RegExp(`default: ${String(packageJson.version).replaceAll('.', '\\.')}`))
    assert.match(action, /description: ['"]Radar state path; use :memory: for an independent CI check\.['"]/)
    assert.match(action, /uses: pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6\.0\.10/)
    assert.match(action, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/)
    assert.match(action, /RADAR_CONFIG: \$\{\{ inputs\.config \}\}/)
    assert.match(action, /RADAR_FAIL_ON: \$\{\{ inputs\.fail-on \}\}/)
    assert.match(action, /RADAR_STATE: \$\{\{ inputs\.state \}\}/)
    assert.match(action, /RADAR_VERSION: \$\{\{ inputs\.version \}\}/)
    assert.match(action, /pnpm dlx --package="upstream-radar@\$RADAR_VERSION" upstream-radar/)
    assert.match(action, /--frozen/)
    assert.match(action, /--state "\$RADAR_STATE"/)
    assert.match(action, /--fail-on "\$RADAR_FAIL_ON"/)
    assert.match(action, /--json/)
    assert.doesNotMatch(action, /pnpm install|npm install/)
  })
})
