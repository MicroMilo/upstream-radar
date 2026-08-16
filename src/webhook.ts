import { createHash, createHmac } from 'node:crypto'
import { TOOL_VERSION } from './version.js'
import type {
  CompatibilityEvent,
  PackageCoordinate,
  ProjectReference,
  RadarEvent,
  RadarState,
  VulnerabilityEvent,
} from './radar-types.js'
import { WEBHOOK_DELIVERY_SCHEMA, type WebhookDeliveryState } from './radar-types.js'

export const RADAR_WEBHOOK_SCHEMA = 'upstream-radar.webhook/v1alpha1' as const

const MAX_WEBHOOK_EVENTS = 64
const MAX_WEBHOOK_TEXT = 24 * 1024
const MAX_FEISHU_TEXT_BYTES = 16 * 1024
const MAX_WEBHOOK_DELIVERIES = 10_000
const MAX_WEBHOOK_PENDING_EVENTS = 10_000

export interface RadarWebhookEventNotice {
  id: string
  incidentId: string
  change: RadarEvent['change']
  kind: RadarEvent['kind']
  detectedAt: string
  project: {
    id: string
    name: string
    owner?: string
    repository?: string
  }
  summary: string
  [key: string]: unknown
}

export interface RadarWebhookPayload {
  schema: typeof RADAR_WEBHOOK_SCHEMA
  sentAt: string
  tool: { name: 'upstream-radar'; version: string }
  totalEvents: number
  truncated: boolean
  text: string
  events: RadarWebhookEventNotice[]
}

export interface SendRadarWebhookOptions {
  fetch?: typeof fetch
  now?: Date
  /** Feishu V2 signature secret; read from the environment, never from Radar state. */
  feishuSecret?: string
}

