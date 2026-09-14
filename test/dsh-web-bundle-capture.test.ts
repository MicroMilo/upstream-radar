import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { it } from 'node:test'
import { captureDshWebBundles } from '../src/dsh-web-bundle-capture.js'

it('captures actual same-origin bundle bytes with independent HTTP failures and a bounded body', async () => {
  const body = Buffer.from('actual browser bytes')
  const server = createServer((request, response) => {
    if (request.url === '/ok') response.end(body)
    else if (request.url === '/large') response.end(Buffer.alloc(9 * 1024 * 1024))
    else if (request.url === '/redirect') { response.writeHead(302, { location: '/ok' }); response.end() }
    else { response.writeHead(404); response.end('missing') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}/`
    const entries = ['ok', 'missing', 'large', 'redirect'].map(id => ({ id, url: `/${id}` }))
    const captures = await captureDshWebBundles({ baseUrl, entries })
    assert.equal(captures[0]?.status, 200)
    assert.equal(captures[0]?.bytes, body.length)
    assert.equal(captures[0]?.sha256, createHash('sha256').update(body).digest('hex'))
    assert.equal(captures[1]?.status, 404)
    assert.equal(captures[1]?.sha256, undefined)
    assert.equal(captures[2]?.sha256, undefined)
    assert.match(captures[2]?.error ?? '', /budget/)
    assert.equal(captures[3]?.sha256, undefined)
    assert.ok(captures[3]?.error)
    const external = await captureDshWebBundles({ baseUrl, entries: [{ id: 'external', url: 'https://example.org/no-request' }] })
    assert.match(external[0]?.error ?? '', /origin/)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
