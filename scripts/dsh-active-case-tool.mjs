#!/usr/bin/env node
// Runs only under the restricted Agent hand (disposable container or trusted MCP bridge).
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { join } from 'node:path'

const [action, argument] = process.argv.slice(2)
const targetId = process.env.RADAR_CASE_TARGET_ID
const control = process.env.RADAR_CASE_CONTROL
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId ?? '') || !control || !action) {
  throw new Error('the case tool requires an exact target, control directory and action')
}
const input = action === 'recommend' || action === 'cancel' || action === 'build'
  || action === 'surface-build' || action === 'conclude'
  ? JSON.parse(argument ?? '{}') : action === 'watch' ? { cursor: Number(argument ?? 0) }
    : action === 'network' ? { route: argument }
    : action === 'inspect' && argument ? { kind: argument }
      : action === 'evidence' ? (argument?.startsWith('{') ? JSON.parse(argument) : { path: argument })
      : action === 'build-review' || action === 'surface-build-review' ? { caseId: argument } : {}
const id = randomBytes(16).toString('hex')
const request = { schema: 'upstream-radar.dsh-active-case-request/v1alpha1', id, targetId, action, input }
const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`)
if (requestBytes.length > 64 * 1024) throw new Error('case request exceeds its byte budget')
const temporaryPath = join(control, 'requests', `${id}.tmp`)
const requestFile = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
try { await requestFile.writeFile(requestBytes); await requestFile.sync() } finally { await requestFile.close() }
await rename(temporaryPath, join(control, 'requests', `${id}.json`))
const responsePath = join(control, 'responses', `${id}.json`)
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  let responseFile
  try { responseFile = await open(responsePath, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (responseFile) {
    try {
      const stat = await responseFile.stat()
      if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('case response is not a bounded regular file')
      const response = JSON.parse(await responseFile.readFile('utf8'))
      if (response.id !== id || typeof response.ok !== 'boolean') throw new Error('case response identity is invalid')
      process.stdout.write(`${JSON.stringify(response)}\n`)
      if (!response.ok) process.exitCode = 2
      break
    } finally { await responseFile.close() }
  }
  await new Promise(resolve => setTimeout(resolve, 100))
}
if (Date.now() >= deadline) throw new Error('the trusted case broker did not respond within 30 seconds')
