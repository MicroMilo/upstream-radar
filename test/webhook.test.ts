import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { emptyRadarState } from '../src/radar.js'
import { filterNotifiableRadarEvents } from '../src/notification-policy.js'
import {
  buildFeishuWebhookPayload,
  buildRadarWebhookPayload,
  eventsForRadarWebhookTarget,
  isFeishuV2WebhookUrl,
  markRadarWebhookEventsDelivered,
  markRadarWebhookEventsDeliveredForRoute,
  normalizeRadarWebhookUrl,
  queueRadarWebhookEvents,
  queueRadarWebhookEventsForRoute,
  radarWebhookEndpointHash,
  resolveRadarWebhookTargets,
  sendRadarWebhook,
  undeliveredRadarWebhookEvents,
  undeliveredRadarWebhookEventsForRoute,
} from '../src/webhook.js'
import type { CompatibilityEvent, VulnerabilityEvent } from '../src/radar-types.js'

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
  it('keeps all plugin roots when a shared DSH host event is delivered', () => {
    const vulnerability: VulnerabilityEvent = {
      schema: 'upstream-radar.event/v1alpha1',
      id: 'event-shared-host-webhook',
      incidentId: 'incident-shared-host-webhook',
      kind: 'vulnerability',
      change: 'new',
      detectedAt: '2026-08-16T04:00:00.000Z',
      project: { id: 'project-webhook', name: 'Webhook project' },
      route: { channels: ['stdout'] },
      plugin: { ecosystem: 'npm', name: 'plugin-a', version: '1.0.0' },
      affectedPlugins: [
        { ecosystem: 'npm', name: 'plugin-a', version: '1.0.0' },
        { ecosystem: 'npm', name: 'plugin-b', version: '1.0.0' },
      ],
      affected: { ecosystem: 'npm', name: 'host-parser', version: '2.0.0' },
      affectedSources: ['dsh-host'],
      paths: [[
        { ecosystem: 'npm', name: 'plugin-a', version: '1.0.0' },
        { ecosystem: 'npm', name: 'host-parser', version: '2.0.0' },
      ]],
      advisory: {
        id: 'GHSA-shared-host-webhook',
        aliases: [],
        summary: 'Shared host webhook advisory',
        details: 'Details',
        severity: 'high',
        modified: '2026-08-16T04:00:00.000Z',
        fixedVersions: ['2.1.0'],
        references: [],
        sources: ['osv', 'github-advisories'],
        conflicts: [{
          field: 'fixed-versions',
          claims: [
            { source: 'osv', value: '2.1.0' },
            { source: 'github-advisories', value: '2.2.0' },
          ],
        }],
        riskSignals: {
          cisaKev: { knownExploited: true, dateAdded: '2026-08-15' },
          epss: { score: 0.97224, percentile: 0.99999, date: '2026-08-16' },
        },
      },
    }
    const notice = buildRadarWebhookPayload([vulnerability]).events[0]
    assert.deepEqual(notice?.affectedPlugins, vulnerability.affectedPlugins)
    assert.deepEqual((notice?.advisory as { sources?: string[] } | undefined)?.sources, ['osv', 'github-advisories'])
    assert.deepEqual((notice?.advisory as { conflicts?: unknown } | undefined)?.conflicts, vulnerability.advisory.conflicts)
    assert.deepEqual((notice?.advisory as { riskSignals?: unknown } | undefined)?.riskSignals, {
      cisaKev: { knownExploited: true, dateAdded: '2026-08-15' },
      epss: { score: 0.97224, percentile: 0.99999, date: '2026-08-16' },
    })
    assert.match(notice?.summary ?? '', /across 2 DSH plugins/)
    assert.match(notice?.summary ?? '', /priority: CISA KEV known exploited; EPSS 97\.2%; severity high/)
  })

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

  it('keeps a quieted event in a durable outbox until a later cycle', () => {
    const endpointHash = radarWebhookEndpointHash('https://hooks.example.test/incoming')
    const updated = { ...event, id: 'event-webhook-1-updated', change: 'updated' as const }
    const queued = queueRadarWebhookEvents(
      queueRadarWebhookEvents(emptyRadarState(), endpointHash, [event]),
      endpointHash,
      [updated],
    )
    assert.equal(undeliveredRadarWebhookEvents(queued, endpointHash, []).length, 1)
    assert.equal(undeliveredRadarWebhookEvents(queued, endpointHash, [])[0]?.id, updated.id)
    const delivered = markRadarWebhookEventsDelivered(queued, endpointHash, [updated])
    assert.deepEqual(delivered.webhook?.pendingEvents, undefined)
    assert.equal(undeliveredRadarWebhookEvents(delivered, endpointHash, []).length, 0)
  })

  it('keeps a muted event in the webhook outbox until its expiry', () => {
    const endpointHash = radarWebhookEndpointHash('https://hooks.example.test/incoming')
    const state = emptyRadarState()
    state.incidentMutes = {
      [event.incidentId]: { eventId: event.id, mutedUntil: '2026-08-17T00:00:00.000Z' },
    }
    const queued = queueRadarWebhookEvents(state, endpointHash, [event])
    assert.deepEqual(filterNotifiableRadarEvents(
      undeliveredRadarWebhookEvents(queued, endpointHash, [event]),
      new Map(),
      new Date('2026-08-16T04:01:00.000Z'),
      queued,
    ), [])
    assert.deepEqual(filterNotifiableRadarEvents(
      undeliveredRadarWebhookEvents(queued, endpointHash, [event]),
      new Map(),
      new Date('2026-08-17T00:00:00.000Z'),
      queued,
    ), [event])
  })

  it('does not acknowledge events beyond one bounded payload batch', async () => {
    const endpointHash = radarWebhookEndpointHash('https://hooks.example.test/incoming')
    const events = Array.from({ length: 65 }, (_, index) => ({
      ...event,
      id: `event-webhook-${index}`,
      incidentId: `incident-webhook-${index}`,
      project: { ...event.project, id: `project-webhook-${index}` },
    }))
    const queued = queueRadarWebhookEvents(emptyRadarState(), endpointHash, events)
    const pending = undeliveredRadarWebhookEvents(queued, endpointHash, [])
    const payload = await sendRadarWebhook('https://hooks.example.test/incoming', pending, {
      fetch: async () => new Response(null, { status: 200 }),
    })
    const deliveredIds = new Set(payload.events.map(item => item.id))
    const delivered = markRadarWebhookEventsDelivered(
      queued,
      endpointHash,
      pending.filter(item => deliveredIds.has(item.id)),
    )
    assert.equal(payload.events.length, 64)
    assert.equal(undeliveredRadarWebhookEvents(delivered, endpointHash, []).length, 1)
  })

  it('changes the delivery ledger when the endpoint changes without persisting its URL', () => {
    const firstHash = radarWebhookEndpointHash('https://hooks.example.test/first')
    const secondHash = radarWebhookEndpointHash('https://hooks.example.test/second')
    const state = markRadarWebhookEventsDelivered(emptyRadarState(), firstHash, [event])
    assert.equal(undeliveredRadarWebhookEvents(state, secondHash, [event]).length, 1)
    assert.doesNotMatch(JSON.stringify(state), /hooks\.example\.test/)
  })

  it('routes project events to isolated environment endpoints and ledgers', () => {
    const projects = [
      {
        schema: 'upstream-radar.inventory/v1alpha1' as const,
        project: {
          id: 'project-payments',
          name: 'Payments',
          webhookUrlEnv: 'RADAR_PAYMENTS_URL',
          webhookSecretEnv: 'RADAR_PAYMENTS_SECRET',
        },
        plugins: [],
      },
      {
        schema: 'upstream-radar.inventory/v1alpha1' as const,
        project: {
          id: 'project-platform',
          name: 'Platform',
          webhookUrlEnv: 'RADAR_PLATFORM_URL',
        },
        plugins: [],
      },
    ]
    const targets = resolveRadarWebhookTargets(projects, {
      environment: {
        RADAR_PAYMENTS_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/payments',
        RADAR_PAYMENTS_SECRET: 'payments-secret',
        RADAR_PLATFORM_URL: 'https://alerts.example.test/platform',
      },
    })
    assert.equal(targets.length, 2)
    const paymentsTarget = targets.find(target => target.projectIds?.includes('project-payments'))
    const platformTarget = targets.find(target => target.projectIds?.includes('project-platform'))
    assert.deepEqual(paymentsTarget?.projectIds, ['project-payments'])
    assert.equal(paymentsTarget?.feishuSecret, 'payments-secret')
    assert.deepEqual(platformTarget?.projectIds, ['project-platform'])

    const paymentsEvent = { ...event, project: { ...event.project, id: 'project-payments' } }
    const platformEvent = { ...event, id: 'event-webhook-platform', incidentId: 'incident-webhook-platform', project: { ...event.project, id: 'project-platform' } }
    assert.deepEqual(eventsForRadarWebhookTarget([paymentsEvent, platformEvent], paymentsTarget!), [paymentsEvent])
    assert.deepEqual(eventsForRadarWebhookTarget([paymentsEvent, platformEvent], platformTarget!), [platformEvent])

    let state = emptyRadarState()
    state = queueRadarWebhookEventsForRoute(state, paymentsTarget!.endpointHash, [paymentsEvent])
    state = queueRadarWebhookEventsForRoute(state, platformTarget!.endpointHash, [platformEvent])
    assert.equal(state.webhook, undefined)
    assert.equal(Object.keys(state.webhookRoutes ?? {}).length, 2)
    assert.equal(undeliveredRadarWebhookEventsForRoute(state, paymentsTarget!.endpointHash, []).length, 1)
    assert.equal(undeliveredRadarWebhookEventsForRoute(state, platformTarget!.endpointHash, []).length, 1)

    state = markRadarWebhookEventsDeliveredForRoute(state, paymentsTarget!.endpointHash, [paymentsEvent], new Date('2026-08-16T04:02:00.000Z'))
    assert.equal(undeliveredRadarWebhookEventsForRoute(state, paymentsTarget!.endpointHash, []).length, 0)
    assert.equal(undeliveredRadarWebhookEventsForRoute(state, platformTarget!.endpointHash, []).length, 1)
    assert.doesNotMatch(JSON.stringify(state), /open\.feishu\.cn|alerts\.example\.test|payments-secret/)
  })

  it('requires project webhook URLs and rejects conflicting secrets', () => {
    const project = {
      schema: 'upstream-radar.inventory/v1alpha1' as const,
      project: { id: 'project-required', name: 'Required', webhookUrlEnv: 'RADAR_REQUIRED_URL' },
      plugins: [],
    }
    assert.throws(
      () => resolveRadarWebhookTargets([project], { environment: {} }),
      /RADAR_REQUIRED_URL is not set/,
    )
    assert.throws(
      () => resolveRadarWebhookTargets([
        { ...project, project: { ...project.project, id: 'project-a', webhookSecretEnv: 'RADAR_SECRET_A' } },
        { ...project, project: { ...project.project, id: 'project-b', webhookSecretEnv: 'RADAR_SECRET_B' } },
      ], {
        environment: {
          RADAR_REQUIRED_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/shared',
          RADAR_SECRET_A: 'a',
          RADAR_SECRET_B: 'b',
        },
      }),
      /different Feishu signing secrets/,
    )
  })
})
