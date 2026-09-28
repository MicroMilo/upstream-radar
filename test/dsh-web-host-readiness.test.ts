import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { it } from 'node:test'
import { evaluateDshWebEvidence, waitForDshWebHttp } from '../src/dsh-surface-observation.js'

it('waits through the stock Web host transient 404 before handing its login endpoint to the browser', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    response.writeHead(++requests === 1 ? 404 : 401)
    response.end('operator-owned startup fixture')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const host = { exited: () => false, launchError: () => undefined, outputExceeded: () => false,
      code: () => null, output: () => '', stop: async () => true }
    const status = await waitForDshWebHttp(`http://127.0.0.1:${address.port}/`, host, 2_000)
    assert.equal(status, 401, 'an early routing 404 is not the ready DSH Web page')
    assert.equal(requests, 2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('keeps an unestablished Web readiness result unknown unless the host exit was actually observed', () => {
  const input = { driverAvailable: true, hostStarted: false, httpStatus: 404,
    rootMounted: false, bootManifestPresent: false, pluginEntryPresent: false,
    applicationMounted: false, pluginMaterialized: false, consoleErrors: [], pageErrors: [], failedRequests: [] }
  const result = evaluateDshWebEvidence(input)
  assert.equal(result.result, 'unknown')
  assert.equal(result.failedStage, 'host')
  assert.match(result.reason, /readiness.*not established/)
})

it('retains a final routing status and a real host exit instead of sending a dying host to the browser', async () => {
  let exited = false
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
    exited = true // Child-process boundary: the host exits after publishing a routing 404.
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const status = await waitForDshWebHttp(`http://127.0.0.1:${address.port}/`, {
      exited: () => exited, launchError: () => undefined, outputExceeded: () => false,
    }, 2_000)
    assert.equal(status, 404)
    const result = evaluateDshWebEvidence({ driverAvailable: true, hostStarted: false, hostExited: exited, httpStatus: status,
      rootMounted: false, bootManifestPresent: false, pluginEntryPresent: false,
      applicationMounted: false, pluginMaterialized: false, consoleErrors: [], pageErrors: [], failedRequests: [] })
    assert.equal(result.result, 'surface-incompatible')
    assert.equal(result.failedStage, 'host')
    assert.match(result.reason, /profile exited/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('bounds a nonresponding HTTP attempt by the remaining readiness budget', async () => {
  const server = createServer(() => { /* Operator-owned fixture never sends HTTP headers. */ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const started = Date.now()
    const status = await waitForDshWebHttp(`http://127.0.0.1:${address.port}/`, {
      exited: () => false, launchError: () => undefined, outputExceeded: () => false,
    }, 100)
    assert.equal(status, undefined)
    assert.ok(Date.now() - started < 1_000, 'the collector must not wait the full per-request timeout after its deadline')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
