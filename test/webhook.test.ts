import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyRadarState } from '../src/radar.js'
import {
  buildRadarWebhookPayload,
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
