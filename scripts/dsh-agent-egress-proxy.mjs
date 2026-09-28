#!/usr/bin/env node
// Trusted, credential-free CONNECT relay for the disposable YOLO supervisor.
// Target plugin workers never receive this network or the Codex credential.
import { lookup } from 'node:dns/promises'
import { createServer, isIP, connect } from 'node:net'

const allowed = new Set(['api.openai.com', 'chatgpt.com', 'auth.openai.com'])
const PORT = 43128
const MAX_CLIENTS = 64
const MAX_TUNNEL_BYTES = 64 * 1024 * 1024
let clients = 0
const upstreamProxy = process.env.RADAR_UPSTREAM_PROXY ? new URL(process.env.RADAR_UPSTREAM_PROXY) : undefined
const upstreamProxyPort = upstreamProxy?.port ? Number(upstreamProxy.port) : 80
if (upstreamProxy && (upstreamProxy.protocol !== 'http:' || upstreamProxy.username || upstreamProxy.password
  || upstreamProxy.pathname !== '/' || upstreamProxy.search || upstreamProxy.hash
  || !Number.isSafeInteger(upstreamProxyPort) || upstreamProxyPort < 1)) {
  throw new Error('the agent egress relay accepts only an exact credential-free HTTP upstream proxy')
}

function publicIPv4(address) {
  if (isIP(address) !== 4) return false
  const [first, second, third] = address.split('.').map(Number)
  return first > 0 && first < 224 && first !== 10 && first !== 127
    && !(first === 169 && second === 254)
    && !(first === 192 && (second === 168 || second === 0 && third <= 2))
    && !(first === 198 && (second === 18 || second === 19 || second === 51 && third === 100))
    && !(first === 203 && second === 0 && third === 113)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 100 && second >= 64 && second <= 127)
}

function connectSocket(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upstream connect timed out')) }, 10_000)
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

async function openTunnel(host) {
  if (!upstreamProxy) {
    const address = (await lookup(host, { family: 4 })).address
    if (!publicIPv4(address)) throw new Error('upstream DNS returned a non-public address')
    return { socket: await connectSocket(address, 443), early: Buffer.alloc(0) }
  }
  const proxy = await connectSocket(upstreamProxy.hostname, upstreamProxyPort)
  proxy.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0)
    const timer = setTimeout(() => { proxy.destroy(); reject(new Error('upstream proxy timed out')) }, 10_000)
    const fail = error => { clearTimeout(timer); proxy.destroy(); reject(error) }
    const onData = chunk => {
      response = Buffer.concat([response, chunk])
      if (response.length > 4096) { fail(new Error('upstream proxy response exceeded its bound')); return }
      const end = response.indexOf('\r\n\r\n')
      if (end === -1) return
      proxy.removeListener('data', onData)
      proxy.removeListener('error', fail)
      clearTimeout(timer)
      const line = response.subarray(0, end).toString('ascii').split('\r\n')[0]
      if (!/^HTTP\/1\.[01] 200(?: |$)/.test(line)) { fail(new Error('upstream proxy denied the exact Codex host')); return }
      resolve({ socket: proxy, early: response.subarray(end + 4) })
    }
    proxy.on('data', onData)
    proxy.once('error', fail)
  })
}

const server = createServer(client => {
  if (++clients > MAX_CLIENTS) { clients -= 1; client.destroy(); return }
  client.once('close', () => { clients -= 1 })
  client.setTimeout(300_000, () => client.destroy())
  let header = Buffer.alloc(0)
  let started = false
  client.on('data', async function receive(chunk) {
    if (started) return
    header = Buffer.concat([header, chunk])
    if (header.length > 4096) { client.end('HTTP/1.1 413 Request Too Large\r\n\r\n'); return }
    const end = header.indexOf('\r\n\r\n')
    if (end === -1) return
    started = true
    client.removeListener('data', receive)
    client.pause()
    const head = header.subarray(0, end).toString('ascii')
    const line = head.split('\r\n')[0]
    const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(line)
    const host = match?.[1]
    if (!host || !allowed.has(host) || /\r\n(?:proxy-authorization|authorization):/i.test(head)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    let tunnel
    try { tunnel = await openTunnel(host) }
    catch { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    const upstream = tunnel.socket
    upstream.setTimeout(300_000, () => upstream.destroy())
    upstream.once('error', () => client.destroy())
    client.once('error', () => upstream.destroy())
    client.once('close', () => upstream.destroy())
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (tunnel.early.length) client.write(tunnel.early)
    const remainder = header.subarray(end + 4)
    if (remainder.length) upstream.write(remainder)
    let bytes = remainder.length + tunnel.early.length
    const count = chunk => { bytes += chunk.length; if (bytes > MAX_TUNNEL_BYTES) { client.destroy(); upstream.destroy() } }
    client.on('data', count)
    upstream.on('data', count)
    client.pipe(upstream)
    upstream.pipe(client)
    client.resume()
  })
})
server.listen(PORT, '0.0.0.0')
