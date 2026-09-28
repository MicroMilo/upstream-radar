import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseDshStartupConfiguration } from '../src/dsh-startup-configuration.js'

it('permits bounded additive offline or disabled startup checks, never arbitrary commands, credentials or host runtime overrides', () => {
  const configuration = { scope: 'Web settings only; messaging bridge stopped', environment: { DSH_LARK_DISABLED: '1' } }
  assert.deepEqual(parseDshStartupConfiguration(configuration), configuration)
  assert.equal(parseDshStartupConfiguration(undefined), undefined)
  for (const environment of [{ NODE_OPTIONS: '--require=./target.js' }, { DSH_HOME: '/outside' }, { DSH_LARK_APP_SECRET: 'secret' },
    { DSH_LARK_DISABLED: '0' }, { DSH_LARK_DISABLED: '$(run)' }, { PATH: '/target/bin' }, {}]) {
    assert.throws(() => parseDshStartupConfiguration({ ...configuration, environment }), /startup/)
  }
  assert.throws(() => parseDshStartupConfiguration({ ...configuration, scope: '' }), /scope/)
})