function bounded(value: string, maxLength: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`
}

function boundedUtf8(value: string, maxBytes: number): string {
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean
  const suffix = '…'
  let output = ''
  for (const character of clean) {
    if (Buffer.byteLength(`${output}${character}${suffix}`, 'utf8') > maxBytes) break
    output += character
  }
  return `${output}${suffix}`
}

function packageLabel(value: PackageCoordinate): string {
  return `${bounded(value.name, 512)}@${bounded(value.version, 512)}`
}

function projectReference(project: ProjectReference): RadarWebhookEventNotice['project'] {
  return {
    id: bounded(project.id, 512),
    name: bounded(project.name, 512),
    ...(project.owner === undefined ? {} : { owner: bounded(project.owner, 512) }),
    ...(project.repository === undefined ? {} : { repository: bounded(project.repository, 2_048) }),
  }
}

function coordinate(value: PackageCoordinate): PackageCoordinate {
  return {
    ecosystem: 'npm',
    name: bounded(value.name, 512),
    version: bounded(value.version, 512),
  }
}

function pathLabels(paths: readonly PackageCoordinate[][]): string[][] {
  return paths.slice(0, 4).map(path => path.slice(0, 64).map(packageLabel))
}

function advisoryRiskSummary(event: VulnerabilityEvent): string {
  const parts = [
    ...(event.advisory.riskSignals?.cisaKev === undefined ? [] : ['CISA KEV: known exploited']),
    ...(event.advisory.riskSignals?.epss === undefined ? [] : [
      `EPSS: ${(event.advisory.riskSignals.epss.score * 100).toFixed(1)}% estimated exploitation probability`,
    ]),
  ]
  return parts.length === 0 ? '' : ` [${parts.join('; ')}]`
}

function vulnerabilityNotice(event: VulnerabilityEvent): RadarWebhookEventNotice {
  const path = event.paths[0]?.map(packageLabel).join(' -> ') ?? 'dependency path unavailable'
  const scope = event.affectedPlugins === undefined || event.affectedPlugins.length <= 1
    ? ''
    : ` across ${event.affectedPlugins.length} DSH plugins`
  const summary = `${packageLabel(event.affected)} is affected by ${bounded(event.advisory.id, 256)}${scope} via ${bounded(path, 4_096)}${advisoryRiskSummary(event)}`
  return {
    id: bounded(event.id, 512),
    incidentId: bounded(event.incidentId, 512),
    change: event.change,
    kind: event.kind,
    detectedAt: bounded(event.detectedAt, 256),
    project: projectReference(event.project),
    summary,
    plugin: coordinate(event.plugin),
    ...(event.affectedPlugins === undefined
      ? {}
      : { affectedPlugins: event.affectedPlugins.slice(0, 64).map(coordinate) }),
    affected: coordinate(event.affected),
    ...(event.affectedSources === undefined ? {} : { affectedSources: [...event.affectedSources] }),
    advisory: {
      id: bounded(event.advisory.id, 256),
      aliases: event.advisory.aliases.slice(0, 16).map(item => bounded(item, 256)),
      summary: bounded(event.advisory.summary, 2_048),
      severity: event.kind === 'malware' ? 'critical' : event.advisory.severity,
      fixedVersions: event.advisory.fixedVersions.slice(0, 16).map(item => bounded(item, 256)),
      references: event.advisory.references.slice(0, 16).map(item => bounded(item, 2_048)),
      ...(event.advisory.sources === undefined ? {} : { sources: [...event.advisory.sources] }),
      ...(event.advisory.conflicts === undefined ? {} : {
        conflicts: event.advisory.conflicts.slice(0, 2).map(conflict => ({
          field: conflict.field,
          claims: conflict.claims.slice(0, 2).map(claim => ({
            source: claim.source,
            value: bounded(claim.value, 1_024),
          })),
        })),
      }),
      ...(event.advisory.riskSignals === undefined ? {} : {
        riskSignals: {
          ...(event.advisory.riskSignals.cisaKev === undefined ? {} : {
            cisaKev: {
              knownExploited: true,
              ...(event.advisory.riskSignals.cisaKev.dateAdded === undefined ? {} : { dateAdded: bounded(event.advisory.riskSignals.cisaKev.dateAdded, 128) }),
              ...(event.advisory.riskSignals.cisaKev.dueDate === undefined ? {} : { dueDate: bounded(event.advisory.riskSignals.cisaKev.dueDate, 128) }),
              ...(event.advisory.riskSignals.cisaKev.knownRansomwareCampaignUse === undefined ? {} : { knownRansomwareCampaignUse: bounded(event.advisory.riskSignals.cisaKev.knownRansomwareCampaignUse, 128) }),
            },
          }),
          ...(event.advisory.riskSignals.epss === undefined ? {} : {
            epss: {
              score: event.advisory.riskSignals.epss.score,
              percentile: event.advisory.riskSignals.epss.percentile,
              ...(event.advisory.riskSignals.epss.date === undefined ? {} : { date: bounded(event.advisory.riskSignals.epss.date, 64) }),
            },
          }),
        },
      }),
    },
    paths: pathLabels(event.paths),
  }
}

function compatibilityNotice(event: CompatibilityEvent): RadarWebhookEventNotice {
  const candidate = event.upgradePath?.firstCandidate?.candidate ?? event.candidate
  const signal = event.signals.find(item => item.confidence === 'confirmed' || item.confidence === 'strong')
    ?? event.signals[0]
  const signalText = signal === undefined ? 'needs project analysis' : bounded(signal.summary, 2_048)
  return {
    id: bounded(event.id, 512),
    incidentId: bounded(event.incidentId, 512),
    change: event.change,
    kind: event.kind,
    detectedAt: bounded(event.detectedAt, 256),
    project: projectReference(event.project),
    summary: `${packageLabel(event.installed)} -> ${packageLabel(candidate)}: ${signalText}`,
    plugin: coordinate(event.plugin),
    installed: coordinate(event.installed),
    candidate: coordinate(candidate),
    signals: event.signals.slice(0, 16).map(item => ({
      code: bounded(item.code, 256),
      confidence: item.confidence,
      summary: bounded(item.summary, 2_048),
      ...(item.before === undefined ? {} : { before: bounded(item.before, 2_048) }),
      ...(item.after === undefined ? {} : { after: bounded(item.after, 2_048) }),
    })),
    ...(event.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: bounded(event.releaseNotesUrl, 4_096) }),
  }
}

function sourceHealthNotice(event: Extract<RadarEvent, { kind: 'source-health' }>): RadarWebhookEventNotice {
  return {
    id: bounded(event.id, 512),
    incidentId: bounded(event.incidentId, 512),
    change: event.change,
    kind: event.kind,
    detectedAt: bounded(event.detectedAt, 256),
    project: projectReference(event.project),
    summary: `${bounded(event.source, 256)} is ${event.status} after ${event.failureCount} consecutive failure(s)`,
    source: event.source,
    status: event.status,
    failureCount: event.failureCount,
    lastAttemptedAt: bounded(event.lastAttemptedAt, 256),
    ...(event.lastSucceededAt === undefined ? {} : { lastSucceededAt: bounded(event.lastSucceededAt, 256) }),
    ...(event.error === undefined ? {} : { error: bounded(event.error, 2_048) }),
  }
}

export function toRadarWebhookEventNotice(event: RadarEvent): RadarWebhookEventNotice {
  if (event.kind === 'compatibility') return compatibilityNotice(event)
  if (event.kind === 'source-health') return sourceHealthNotice(event)
  return vulnerabilityNotice(event)
}

export function buildRadarWebhookPayload(events: readonly RadarEvent[], now = new Date()): RadarWebhookPayload {
  if (!Number.isFinite(now.getTime())) throw new Error('webhook timestamp is invalid')
  const unique = [...new Map(events.map(event => [event.id, event])).values()]
  const notices = unique.slice(0, MAX_WEBHOOK_EVENTS).map(toRadarWebhookEventNotice)
  const text = notices.map(event => `[${event.change.toUpperCase()}][${event.kind}] ${event.summary}`).join('\n')
  return {
    schema: RADAR_WEBHOOK_SCHEMA,
    sentAt: now.toISOString(),
    tool: { name: 'upstream-radar', version: TOOL_VERSION },
    totalEvents: unique.length,
    truncated: unique.length > notices.length,
    text: bounded(text, MAX_WEBHOOK_TEXT),
    events: notices,
  }
}

/** Normalize and validate an outbound endpoint without ever storing its secret query value. */
export function normalizeRadarWebhookUrl(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096) {
    throw new Error('webhook URL must be a non-empty URL no longer than 4096 characters')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('webhook URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('webhook URL must use HTTPS')
  if (url.username !== '' || url.password !== '') throw new Error('webhook URL must not contain credentials')
  if (url.hash !== '') throw new Error('webhook URL must not contain a fragment')
  return url.toString()
}

export function radarWebhookEndpointHash(value: string): string {
  return createHash('sha256').update(normalizeRadarWebhookUrl(value), 'utf8').digest('hex')
}

/** Recognize the recommended Feishu/Lark V2 custom-bot endpoint. */
export function isFeishuV2WebhookUrl(value: string): boolean {
  const url = new URL(normalizeRadarWebhookUrl(value))
  return (url.hostname === 'open.feishu.cn' || url.hostname === 'open.larksuite.com')
    && url.pathname.startsWith('/open-apis/bot/v2/hook/')
}

/** Recognize the retired Feishu/Lark V1 custom-bot endpoint. */
export function isLegacyFeishuWebhookUrl(value: string): boolean {
  const url = new URL(normalizeRadarWebhookUrl(value))
  return (url.hostname === 'open.feishu.cn' || url.hostname === 'open.larksuite.com')
    && url.pathname.startsWith('/open-apis/bot/hook/')
}

export interface FeishuWebhookPayload {
  timestamp?: string
  sign?: string
  msg_type: 'text'
  content: { text: string }
}

/** Build the Feishu V2 custom-bot text body without exposing the generic event payload. */
export function buildFeishuWebhookPayload(
  payload: RadarWebhookPayload,
  options: { now?: Date; secret?: string } = {},
): FeishuWebhookPayload {
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('webhook timestamp is invalid')
  const text = boundedUtf8(payload.text.replaceAll('<', '＜'), MAX_FEISHU_TEXT_BYTES)
  const secret = options.secret
  if (secret === undefined || secret.length === 0) return { msg_type: 'text', content: { text } }
  if (secret.length > 4_096) throw new Error('Feishu webhook secret is too long')
  const timestamp = Math.floor(now.getTime() / 1_000).toString()
  const sign = createHmac('sha256', `${timestamp}\n${secret}`).digest('base64')
  return { timestamp, sign, msg_type: 'text', content: { text } }
}

export async function sendRadarWebhook(
  url: string,
  events: readonly RadarEvent[],
  options: SendRadarWebhookOptions = {},
): Promise<RadarWebhookPayload> {
  const endpoint = normalizeRadarWebhookUrl(url)
  if (events.length === 0) return buildRadarWebhookPayload([], options.now)
  if (isLegacyFeishuWebhookUrl(endpoint)) {
    throw new Error('Feishu V1 webhook is not supported; use the V2 /open-apis/bot/v2/hook/... URL')
  }
  const payload = buildRadarWebhookPayload(events, options.now)
  const body = isFeishuV2WebhookUrl(endpoint)
    ? JSON.stringify(buildFeishuWebhookPayload(payload, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.feishuSecret === undefined ? {} : { secret: options.feishuSecret }),
    }))
    : JSON.stringify(payload)
  const fetchImpl = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `upstream-radar/${TOOL_VERSION}`,
        'x-upstream-radar-schema': RADAR_WEBHOOK_SCHEMA,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error: unknown) {
    const kind = error instanceof Error && error.name.length > 0 ? error.name : 'request error'
    throw new Error(`webhook request failed (${bounded(kind, 128)})`)
  }
  if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`)
  return payload
}

