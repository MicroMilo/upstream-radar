import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { emptyRadarState } from '../src/radar.js'
import {
  buildFeishuWebhookPayload,
  buildRadarWebhookPayload,
  isFeishuV2WebhookUrl,
  markRadarWebhookEventsDelivered,
  normalizeRadarWebhookUrl,
  radarWebhookEndpointHash,
  sendRadarWebhook,
  undeliveredRadarWebhookEvents,
} from '../src/webhook.js'
import type { CompatibilityEvent } from '../src/radar-types.js'

const event: CompatibilityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-webhook-1',
  incidentId: 'incident-webhook-1',
  kind: 'compatibility',
  change: 'new',
  detectedAt: '2026-08-16T04:00:00.000Z',
  project: { id: 'project-webhook', name: 'Webhook project', owner: 'platform' },
  route: { owner: 'platform', channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  installed: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  candidate: { ecosystem: 'npm', name: 'demo-plugin', version: '2.0.0' },
  signals: [{ code: 'breaking-version-boundary', confidence: 'strong', summary: 'The candidate crosses a major version boundary.' }],
}

describe('webhook delivery', () => {
  it('accepts HTTPS provider URLs but never credentials or fragments', () => {
    const url = 'https://hooks.example.test/incoming?token=secret'
    assert.equal(normalizeRadarWebhookUrl(url), url)
    assert.equal(radarWebhookEndpointHash(url).length, 64)
    assert.throws(() => normalizeRadarWebhookUrl('http://hooks.example.test/incoming'), /must use HTTPS/)
    assert.throws(() => normalizeRadarWebhookUrl('https://user:pass@hooks.example.test/incoming'), /credentials/)
    assert.throws(() => normalizeRadarWebhookUrl('https://hooks.example.test/incoming#fragment'), /fragment/)
  })

  it('formats Feishu V2 custom-bot messages and signs only when a secret is supplied', async () => {
    const now = new Date('2026-08-16T04:01:00.000Z')
    const radarPayload = buildRadarWebhookPayload([event], now)
    const unsigned = buildFeishuWebhookPayload(radarPayload, { now })
    assert.deepEqual(unsigned, {
      msg_type: 'text',
      content: { text: '[NEW][compatibility] demo-plugin@1.0.0 -> demo-plugin@2.0.0: The candidate crosses a major version boundary.' },
    })
    const secret = 'feishu-secret'
    const timestamp = Math.floor(now.getTime() / 1_000).toString()
    const signed = buildFeishuWebhookPayload(radarPayload, { now, secret })
    assert.equal(signed.timestamp, timestamp)
    assert.equal(signed.sign, createHmac('sha256', `${timestamp}\n${secret}`).digest('base64'))
    assert.equal(isFeishuV2WebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/token'), true)
    assert.equal(isFeishuV2WebhookUrl('https://open.larksuite.com/open-apis/bot/v2/hook/token'), true)
    assert.equal(isFeishuV2WebhookUrl('https://hooks.example.test/incoming'), false)
    await assert.rejects(
      sendRadarWebhook('https://open.feishu.cn/open-apis/bot/hook/token', [event]),
      /V1 webhook is not supported/,
    )
  })

  it('sends Feishu V2 JSON instead of the provider-neutral envelope', async () => {
    const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/token'
    let requestInit: RequestInit | undefined
    await sendRadarWebhook(url, [event], {
      now: new Date('2026-08-16T04:01:00.000Z'),
      feishuSecret: 'secret',
      fetch: async (_input, init) => {
        requestInit = init
        return new Response(null, { status: 200 })
      },
    })
    const body = JSON.parse(String(requestInit?.body)) as { msg_type: string; content: { text: string }; schema?: string }
    assert.equal(body.msg_type, 'text')
    assert.equal(body.schema, undefined)
    assert.match(body.content.text, /^\[NEW\]\[compatibility\]/)
  })

  it('keeps untrusted Feishu text from creating mentions and stays below the bot body limit', () => {
    const unsafeEvent: CompatibilityEvent = {
      ...event,
      signals: [{
        code: 'untrusted-release-note',
        confidence: 'needs-analysis',
        summary: '<at user_id="all">notify everyone</at> ' + 'x'.repeat(2_048),
      }],
    }
    const radarPayload = buildRadarWebhookPayload(Array.from({ length: 64 }, () => unsafeEvent))
    const feishu = buildFeishuWebhookPayload(radarPayload, {
      now: new Date('2026-08-16T04:01:00.000Z'),
    })
    assert.doesNotMatch(feishu.content.text, /<at\b/)
    assert.ok(Buffer.byteLength(JSON.stringify(feishu), 'utf8') < 20 * 1024)
  })

  it('sends a bounded structured payload and records only successful event ids', async () => {
    const url = 'https://hooks.example.test/incoming?token=secret'
    const endpointHash = radarWebhookEndpointHash(url)
    const initial = emptyRadarState()
    const pending = undeliveredRadarWebhookEvents(initial, endpointHash, [event, event])
    assert.deepEqual(pending.map(item => item.id), ['event-webhook-1'])

    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const payload = await sendRadarWebhook(url, pending, {
      now: new Date('2026-08-16T04:01:00.000Z'),
      fetch: async (input, init) => {
        requestUrl = String(input)
        requestInit = init
        return new Response(null, { status: 204 })
      },
    })
    assert.equal(requestUrl, url)
    assert.equal(requestInit?.method, 'POST')
    assert.equal(requestInit?.redirect, 'error')
    assert.equal((requestInit?.headers as Record<string, string>)['x-upstream-radar-schema'], 'upstream-radar.webhook/v1alpha1')
    assert.equal((requestInit?.headers as Record<string, string>)['content-type'], 'application/json')
    assert.equal(JSON.parse(String(requestInit?.body)).schema, 'upstream-radar.webhook/v1alpha1')
    assert.equal(payload.events.length, 1)
    assert.match(payload.text, /demo-plugin@1\.0\.0 -> demo-plugin@2\.0\.0/)

    const delivered = markRadarWebhookEventsDelivered(initial, endpointHash, pending, new Date('2026-08-16T04:01:01.000Z'))
    assert.equal(undeliveredRadarWebhookEvents(delivered, endpointHash, [event]).length, 0)
    assert.equal(delivered.webhook?.endpointHash, endpointHash)
    assert.equal(Object.keys(delivered.webhook?.deliveredEventIds ?? {}).length, 1)
  })

  it('leaves a failed event undelivered so the next cycle can retry it', async () => {
    const url = 'https://hooks.example.test/incoming'
    const endpointHash = radarWebhookEndpointHash(url)
    const initial = emptyRadarState()
    await assert.rejects(
      sendRadarWebhook(url, [event], { fetch: async () => { throw new Error('network failed') } }),
      /webhook request failed/,
    )
    assert.equal(undeliveredRadarWebhookEvents(initial, endpointHash, [event]).length, 1)
  })

  it('changes the delivery ledger when the endpoint changes without persisting its URL', () => {
    const firstHash = radarWebhookEndpointHash('https://hooks.example.test/first')
    const secondHash = radarWebhookEndpointHash('https://hooks.example.test/second')
    const state = markRadarWebhookEventsDelivered(emptyRadarState(), firstHash, [event])
    assert.equal(undeliveredRadarWebhookEvents(state, secondHash, [event]).length, 1)
    assert.doesNotMatch(JSON.stringify(state), /hooks\.example\.test/)
  })
})
