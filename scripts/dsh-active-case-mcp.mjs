#!/usr/bin/env node
// Stdio bridge for an authenticated Codex CLI with host shell/file tools disabled.
// The model receives only one named broker hand; target code never runs here.
import { execFile as callback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseDshActiveCaseRequest } from '../dist/src/dsh-active-case-protocol.js'

const targetId = process.env.RADAR_CASE_TARGET_ID
const control = process.env.RADAR_CASE_CONTROL
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId ?? '') || !control?.startsWith('/')) {
  throw new Error('the MCP case hand requires an exact target and absolute control directory')
}
const toolPath = fileURLToPath(new URL('./dsh-active-case-tool.mjs', import.meta.url))
const execFile = promisify(callback)
const ACTIONS = ['review', 'evidence', 'recommend', 'network', 'launch', 'watch', 'inspect', 'cancel',
  'build-review', 'build', 'surface-build-review', 'surface-build', 'conclude']
const TOOL = { name: 'case_action', description: 'Use the trusted Upstream Radar broker for exactly this plugin. '
  + 'Call review before recommend; launch, watch and inspect during normal execution; use evidence for a specific '
  + 'immutable repository file when needed, including a file already present in the bounded review input. Exact action inputs: review/launch use {}; '
  + 'watch uses {cursor:integer}; inspect uses {} or {kind:"native"|"surface"|"adapter"}; before conclude, inspect with {} once to persist the full native/surface/adapter ledger digest (kind-specific views do not count as final inspection); '
  + 'network uses {route:"direct"|"configured-proxy"|"recovery-proxy"} only after the current isolated batch stops; a missing preconfigured route is rejected, and the next launch must re-establish exact artifact evidence; '
  + 'evidence uses {path:"repository/relative/file"} for a small file, or {path:"README.md",offset:0} for a 24 KiB UTF-8 excerpt from a larger pinned file (offset is a bounded byte position; request further excerpts as needed); recommend uses {decision:object}; '
  + 'conclude uses exactly {launchId:"32 lowercase hex",statement:"plain text",coverageNotes:["plain text"]}. '
  + 'Never use text, conclusion, summary or coverageGaps as conclude keys. Never send commands, URLs or another plugin target.',
inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS },
  input: { type: 'object', description: 'Exact parameters for the named action. Empty object for review or launch.' } },
  required: ['action', 'input'], additionalProperties: false } }

function argumentFor(action, input) {
  if (['recommend', 'cancel', 'build', 'surface-build', 'conclude'].includes(action)) return JSON.stringify(input)
  if (action === 'watch') return String(input.cursor)
  if (action === 'network') return input.route
  if (action === 'inspect') return input.kind ?? ''
  if (action === 'evidence') return JSON.stringify(input)
  if (action === 'build-review' || action === 'surface-build-review') return input.caseId
  return ''
}

async function callCaseTool(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)
    || Object.keys(args).some(key => !['action', 'input'].includes(key))) {
    throw new Error('case_action accepts only action and input')
  }
  if (args.action === 'conclude' && (typeof args.input !== 'object' || args.input === null
    || Array.isArray(args.input) || Object.keys(args.input).sort().join(',')
      !== 'coverageNotes,launchId,statement')) {
    throw new Error('conclude input requires exactly launchId, statement, coverageNotes; do not use text, conclusion, or summary')
  }
  const request = parseDshActiveCaseRequest({ schema: 'upstream-radar.dsh-active-case-request/v1alpha1',
    id: randomBytes(16).toString('hex'), targetId, action: args.action, input: args.input }, targetId)
  let output
  try {
    output = (await execFile(process.execPath, [toolPath, request.action, argumentFor(request.action, request.input)],
      { timeout: 35_000, maxBuffer: 600 * 1024, encoding: 'utf8', env: {
        RADAR_CASE_TARGET_ID: targetId, RADAR_CASE_CONTROL: control,
      } })).stdout
  } catch (error) {
    if (typeof error.stdout !== 'string' || error.stdout.trim() === '') {
      throw new Error('the bounded broker hand did not return a valid response')
    }
    output = error.stdout
  }
  const value = JSON.parse(output)
  if (typeof value.ok !== 'boolean' || !/^[a-f0-9]{32}$/.test(value.id ?? '')) {
    throw new Error('the broker hand returned an invalid response identity')
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: !value.ok }
}

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) }
function rpcError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function handle(line) {
  let item
  try { item = JSON.parse(line.toString('utf8')) }
  catch { rpcError(null, -32700, 'invalid JSON'); return }
  if (typeof item !== 'object' || item === null || item.jsonrpc !== '2.0'
    || typeof item.method !== 'string') { rpcError(item?.id ?? null, -32600, 'invalid MCP request'); return }
  if (!Object.hasOwn(item, 'id')) return // MCP notification, including notifications/initialized.
  const id = item.id
  try {
    if (item.method === 'initialize') {
      reply(id, { protocolVersion: typeof item.params?.protocolVersion === 'string'
        ? item.params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'upstream-radar-dsh-case', version: '0.1.0' } })
    } else if (item.method === 'ping') reply(id, {})
    else if (item.method === 'tools/list') reply(id, { tools: [TOOL] })
    else if (item.method === 'tools/call') {
      if (item.params?.name !== TOOL.name) throw new Error('the MCP hand has no such tool')
      reply(id, await callCaseTool(item.params.arguments))
    } else rpcError(id, -32601, 'MCP method unavailable')
  } catch (error) {
    reply(id, { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error).slice(0, 512) }],
      isError: true })
  }
}

let pending = Buffer.alloc(0)
for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, Buffer.from(chunk)])
  let end
  while ((end = pending.indexOf(10)) >= 0) {
    const line = pending.subarray(0, end)
    pending = pending.subarray(end + 1)
    if (line.length > 64 * 1024) throw new Error('MCP request exceeds its byte budget')
    if (line.length) await handle(line)
  }
  if (pending.length > 64 * 1024) throw new Error('MCP request exceeds its byte budget')
}
