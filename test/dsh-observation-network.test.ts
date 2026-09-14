import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { observationNetworkEnvironment } from '../src/dsh-observation-network.js'

describe('isolated observation network transport', () => {
  it('defaults to no inherited network configuration', () => {
    assert.deepEqual(observationNetworkEnvironment(undefined), {})
  })

  it('accepts only an explicitly supplied credential-free HTTP proxy', () => {
    assert.deepEqual(observationNetworkEnvironment('http://192.168.5.2:7897'), {
      HTTP_PROXY: 'http://192.168.5.2:7897/',
      HTTPS_PROXY: 'http://192.168.5.2:7897/',
      http_proxy: 'http://192.168.5.2:7897/',
      https_proxy: 'http://192.168.5.2:7897/',
      NODE_USE_ENV_PROXY: '1',
    })
    assert.equal(observationNetworkEnvironment('https://proxy.example:8443').HTTPS_PROXY, 'https://proxy.example:8443/')
  })

  it('rejects credentials, paths, queries and non-HTTP endpoints', () => {
    for (const value of ['http://user:secret@proxy.example', 'http://proxy.example/path',
      'http://proxy.example/?token=secret', 'http://proxy.example/#secret',
      'socks5://proxy.example', '', 'http://', 'http://proxy.example/' + 'a'.repeat(2048)]) {
      assert.throws(() => observationNetworkEnvironment(value), /credential-free HTTP proxy/)
    }
  })
})
