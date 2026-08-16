import { createAnalysisTask } from '../dist/src/dsh-analysis.js'
import {
  countPolicyHeldAnalysisTasks,
  createNotificationPolicyMap,
  decideProjectRadarNotification,
} from '../dist/src/notification-policy.js'
import { emptyRadarState } from '../dist/src/radar.js'
import { queueRadarWebhookEvents, radarWebhookEndpointHash } from '../dist/src/webhook.js'

const policy = {
  minimumSeverity: 'medium',
  quietHours: { timezone: 'Asia/Shanghai', start: '22:00', end: '08:00' },
}
const inventory = {
  schema: 'upstream-radar.inventory/v1alpha1',
  project: { id: 'showcase', name: 'Notification policy showcase' },
  notificationPolicy: policy,
  plugins: [{
    package: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
    graph: {
      schema: 'upstream-radar.dependency-graph/v1alpha1',
      rootNodeId: 'demo-plugin',
      nodes: [{ id: 'demo-plugin', name: 'demo-plugin', version: '1.0.0' }],
      edges: [],
    },
  }],
}
const event = {
  schema: 'upstream-radar.event/v1alpha1',
  id: 'event-showcase',
  incidentId: 'incident-showcase',
  kind: 'compatibility',
  change: 'new',
  detectedAt: '2026-08-16T01:00:00.000Z',
  project: inventory.project,
  route: { channels: ['stdout'] },
  plugin: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  installed: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
  candidate: { ecosystem: 'npm', name: 'demo-plugin', version: '2.0.0' },
  signals: [{ code: 'major', confidence: 'strong', summary: 'Demo major update.' }],
}
const policies = createNotificationPolicyMap([inventory])
const quietTime = new Date('2026-08-16T15:30:00.000Z')
const deliveryTime = new Date('2026-08-16T02:00:00.000Z')
const heldDecision = decideProjectRadarNotification(event, policies, quietTime)
const deliveredDecision = decideProjectRadarNotification(event, policies, deliveryTime)
const state = emptyRadarState()
state.pendingAnalysisTasks.push(createAnalysisTask(event))
const heldTasks = countPolicyHeldAnalysisTasks(state.pendingAnalysisTasks, policies, quietTime)
const queued = queueRadarWebhookEvents(
  state,
  radarWebhookEndpointHash('https://hooks.example.test/notification-policy'),
  [event],
)

console.log('Notification policy showcase')
console.log('  23:30 Asia/Shanghai: held =', !heldDecision.deliver)
console.log('  10:00 Asia/Shanghai: delivered =', deliveredDecision.deliver)
console.log('  DSH tasks retained while held =', state.pendingAnalysisTasks.length)
console.log('  policy-held task count =', heldTasks)
console.log('  webhook outbox retained events =', queued.webhook?.pendingEvents?.length ?? 0)

if (heldDecision.deliver || !deliveredDecision.deliver || heldTasks !== 1 || queued.webhook?.pendingEvents?.length !== 1) {
  throw new Error('notification policy showcase did not demonstrate durable suppression')
}
