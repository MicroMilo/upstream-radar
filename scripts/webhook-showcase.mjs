import process from 'node:process'

const { emptyRadarState } = await import('../dist/src/radar.js')
const {
  markRadarWebhookEventsDelivered,
  radarWebhookEndpointHash,
  sendRadarWebhook,
  undeliveredRadarWebhookEvents,
} = await import('../dist/src/webhook.js')

const endpoint = 'https://hooks.example.test/upstream-radar?token=showcase-only'
const endpointHash = radarWebhookEndpointHash(endpoint)
const feishuEndpoint = 'https://open.feishu.cn/open-apis/bot/v2/hook/showcase-only'
const event = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-webhook-showcase',
  incidentId: 'project-showcase\u0000osv',
  kind: 'source-health',
  change: 'new',
  detectedAt: '2026-08-16T04:00:00.000Z',
  project: { id: 'project-showcase', name: 'DSH showcase' },
  route: { channels: ['stdout'] },
  source: 'osv',
  status: 'degraded',
  failureCount: 3,
  lastAttemptedAt: '2026-08-16T04:00:00.000Z',
  error: 'deterministic showcase outage',
}

const requests = []
const feishuRequests = []
let failNext = false
const fetchStub = async (input, init) => {
  if (failNext) {
    failNext = false
    throw new Error('deterministic webhook outage')
  }
  requests.push({
    url: String(input),
    method: init?.method,
    payload: JSON.parse(String(init?.body)),
  })
  return new Response(null, { status: 204 })
}

let state = emptyRadarState()
const firstPending = undeliveredRadarWebhookEvents(state, endpointHash, [event])
await sendRadarWebhook(endpoint, firstPending, { fetch: fetchStub, now: new Date('2026-08-16T04:01:00.000Z') })
state = markRadarWebhookEventsDelivered(state, endpointHash, firstPending, new Date('2026-08-16T04:01:00.000Z'))

const duplicatePending = undeliveredRadarWebhookEvents(state, endpointHash, [event])
const retryEvent = { ...event, id: 'event-webhook-retry', incidentId: 'project-showcase\u0000npm-releases' }
failNext = true
const retryBefore = undeliveredRadarWebhookEvents(state, endpointHash, [retryEvent])
try {
  await sendRadarWebhook(endpoint, retryBefore, { fetch: fetchStub })
} catch {
  // A failed delivery is deliberately left unmarked for the next cycle.
}
const retryStillPending = undeliveredRadarWebhookEvents(state, endpointHash, [retryEvent])
await sendRadarWebhook(endpoint, retryStillPending, { fetch: fetchStub })
state = markRadarWebhookEventsDelivered(state, endpointHash, retryStillPending)

await sendRadarWebhook(feishuEndpoint, [event], {
  feishuSecret: 'showcase-secret',
  now: new Date('2026-08-16T04:02:00.000Z'),
  fetch: async (input, init) => {
    feishuRequests.push({
      url: String(input),
      payload: JSON.parse(String(init?.body)),
    })
    return new Response(null, { status: 204 })
  },
})

process.stdout.write(`${JSON.stringify({
  schema: requests[0]?.payload.schema,
  firstDelivery: {
    requestCount: requests.length >= 1 ? 1 : 0,
    eventIds: requests[0]?.payload.events.map(item => item.id) ?? [],
  },
  duplicateSuppressed: duplicatePending.length === 0,
  retryAfterFailure: {
    eventRemainedPending: retryStillPending.length === 1,
    deliveredAfterRetry: undeliveredRadarWebhookEvents(state, endpointHash, [retryEvent]).length === 0,
  },
  endpointUrlPersisted: JSON.stringify(state).includes('hooks.example.test'),
  payloadText: requests[0]?.payload.text,
  feishuDirectDelivery: {
    nativeTextBody: feishuRequests[0]?.payload.msg_type === 'text',
    signatureIncluded: typeof feishuRequests[0]?.payload.sign === 'string',
    providerEnvelopeOmitted: feishuRequests[0]?.payload.schema === undefined,
  },
}, null, 2)}\n`)
