import process from 'node:process'

const { emptyRadarState } = await import('../dist/src/radar.js')
const {
  markRadarWebhookEventsDelivered,
  markRadarWebhookEventsDeliveredForRoute,
  eventsForRadarWebhookTarget,
  radarWebhookEndpointHash,
  queueRadarWebhookEventsForRoute,
  resolveRadarWebhookTargets,
  sendRadarWebhook,
  undeliveredRadarWebhookEvents,
  undeliveredRadarWebhookEventsForRoute,
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

const priorityEvent = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-webhook-priority-showcase',
  incidentId: 'project-showcase\u0000parser\u00002.9.0\u0000GHSA-priority-showcase',
  kind: 'vulnerability',
  change: 'new',
  detectedAt: '2026-08-16T04:00:00.000Z',
  project: { id: 'project-showcase', name: 'DSH showcase' },
  route: { channels: ['feishu:security'] },
  plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  affected: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
  paths: [[
    { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
  ]],
  advisory: {
    id: 'GHSA-priority-showcase',
    aliases: ['CVE-2026-1234'],
    summary: 'Deterministic priority evidence showcase',
    details: 'Local fixture only.',
    severity: 'high',
    modified: '2026-08-16T04:00:00.000Z',
    fixedVersions: ['3.0.0'],
    references: [],
    riskSignals: {
      cisaKev: { knownExploited: true },
      epss: { score: 0.97224, percentile: 0.99999 },
    },
  },
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

const routeTargets = resolveRadarWebhookTargets([
  {
    schema: 'upstream-radar.inventory/v1alpha1',
    project: {
      id: 'project-payments',
      name: 'Payments',
      webhookUrlEnv: 'RADAR_PAYMENTS_URL',
      webhookSecretEnv: 'RADAR_PAYMENTS_SECRET',
    },
    plugins: [],
  },
  {
    schema: 'upstream-radar.inventory/v1alpha1',
    project: {
      id: 'project-platform',
      name: 'Platform',
      webhookUrlEnv: 'RADAR_PLATFORM_URL',
    },
    plugins: [],
  },
], {
  environment: {
    RADAR_PAYMENTS_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/payments-showcase',
    RADAR_PAYMENTS_SECRET: 'payments-showcase-secret',
    RADAR_PLATFORM_URL: 'https://alerts.example.test/platform-showcase',
  },
})
const paymentsTarget = routeTargets.find(target => target.projectIds?.includes('project-payments'))
const platformTarget = routeTargets.find(target => target.projectIds?.includes('project-platform'))
if (paymentsTarget === undefined || platformTarget === undefined) throw new Error('project webhook showcase targets were not resolved')
const paymentsEvent = { ...event, project: { ...event.project, id: 'project-payments', name: 'Payments' } }
const platformEvent = { ...event, id: 'event-webhook-platform-showcase', incidentId: 'project-showcase\u0000platform', project: { ...event.project, id: 'project-platform', name: 'Platform' } }
let projectState = emptyRadarState()
projectState = queueRadarWebhookEventsForRoute(projectState, paymentsTarget.endpointHash, eventsForRadarWebhookTarget([paymentsEvent, platformEvent], paymentsTarget))
projectState = queueRadarWebhookEventsForRoute(projectState, platformTarget.endpointHash, eventsForRadarWebhookTarget([paymentsEvent, platformEvent], platformTarget))
const projectPaymentsPending = undeliveredRadarWebhookEventsForRoute(projectState, paymentsTarget.endpointHash, [])
const projectPlatformPending = undeliveredRadarWebhookEventsForRoute(projectState, platformTarget.endpointHash, [])
projectState = markRadarWebhookEventsDeliveredForRoute(projectState, paymentsTarget.endpointHash, projectPaymentsPending)

await sendRadarWebhook(feishuEndpoint, [priorityEvent], {
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
  priorityText: feishuRequests[0]?.payload.content?.text,
  feishuDirectDelivery: {
    nativeTextBody: feishuRequests[0]?.payload.msg_type === 'text',
    signatureIncluded: typeof feishuRequests[0]?.payload.sign === 'string',
    providerEnvelopeOmitted: feishuRequests[0]?.payload.schema === undefined,
  },
  projectRouting: {
    targetCount: routeTargets.length,
    paymentsProjects: paymentsTarget.projectIds,
    platformProjects: platformTarget.projectIds,
    independentOutboxes: Object.keys(projectState.webhookRoutes ?? {}).length,
    paymentsDelivered: undeliveredRadarWebhookEventsForRoute(projectState, paymentsTarget.endpointHash, []).length === 0,
    platformStillPending: undeliveredRadarWebhookEventsForRoute(projectState, platformTarget.endpointHash, []).length === 1,
    endpointAndSecretNotPersisted: !JSON.stringify(projectState).includes('alerts.example.test')
      && !JSON.stringify(projectState).includes('payments-showcase-secret'),
  },
}, null, 2)}\n`)
