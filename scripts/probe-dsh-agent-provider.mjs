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

function chatCompletionsEndpoints(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('the configured model base URL is invalid')
  }
  const normalized = url.toString().replace(/\/$/, '')
  if (normalized.endsWith('/chat/completions')) return [normalized]
  const bases = [normalized]
  if (normalized.endsWith('/llm/v1')) {
    bases.push(`${normalized.slice(0, -'/llm/v1'.length)}/llm/openai/v1`)
  } else if (normalized.endsWith('/llm/openai/v1')) {
    bases.push(`${normalized.slice(0, -'/llm/openai/v1'.length)}/llm/v1`)
  }
  return [...new Set(bases)].map(base => `${base}/chat/completions`)
}

const endpoints = chatCompletionsEndpoints(baseUrl)
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const promptNonce = randomBytes(12).toString('hex')
const toolMarker = `tool-result-${randomBytes(16).toString('hex')}`
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 120_000)
timeout.unref()

function safeProviderDetail(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { return 'non-JSON error response' }
  const candidate = value?.error?.message ?? value?.message ?? value?.error?.type ?? value?.error?.code
  if (typeof candidate !== 'string') return 'provider returned no bounded error message'
  let rendered = candidate
  for (const secret of [apiKey, baseUrl, model, promptNonce, toolMarker]) rendered = rendered.replaceAll(secret, '[redacted]')
  return rendered.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
}

class ProviderHttpError extends Error {
  constructor(status, detail) {
    super(`model endpoint returned HTTP ${status}: ${detail}`)
    this.status = status
    this.detail = detail
  }
}

async function completion(endpoint, body) {
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
    body: JSON.stringify({ model, ...body }),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 2 * 1024 * 1024) throw new Error('model response exceeded the probe byte budget')
  if (!response.ok) throw new ProviderHttpError(response.status, safeProviderDetail(bytes))
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
  const toolResult = JSON.stringify({ ok: true, marker: toolMarker,
    evidence: 'The trusted controller executed read_probe_material and returned this bounded result.' })
  const attempts = []
  let proof
  const nativeVariants = [
    { name: 'thinking-disabled-required', settings: { temperature: 0, thinking: { type: 'disabled' },
      max_tokens: 1_024, tools, tool_choice: 'required' } },
    { name: 'thinking-disabled-auto', settings: { temperature: 0, thinking: { type: 'disabled' },
      max_tokens: 1_024, tools, tool_choice: 'auto' } },
    { name: 'standard-auto', settings: { temperature: 0, max_tokens: 1_024, tools, tool_choice: 'auto' } },
  ]
  native: for (const endpoint of endpoints) {
    for (const variant of nativeVariants) {
      try {
        const first = await completion(endpoint, { messages, ...variant.settings })
        const calls = first.message.tool_calls
        if (!Array.isArray(calls) || calls.length !== 1) throw new Error('model did not make exactly one tool call')
        const call = calls[0]
        if (call?.type !== 'function' || call.function?.name !== 'read_probe_material'
          || typeof call.id !== 'string' || call.id.length > 256) throw new Error('model returned an invalid tool call')
        let args
        try { args = JSON.parse(call.function.arguments) }
        catch { throw new Error('model returned invalid tool arguments') }
        if (args?.nonce !== promptNonce || Object.keys(args).some(key => key !== 'nonce')) {
          throw new Error('model did not preserve the exact probe nonce in its tool call')
        }
        const second = await completion(endpoint, {
          messages: [...messages, { role: 'assistant', content: first.message.content ?? null, tool_calls: calls },
            { role: 'tool', tool_call_id: call.id, content: toolResult }],
          ...variant.settings,
          tool_choice: 'none',
        })
        if (!messageText(second.message.content).includes(toolMarker)) {
          throw new Error('model did not read the executed native tool result on the continuation turn')
        }
        proof = { mode: 'native-function-tool', finishReason: second.finishReason,
          endpointFingerprint: sha256(endpoint), variant: variant.name }
        break native
      } catch (error) {
        attempts.push({ mode: 'native-function-tool', endpointFingerprint: sha256(endpoint), variant: variant.name,
          status: error instanceof ProviderHttpError ? error.status : null,
          error: String(error instanceof Error ? error.message : error).slice(0, 500) })
      }
    }
  }

  if (!proof) {
    const actionMessages = [
      { role: 'system', content: 'Operate one trusted tool using strict JSON. First return exactly {"action":"read_probe_material","input":{"nonce":"..."}}. After a trusted tool result is supplied, return exactly {"final":"..."} with its marker.' },
      { role: 'user', content: `Request read_probe_material with the exact nonce ${promptNonce}.` },
    ]
    jsonAction: for (const endpoint of endpoints) {
      for (const withThinking of [true, false]) {
        const settings = { temperature: 0, max_tokens: 1_024,
          ...(withThinking ? { thinking: { type: 'disabled' } } : {}),
          response_format: { type: 'json_object' } }
        try {
          const first = await completion(endpoint, { messages: actionMessages, ...settings })
          const action = JSON.parse(messageText(first.message.content))
          if (action?.action !== 'read_probe_material' || action?.input?.nonce !== promptNonce
            || Object.keys(action).some(key => !['action', 'input'].includes(key))) {
            throw new Error('model did not return the exact JSON tool action')
          }
          const second = await completion(endpoint, { messages: [...actionMessages,
            { role: 'assistant', content: JSON.stringify(action) },
            { role: 'user', content: `Trusted tool result:\n${toolResult}\nRead it and return the required final JSON.` }],
          ...settings })
          const final = JSON.parse(messageText(second.message.content))
          if (typeof final?.final !== 'string' || !final.final.includes(toolMarker)) {
            throw new Error('model did not read the executed JSON-action tool result on the continuation turn')
          }
          proof = { mode: 'json-action-tool-loop', finishReason: second.finishReason,
            endpointFingerprint: sha256(endpoint), variant: withThinking ? 'thinking-disabled' : 'standard' }
          break jsonAction
        } catch (error) {
          attempts.push({ mode: 'json-action-tool-loop', endpointFingerprint: sha256(endpoint),
            variant: withThinking ? 'thinking-disabled' : 'standard',
            status: error instanceof ProviderHttpError ? error.status : null,
            error: String(error instanceof Error ? error.message : error).slice(0, 500) })
        }
      }
    }
  }

  if (!proof) throw new Error(`configured model could not complete a tool loop: ${JSON.stringify(attempts)}`)

  const report = {
    schema: 'upstream-radar.dsh-agent-provider-probe/v1alpha1',
    checkedAt: new Date().toISOString(),
    protocol: 'openai-compatible-chat-completions',
    modelFingerprint: sha256(model),
    toolLoop: {
      mode: proof.mode,
      requestedTool: 'read_probe_material',
      toolCallObserved: true,
      exactArgumentsObserved: true,
      toolExecuted: true,
      toolResultObservedByModel: true,
      continuationFinishReason: proof.finishReason,
      endpointFingerprint: proof.endpointFingerprint,
      variant: proof.variant,
      rejectedAttempts: attempts,
      markerFingerprint: sha256(toolMarker),
    },
  }
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  clearTimeout(timeout)
}