export function undeliveredRadarWebhookEvents(
  state: RadarState,
  endpointHash: string,
  events: readonly RadarEvent[],
): RadarEvent[] {
  const sameEndpoint = state.webhook?.endpointHash === endpointHash
  const delivered = sameEndpoint ? state.webhook?.deliveredEventIds ?? {} : {}
  const queued = sameEndpoint ? state.webhook?.pendingEvents ?? [] : []
  const candidates = [...new Map([...queued, ...events].map(event => [event.id, event])).values()]
  const seen = new Set<string>()
  return candidates.filter(event => {
    if (seen.has(event.id) || delivered[event.id] !== undefined) return false
    seen.add(event.id)
    return true
  })
}

/** Put changed events into the durable webhook outbox before applying delivery policy. */
export function queueRadarWebhookEvents(
  state: RadarState,
  endpointHash: string,
  events: readonly RadarEvent[],
): RadarState {
  if (!/^[a-f0-9]{64}$/.test(endpointHash)) throw new Error('webhook endpoint fingerprint is invalid')
  if (events.length === 0) return state
  const existing: WebhookDeliveryState | undefined = state.webhook?.endpointHash === endpointHash
    ? state.webhook
    : undefined
  const delivered = existing?.deliveredEventIds ?? {}
  // Coalesce missed transitions for the same incident. The full transition
  // history remains available, but a quiet window should not dump every
  // intermediate update into the next notification batch.
  const pending = new Map((existing?.pendingEvents ?? []).map(event => [event.incidentId, event]))
  for (const event of events) {
    if (delivered[event.id] === undefined) pending.set(event.incidentId, event)
  }
  const pendingEvents = [...pending.values()].slice(-MAX_WEBHOOK_PENDING_EVENTS)
  return {
    ...state,
    webhook: {
      schema: WEBHOOK_DELIVERY_SCHEMA,
      endpointHash,
      deliveredEventIds: { ...delivered },
      ...(pendingEvents.length === 0 ? {} : { pendingEvents }),
    },
  }
}

