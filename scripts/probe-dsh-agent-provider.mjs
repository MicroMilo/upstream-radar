#!/usr/bin/env node
// Prove that the configured OpenAI-compatible endpoint can run a real
// model -> tool -> tool-result -> model loop before any plugin code executes.
import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [outputPath = 'agent-provider-probe.json'] = process.argv.slice(2)
const baseUrl = process.env.ISSUE_LOCATOR_LLM_BASE_URL
const apiKey = process.env.ISSUE_LOCATOR_LLM_API_KEY
const model = process.env.ISSUE_LOCATOR_LLM_MODEL
if (!baseUrl || !apiKey || !model) {
  throw new Error('ISSUE_LOCATOR_LLM_BASE_URL, ISSUE_LOCATOR_LLM_API_KEY and ISSUE_LOCATOR_LLM_MODEL are required')
}

function chatCompletionsEndpoint(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('the configured model base URL is invalid')
  }
  const normalized = url.toString().replace(/\/$/, '')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

const endpoint = chatCompletionsEndpoint(baseUrl)
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const promptNonce = randomBytes(12).toString('hex')
const toolMarker = `tool-result-${randomBytes(16).toString('hex')}`
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 120_000)
timeout.unref()

async function completion(body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: controller.signal,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'user-agent': 'upstream-radar/active-agent-provider-probe',
    },
    body: JSON.stringify({ model, temperature: 0, ...body }),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 2 * 1024 * 1024) throw new Error('model response exceeded the probe byte budget')
  if (!response.ok) throw new Error(`model endpoint returned HTTP ${response.status}`)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error('model endpoint returned non-JSON data') }
  const choice = value?.choices?.[0]
  if (!choice || typeof choice.message !== 'object' || choice.message === null) {
    throw new Error('model endpoint returned no assistant message')
  }
  return { message: choice.message, finishReason: choice.finish_reason ?? null }
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

const tools = [{
  type: 'function',
  function: {
    name: 'read_probe_material',
    description: 'Read one bounded item from the trusted compatibility-analysis controller.',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string', description: 'The exact nonce from the user request.' } },
      required: ['nonce'],
      additionalProperties: false,
    },
  },
}]
const messages = [
  {
    role: 'system',
    content: 'You are an agent capability probe. Call the named tool exactly once, then read its result and repeat the exact marker in your final answer.',
  },
  {
    role: 'user',
    content: `Use read_probe_material with nonce ${promptNonce}. Do not invent the tool result.`,
  },
]

try {
  const first = await completion({ messages, tools, tool_choice: 'required' })
  const calls = first.message.tool_calls
  if (!Array.isArray(calls) || calls.length !== 1) throw new Error('model did not make exactly one required tool call')
  const call = calls[0]
  if (call?.type !== 'function' || call.function?.name !== 'read_probe_material'
    || typeof call.id !== 'string' || call.id.length > 256) {
    throw new Error('model returned an invalid tool call')
  }
  let args
  try { args = JSON.parse(call.function.arguments) }
  catch { throw new Error('model returned invalid tool arguments') }
  if (args?.nonce !== promptNonce || Object.keys(args).some(key => key !== 'nonce')) {
    throw new Error('model did not preserve the exact probe nonce in its tool call')
  }

  const toolResult = JSON.stringify({ ok: true, marker: toolMarker,
    evidence: 'The trusted controller executed read_probe_material and returned this bounded result.' })
  const second = await completion({
    messages: [
      ...messages,
      { role: 'assistant', content: first.message.content ?? null, tool_calls: calls },
      { role: 'tool', tool_call_id: call.id, content: toolResult },
    ],
    tools,
    tool_choice: 'none',
  })
  const finalText = messageText(second.message.content)
  if (!finalText.includes(toolMarker)) {
    throw new Error('model did not read the executed tool result on the continuation turn')
  }

  const report = {
    schema: 'upstream-radar.dsh-agent-provider-probe/v1alpha1',
    checkedAt: new Date().toISOString(),
    protocol: 'openai-compatible-chat-completions',
    modelFingerprint: sha256(model),
    toolLoop: {
      requestedTool: 'read_probe_material',
      toolCallObserved: true,
      exactArgumentsObserved: true,
      toolExecuted: true,
      toolResultObservedByModel: true,
      continuationFinishReason: second.finishReason,
      markerFingerprint: sha256(toolMarker),
    },
  }
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  clearTimeout(timeout)
}
