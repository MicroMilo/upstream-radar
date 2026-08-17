import type {
  AnalysisTask,
  ProjectInventory,
  RadarEvent,
  RadarNotificationPolicy,
  RadarSeverity,
  RadarState,
} from './radar-types.js'

export type NotificationSuppressionReason = 'below-minimum-severity' | 'quiet-hours'

export interface NotificationDecision {
  deliver: boolean
  reasons: NotificationSuppressionReason[]
}

/** Return true only while the exact muted event version is still within its expiry. */
export function isRadarIncidentMuted(
  state: RadarState | undefined,
  event: RadarEvent,
  now = new Date(),
): boolean {
  if (!Number.isFinite(now.getTime())) throw new Error('incident mute decision time is invalid')
  const mute = state?.incidentMutes?.[event.incidentId]
  if (mute === undefined || mute.eventId !== event.id) return false
  const mutedUntil = Date.parse(mute.mutedUntil)
  return Number.isFinite(mutedUntil) && mutedUntil > now.getTime()
}

const SEVERITY_RANK: Record<RadarSeverity, number> = {
  unknown: 0,
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
}

function eventSeverity(event: RadarEvent): RadarSeverity | undefined {
  return event.kind === 'vulnerability' || event.kind === 'malware'
    ? event.advisory.severity
    : undefined
}

function isImmediateEvent(event: RadarEvent): boolean {
  return event.kind === 'malware' || (event.kind === 'vulnerability' && event.advisory.severity === 'critical')
}

function localMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  const minute = Number(parts.find(part => part.type === 'minute')?.value)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`could not read local time in timezone ${timezone}`)
  }
  return hour * 60 + minute
}

function isInQuietHours(date: Date, quietHours: NonNullable<RadarNotificationPolicy['quietHours']>): boolean {
  const current = localMinutes(date, quietHours.timezone)
  const start = Number(quietHours.start.slice(0, 2)) * 60 + Number(quietHours.start.slice(3, 5))
  const end = Number(quietHours.end.slice(0, 2)) * 60 + Number(quietHours.end.slice(3, 5))
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

/**
 * Decide delivery only. Radar's active maps, transition history, and pending
 * tasks are deliberately outside this decision so quieting an alert cannot
 * make the underlying evidence disappear.
 */
export function decideRadarNotification(
  event: RadarEvent,
  policy: RadarNotificationPolicy | undefined,
  now = new Date(),
): NotificationDecision {
  if (!Number.isFinite(now.getTime())) throw new Error('notification policy time is invalid')
  if (policy === undefined || isImmediateEvent(event)) return { deliver: true, reasons: [] }

  const reasons: NotificationSuppressionReason[] = []
  const severity = eventSeverity(event)
  if (policy.minimumSeverity !== undefined && severity !== undefined
    && SEVERITY_RANK[severity] < SEVERITY_RANK[policy.minimumSeverity]) {
    reasons.push('below-minimum-severity')
  }
  if (policy.quietHours !== undefined && isInQuietHours(now, policy.quietHours)) {
    reasons.push('quiet-hours')
  }
  return { deliver: reasons.length === 0, reasons }
}

export function createNotificationPolicyMap(
  inventories: readonly ProjectInventory[],
): ReadonlyMap<string, RadarNotificationPolicy> {
  return new Map(
    inventories.flatMap(inventory => inventory.notificationPolicy === undefined
      ? []
      : [[inventory.project.id, inventory.notificationPolicy] as const]),
  )
}

export function decideProjectRadarNotification(
  event: RadarEvent,
  policies: ReadonlyMap<string, RadarNotificationPolicy>,
  now = new Date(),
): NotificationDecision {
  return decideRadarNotification(event, policies.get(event.project.id), now)
}

export function filterNotifiableRadarEvents(
  events: readonly RadarEvent[],
  policies: ReadonlyMap<string, RadarNotificationPolicy>,
  now = new Date(),
  state?: RadarState,
): RadarEvent[] {
  return events.filter(event => decideProjectRadarNotification(event, policies, now).deliver
    && !isRadarIncidentMuted(state, event, now))
}

/** Count tasks deliberately held by policy, without removing them from state. */
export function countPolicyHeldAnalysisTasks(
  tasks: readonly AnalysisTask[],
  policies: ReadonlyMap<string, RadarNotificationPolicy>,
  now = new Date(),
): number {
  return tasks.filter(task => task.event !== undefined
    && !decideProjectRadarNotification(task.event, policies, now).deliver).length
}