export function markRadarWebhookEventsDelivered(
  state: RadarState,
  endpointHash: string,
  events: readonly RadarEvent[],
  deliveredAt = new Date(),
): RadarState {
  if (!Number.isFinite(deliveredAt.getTime())) throw new Error('webhook delivery timestamp is invalid')
  if (!/^[a-f0-9]{64}$/.test(endpointHash)) throw new Error('webhook endpoint fingerprint is invalid')
  const existing: WebhookDeliveryState | undefined = state.webhook?.endpointHash === endpointHash
    ? state.webhook
    : undefined
  const delivered = { ...(existing?.deliveredEventIds ?? {}) }
  const timestamp = deliveredAt.toISOString()
  const deliveredIds = new Set(events.map(event => event.id))
  for (const event of events) delivered[event.id] = timestamp
  const entries = Object.entries(delivered)
    .sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))
    .slice(-MAX_WEBHOOK_DELIVERIES)
  const pendingEvents = (existing?.pendingEvents ?? []).filter(event => !deliveredIds.has(event.id))
  return {
    ...state,
    webhook: {
      schema: WEBHOOK_DELIVERY_SCHEMA,
      endpointHash,
      deliveredEventIds: Object.fromEntries(entries),
      ...(pendingEvents.length === 0 ? {} : { pendingEvents }),
    },
  }
}
