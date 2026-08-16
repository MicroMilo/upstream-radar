import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderAgentAnalysisGroupPrompt, renderAgentAnalysisPrompt } from './dsh-analysis.js'
import {
  discoverDshRuntimeNodeModulesDirectory,
  discoverDshRuntimePackage,
  discoverDshRuntimePackageDirectory,
} from './dsh-runtime.js'
import { GitHubReleaseClient } from './github-release.js'
import { parseRadarConfig } from './inventory.js'
import { refreshRadarConfigFromDshProfile } from './init.js'
import { OsvClient } from './osv.js'
import { NpmCandidateGraphClient } from './npm-candidate.js'
import { NpmReleaseClient } from './npm-release.js'
import {
  createNotificationPolicyMap,
  decideProjectRadarNotification,
  filterNotifiableRadarEvents,
} from './notification-policy.js'
import { pollRadar } from './radar.js'
import { loadRadarState, saveRadarState } from './radar-state.js'
import {
  markRadarWebhookEventsDelivered,
  normalizeRadarWebhookUrl,
  queueRadarWebhookEvents,
  radarWebhookEndpointHash,
  sendRadarWebhook,
  undeliveredRadarWebhookEvents,
} from './webhook.js'
import {
  ANALYSIS_DELIVERY_SCHEMA,
  type AnalysisDelivery,
  type AnalysisTask,
  type ProjectReference,
  type RadarEvent,
  type RadarNotificationPolicy,
  type RadarState,
  type StoredAnalysisResult,
} from './radar-types.js'
import {
  extractAnalysisTaskIds,
  parseAgentAnalysisResult,
} from './dsh-analysis-result.js'

export const name = 'upstream-radar'
export const inject = ['agents']

export interface Config {
  configFile?: string
  stateFile?: string
  /** DSH profile name written by `init --dsh-patch`; enables safe graph refresh. */
  profile?: string
  /** Set false to keep a generated inventory as a static snapshot. */
  refreshProfile?: boolean
  intervalSeconds?: number
  osvBaseUrl?: string
  registry?: string
  /** Set false to skip bounded transitive candidate graph checks. */
  deepCandidates?: boolean
  /** Optional HTTPS endpoint for changed-event notifications; the URL is never persisted. */
  webhookUrl?: string
  runOnStart?: boolean
}

export interface DshRadarMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: {
    kind: 'plugin'
    plugin: 'upstream-radar'
    form: 'notice'
    summary: string
  }
}

export interface DshSessionEventLike {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

export interface DshSessionLike {
  id?: string
  header?: {
    cwd?: string | null
  }
  events?: readonly DshSessionEventLike[]
}

export interface DshAgentLike {
  id?: string
  followup(message: DshRadarMessage): void
  session?: DshSessionLike
}

export interface DshRadarContext {
  agents: {
    roots(): DshAgentLike[]
  }
  logger: {
    info(message: string): void
    warn(message: string): void
  }
  effect(setup: () => void | (() => void | Promise<void>), label?: string): void
  on(event: 'agent/created', listener: () => void): () => void
  on(event: 'session/event', listener: (session: DshSessionLike, event: DshSessionEventLike) => void): () => void
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
}

function taskSummary(task: AnalysisTask): string {
  const project = task.event.project.name.slice(0, 60)
  if (task.event.kind === 'compatibility') {
    const packageName = task.event.installed.name
    if (packageName === '@deepseek-ai/cordis' || packageName.startsWith('@deepseek-ai/dsh-')) {
      return `DSH runtime compatibility change for ${project}`
    }
    return `Compatibility change for ${project}`
  }
  if (task.event.kind === 'source-health') return `Monitoring source degraded for ${project}`
  return `${task.event.kind === 'malware' ? 'Malicious package' : 'Vulnerability'} for ${project}`
}

function isDshRuntimePackage(name: string): boolean {
  return name === '@deepseek-ai/dsh'
    || name === '@deepseek-ai/cordis'
    || name.startsWith('@deepseek-ai/dsh-')
}

/** Keep independent state incidents, but combine one project's DSH runtime updates into one Agent notice. */
export function groupPendingAnalysisTasks(tasks: readonly AnalysisTask[]): AnalysisTask[][] {
  const groups: AnalysisTask[][] = []
  const byProject = new Map<string, AnalysisTask[]>()
  for (const task of tasks) {
    const event = task.event
    if (event.kind !== 'compatibility' || !isDshRuntimePackage(event.installed.name)) {
      groups.push([task])
      continue
    }
    const key = `${event.project.id}\0dsh-runtime\0${event.detectedAt}`
    const existing = byProject.get(key)
    if (existing !== undefined) {
      existing.push(task)
      continue
    }
    const group = [task]
    byProject.set(key, group)
    groups.push(group)
  }
  return groups
}

export function createDshRadarMessage(task: AnalysisTask): DshRadarMessage {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: renderAgentAnalysisPrompt(task) }],
    source: {
      kind: 'plugin' as const,
      plugin: 'upstream-radar' as const,
      form: 'notice' as const,
      summary: taskSummary(task),
    },
  })
}

export function createDshRadarFamilyMessage(tasks: readonly AnalysisTask[]): DshRadarMessage {
  const first = tasks[0]
  if (first === undefined) throw new Error('cannot create a DSH family message without tasks')
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: renderAgentAnalysisGroupPrompt(tasks) }],
    source: {
      kind: 'plugin' as const,
      plugin: 'upstream-radar' as const,
      form: 'notice' as const,
      summary: `DSH runtime compatibility changes (${tasks.length}) for ${first.event.project.name.slice(0, 60)}`,
    },
  })
}

function createAnalysisDelivery(
  message: DshRadarMessage,
  tasks: readonly AnalysisTask[],
  agent: DshAgentLike,
  deliveredAt: string,
): AnalysisDelivery {
  const first = tasks[0]
  if (first === undefined) throw new Error('analysis delivery cannot be empty')
  return {
    schema: ANALYSIS_DELIVERY_SCHEMA,
    id: message.id,
    messageId: message.id,
    taskRefs: tasks.map(task => ({
      taskId: task.id,
      incidentId: task.event.incidentId,
      eventId: task.event.id,
    })),
    projectId: first.event.project.id,
    deliveredAt,
    ...(agent.id === undefined ? {} : { agentId: agent.id }),
    ...(agent.session?.id === undefined ? {} : { sessionId: agent.session.id }),
  }
}

function messageRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function messageText(value: unknown): string | undefined {
  const message = messageRecord(value)
  if (message === undefined || !Array.isArray(message.content)) return undefined
  const text = message.content.flatMap(block => {
    const record = messageRecord(block)
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('')
  return text.length === 0 ? undefined : text
}

function messageId(value: unknown): string | undefined {
  const message = messageRecord(value)
  return typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined
}

function isRadarNotice(value: unknown): boolean {
  const message = messageRecord(value)
  const source = messageRecord(message?.source)
  return message?.role === 'user'
    && source?.kind === 'plugin'
    && source.plugin === 'upstream-radar'
    && source.form === 'notice'
}

function isModelAssistant(value: unknown): boolean {
  const message = messageRecord(value)
  const source = messageRecord(message?.source)
  return message?.role === 'assistant' && source?.kind === 'model'
}

function sessionId(session: DshSessionLike): string | undefined {
  return typeof session.id === 'string' && session.id.length > 0 ? session.id : undefined
}

function eventSequence(event: DshSessionEventLike): number | undefined {
  return typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0
    ? event.seq
    : undefined
}

function sessionUserEvents(session: DshSessionLike): Array<{ event: DshSessionEventLike; message: Record<string, unknown>; text: string }> {
  return (session.events ?? []).flatMap(event => {
    if (event.type !== 'user/message') return []
    const message = messageRecord(event.data)
    const text = messageText(event.data)
    if (message === undefined || text === undefined || !isRadarNotice(event.data)) return []
    return [{ event, message, text }]
  })
}

function activeEventForIncident(state: RadarState, incidentId: string): RadarEvent | undefined {
  const vulnerability = Object.values(state.activeVulnerabilities).find(item => item.event.incidentId === incidentId)
  if (vulnerability !== undefined) return vulnerability.event
  const compatibility = state.activeCompatibility[incidentId]
    ?? Object.values(state.activeCompatibility).find(item => item.event.incidentId === incidentId)
  if (compatibility !== undefined) return compatibility.event
  const sourceHealth = Object.values(state.activeSourceHealth ?? {}).find(item => item.event.incidentId === incidentId)
  return sourceHealth?.event
}

function deliveryTaskIds(delivery: AnalysisDelivery): string[] {
  return delivery.taskRefs.map(reference => reference.taskId)
}

function sameTaskIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((taskId, index) => taskId === right[index])
}

function deliveryForUserMessage(
  state: RadarState,
  knownDeliveries: ReadonlyMap<string, AnalysisDelivery>,
  message: Record<string, unknown>,
  text: string,
): AnalysisDelivery | undefined {
  const id = messageId(message)
  if (id === undefined) return undefined
  const taskIds = extractAnalysisTaskIds(text)
  if (taskIds === undefined) return undefined
  const fromState = state.analysisDeliveries?.[id]
  const delivery = fromState ?? knownDeliveries.get(id)
  if (delivery === undefined || !sameTaskIds(deliveryTaskIds(delivery), taskIds)) return undefined
  return delivery
}

function resultEventRefsAreCurrent(state: RadarState, delivery: AnalysisDelivery): AnalysisDelivery['taskRefs'] {
  return delivery.taskRefs.filter(reference => activeEventForIncident(state, reference.incidentId)?.id === reference.eventId)
}

function deliveryForAssistantMessage(
  state: RadarState,
  session: DshSessionLike,
  event: DshSessionEventLike,
  knownDeliveries: ReadonlyMap<string, AnalysisDelivery>,
): { delivery: AnalysisDelivery; userMessageId: string; userMessageSeq: number } | undefined {
  const assistantSeq = eventSequence(event)
  const currentSessionId = sessionId(session)
  if (assistantSeq === undefined || currentSessionId === undefined) return undefined
  const userEvents = sessionUserEvents(session)
  const candidates: Array<{ delivery: AnalysisDelivery; userMessageId: string; userMessageSeq: number }> = []
  const allDeliveries = new Map<string, AnalysisDelivery>([
    ...Object.entries(state.analysisDeliveries ?? {}),
    ...knownDeliveries,
  ])
  for (const delivery of allDeliveries.values()) {
    if (delivery.sessionId !== undefined && delivery.sessionId !== currentSessionId) continue
    if (delivery.userMessageId !== undefined) {
      const known = userEvents.find(item => messageId(item.message) === delivery.userMessageId)
      if (known === undefined) continue
    }
    const user = userEvents
      .filter(item => messageId(item.message) === delivery.messageId || messageId(item.message) === delivery.userMessageId)
      .map(item => {
        const sequence = eventSequence(item.event)
        const id = messageId(item.message)
        return sequence === undefined || id === undefined ? undefined : { sequence, id }
      })
      .filter((item): item is { sequence: number; id: string } => item !== undefined && item.sequence < assistantSeq)
      .at(-1)
    if (user === undefined) continue
    candidates.push({ delivery, userMessageId: user.id, userMessageSeq: user.sequence })
  }
  candidates.sort((left, right) => right.userMessageSeq - left.userMessageSeq)
  return candidates[0]
}

export interface DshAnalysisEventOutcome {
  state: RadarState
  accepted: StoredAnalysisResult[]
  consumedDeliveryIds: string[]
}

/**
 * Consume one DSH session event without trusting arbitrary transcript text.
 * Only a plugin-originated message admitted as a durable delivery can bind a
 * later model response to a Radar incident.
 */
export function applyDshAnalysisSessionEvent(
  state: RadarState,
  session: DshSessionLike,
  event: DshSessionEventLike,
  knownDeliveries: ReadonlyMap<string, AnalysisDelivery> = new Map(),
  now = new Date(),
): DshAnalysisEventOutcome {
  if (!Number.isFinite(now.getTime())) throw new Error('analysis result time is invalid')
  if (event.type === 'user/message') {
    if (!isRadarNotice(event.data)) return { state, accepted: [], consumedDeliveryIds: [] }
    const message = messageRecord(event.data)
    const text = messageText(event.data)
    const currentSessionId = sessionId(session)
    const sequence = eventSequence(event)
    const currentMessageId = messageId(message)
    if (message === undefined || text === undefined || currentSessionId === undefined
      || sequence === undefined || currentMessageId === undefined) {
      return { state, accepted: [], consumedDeliveryIds: [] }
    }
    const delivery = deliveryForUserMessage(state, knownDeliveries, message, text)
    if (delivery === undefined) return { state, accepted: [], consumedDeliveryIds: [] }
    const updatedDelivery: AnalysisDelivery = {
      ...delivery,
      sessionId: currentSessionId,
      userMessageId: currentMessageId,
      userMessageSeq: sequence,
    }
    const deliveries = { ...(state.analysisDeliveries ?? {}), [updatedDelivery.id]: updatedDelivery }
    return {
      state: { ...state, analysisDeliveries: deliveries },
      accepted: [],
      consumedDeliveryIds: [],
    }
  }
  if (event.type !== 'assistant/message') return { state, accepted: [], consumedDeliveryIds: [] }
  const data = messageRecord(event.data)
  const assistant = messageRecord(data?.message)
  if (assistant === undefined || !isModelAssistant(assistant)) return { state, accepted: [], consumedDeliveryIds: [] }
  const parsed = parseAgentAnalysisResult(assistant)
  if (parsed === undefined) return { state, accepted: [], consumedDeliveryIds: [] }
  const matched = deliveryForAssistantMessage(state, session, event, knownDeliveries)
  if (matched === undefined) return { state, accepted: [], consumedDeliveryIds: [] }
  const currentRefs = resultEventRefsAreCurrent(state, matched.delivery)
  const assistantMessageId = messageId(assistant)
  const currentSessionId = sessionId(session)
  if (currentRefs.length === 0 || assistantMessageId === undefined || currentSessionId === undefined) {
    const deliveries = { ...(state.analysisDeliveries ?? {}) }
    delete deliveries[matched.delivery.id]
    return { state: { ...state, analysisDeliveries: deliveries }, accepted: [], consumedDeliveryIds: [matched.delivery.id] }
  }
  const receivedAt = new Date(typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now.getTime()).toISOString()
  const results = { ...(state.analysisResults ?? {}) }
  const accepted: StoredAnalysisResult[] = []
  for (const reference of currentRefs) {
    const stored: StoredAnalysisResult = {
      schema: 'upstream-radar.analysis-result/v1alpha1',
      taskId: reference.taskId,
      incidentId: reference.incidentId,
      eventId: reference.eventId,
      deliveryId: matched.delivery.id,
      receivedAt,
      sessionId: currentSessionId,
      userMessageId: matched.userMessageId,
      assistantMessageId,
      ...parsed,
    }
    results[reference.incidentId] = stored
    accepted.push(stored)
  }
  const deliveries = { ...(state.analysisDeliveries ?? {}) }
  delete deliveries[matched.delivery.id]
  return {
    state: { ...state, analysisDeliveries: deliveries, analysisResults: results },
    accepted,
    consumedDeliveryIds: [matched.delivery.id],
  }
}

function normalizedWorkspace(workspace: string | undefined): string | undefined {
  if (workspace === undefined || workspace.trim() === '') return undefined
  return resolve(workspace)
}

/**
 * Match one project to a DSH root by the session's working directory.
 *
 * A single root remains the backwards-compatible default. With multiple roots,
 * an exact workspace match is required; guessing would deliver a security
 * notice to the wrong project session.
 */
export function selectDshAgentForProject(
  project: ProjectReference,
  agents: readonly DshAgentLike[],
): DshAgentLike | undefined {
  if (agents.length === 1) return agents[0]
  const workspace = normalizedWorkspace(project.workspace)
  if (workspace === undefined) return undefined
  const matches = agents.filter((agent) => {
    const cwd = agent.session?.header?.cwd
    return typeof cwd === 'string' && normalizedWorkspace(cwd) === workspace
  })
  return matches.length === 1 ? matches[0] : undefined
}

type DeliveryObserver = (delivery: AnalysisDelivery, phase: 'before' | 'accepted' | 'rejected') => void

/** Deliver grouped tasks to the matching DSH root; unroutable tasks stay queued. */
export function deliverPendingAnalysisTasksToAgents(
  state: RadarState,
  agents: readonly DshAgentLike[],
  now = new Date(),
  observeDelivery?: DeliveryObserver,
  notificationPolicies: ReadonlyMap<string, RadarNotificationPolicy> = new Map(),
): RadarState {
  if (!Number.isFinite(now.getTime())) throw new Error('analysis delivery time is invalid')
  const deliveredIds = new Set<string>()
  const deliveries = { ...(state.analysisDeliveries ?? {}) }
  for (const group of groupPendingAnalysisTasks(state.pendingAnalysisTasks)) {
    const first = group[0]
    if (first === undefined) continue
    if (group.some(task => !decideProjectRadarNotification(task.event, notificationPolicies, now).deliver)) continue
    const agent = selectDshAgentForProject(first.event.project, agents)
    if (agent === undefined) continue
    const message = group.length === 1 ? createDshRadarMessage(group[0]!) : createDshRadarFamilyMessage(group)
    const delivery = createAnalysisDelivery(message, group, agent, now.toISOString())
    observeDelivery?.(delivery, 'before')
    try {
      agent.followup(message)
      observeDelivery?.(delivery, 'accepted')
      deliveries[delivery.id] = delivery
      for (const task of group) deliveredIds.add(task.id)
    } catch {
      observeDelivery?.(delivery, 'rejected')
      // Admission failed for this project only; unrelated project tasks may
      // still be delivered, while this group remains durable for retry.
      continue
    }
  }
  if (deliveredIds.size === 0) return state
  return {
    ...state,
    pendingAnalysisTasks: state.pendingAnalysisTasks.filter(task => !deliveredIds.has(task.id)),
    analysisDeliveries: deliveries,
  }
}

/** Synchronous follow-up admission is the acknowledgement boundary; failures stay queued. */
export function deliverPendingAnalysisTasks(
  state: RadarState,
  agent: DshAgentLike,
  notificationPolicies?: ReadonlyMap<string, RadarNotificationPolicy>,
): RadarState {
  return deliverPendingAnalysisTasksToAgents(state, [agent], new Date(), undefined, notificationPolicies)
}

async function readConfig(path: string): Promise<ReturnType<typeof parseRadarConfig>> {
  const contents = await readFile(path, 'utf8')
  if (Buffer.byteLength(contents) > 256 * 1024 * 1024) throw new Error('radar config exceeds the file size limit')
  try {
    return parseRadarConfig(JSON.parse(contents) as unknown)
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new Error('radar config is not valid JSON')
    throw error
  }
}

/** Cordis function-plugin entrypoint. The polling loop stays deterministic; DSH receives only matched tasks. */
export function apply(ctx: DshRadarContext, config: Config = {}): void {
  if (config.configFile === undefined || config.configFile.trim() === '') {
    ctx.logger.warn('upstream-radar: UPSTREAM_RADAR_CONFIG is not set; monitoring is dormant')
    return
  }
  const configFile = resolve(config.configFile)
  const stateFile = resolve(config.stateFile ?? `${configFile}.state.json`)
  const intervalSeconds = config.intervalSeconds ?? 1_800
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 300 || intervalSeconds > 86_400) {
    throw new Error('upstream-radar intervalSeconds must be between 300 and 86400')
  }
  const source = new OsvClient({ ...(config.osvBaseUrl === undefined ? {} : { baseUrl: config.osvBaseUrl }) })
  const releases = new NpmReleaseClient({ ...(config.registry === undefined ? {} : { registry: config.registry }) })
  const candidateGraphs = config.deepCandidates === false
    ? undefined
    : new NpmCandidateGraphClient({ ...(config.registry === undefined ? {} : { registry: config.registry }) })
  const releaseNotes = new GitHubReleaseClient()
  const configuredWebhookUrl = config.webhookUrl ?? process.env.UPSTREAM_RADAR_WEBHOOK_URL
  const webhookUrl = configuredWebhookUrl === undefined || configuredWebhookUrl.trim() === ''
    ? undefined
    : normalizeRadarWebhookUrl(configuredWebhookUrl)
  const feishuSecret = process.env.UPSTREAM_RADAR_FEISHU_SECRET?.trim() || undefined
  const webhookEndpointHash = webhookUrl === undefined ? undefined : radarWebhookEndpointHash(webhookUrl)
  const dshHostNodeModulesDirectory = config.profile === undefined || config.refreshProfile === false
    ? undefined
    : discoverDshRuntimeNodeModulesDirectory()
  const dshHostRuntimePackage = config.profile === undefined || config.refreshProfile === false
    ? undefined
    : discoverDshRuntimePackage()
  const dshHostRuntimePackageDirectory = config.profile === undefined || config.refreshProfile === false
    ? undefined
    : discoverDshRuntimePackageDirectory()
  if (dshHostNodeModulesDirectory !== undefined) {
    ctx.logger.info('upstream-radar: DSH runtime dependency plane discovered for exact graph refresh')
  }

  ctx.effect(() => {
    let stopped = false
    let serial = Promise.resolve()
    const inFlightDeliveries = new Map<string, AnalysisDelivery>()
    let activeNotificationPolicies: ReadonlyMap<string, RadarNotificationPolicy> = new Map()
    let notificationPoliciesLoaded = false
    const onSessionEvent = (session: DshSessionLike, event: DshSessionEventLike): void => {
      serial = serial.then(async () => {
        const state = await loadRadarState(stateFile)
        const outcome = applyDshAnalysisSessionEvent(state, session, event, inFlightDeliveries)
        if (outcome.state !== state) await saveRadarState(stateFile, outcome.state)
        for (const deliveryId of outcome.consumedDeliveryIds) inFlightDeliveries.delete(deliveryId)
        if (outcome.accepted.length > 0) {
          ctx.logger.info(`upstream-radar: accepted ${outcome.accepted.length} verified DSH analysis result(s)`)
        }
      }).catch((error: unknown) => {
        ctx.logger.warn(`upstream-radar: session event handling failed: ${safeMessage(error)}`)
      })
    }
    const run = (poll: boolean): void => {
      serial = serial.then(async () => {
        if (stopped) return
        let state = await loadRadarState(stateFile)
        let notificationPolicies = activeNotificationPolicies
        if (poll) {
          const configured = await readConfig(configFile)
          const radarConfig = config.profile === undefined || config.refreshProfile === false
            ? configured
            : await refreshRadarConfigFromDshProfile(
              configured,
              config.profile,
              undefined,
              dshHostNodeModulesDirectory === undefined ? {} : {
                hostNodeModulesDirectory: dshHostNodeModulesDirectory,
                hostRuntimeSource: 'dsh-process',
                ...(dshHostRuntimePackage === undefined ? {} : { hostRuntimePackage: dshHostRuntimePackage }),
                ...(dshHostRuntimePackageDirectory === undefined ? {} : { hostRuntimePackageDirectory: dshHostRuntimePackageDirectory }),
              },
            )
          if (radarConfig !== configured && JSON.stringify(radarConfig.projects) !== JSON.stringify(configured.projects)) {
            ctx.logger.info(`upstream-radar: refreshed installed DSH profile ${config.profile}`)
          }
          notificationPolicies = createNotificationPolicyMap(radarConfig.projects)
          activeNotificationPolicies = notificationPolicies
          notificationPoliciesLoaded = true
          const result = await pollRadar(radarConfig.projects, state, source, new Date(), releases, releaseNotes, candidateGraphs)
          state = result.state
          // Persist before model delivery. A crash may duplicate a task, but cannot silently lose it.
          await saveRadarState(stateFile, state)
          if (webhookUrl !== undefined && webhookEndpointHash !== undefined) {
            state = queueRadarWebhookEvents(state, webhookEndpointHash, result.events)
            await saveRadarState(stateFile, state)
            const pendingWebhookEvents = filterNotifiableRadarEvents(
              undeliveredRadarWebhookEvents(state, webhookEndpointHash, result.events),
              notificationPolicies,
              new Date(),
            )
            if (pendingWebhookEvents.length > 0) {
              try {
                const payload = await sendRadarWebhook(webhookUrl, pendingWebhookEvents, feishuSecret === undefined ? {} : { feishuSecret })
                const deliveredIds = new Set(payload.events.map(event => event.id))
                const deliveredEvents = pendingWebhookEvents.filter(event => deliveredIds.has(event.id))
                state = markRadarWebhookEventsDelivered(state, webhookEndpointHash, deliveredEvents)
                await saveRadarState(stateFile, state)
                ctx.logger.info(`upstream-radar: delivered ${deliveredEvents.length} changed event(s) to the configured webhook`)
              } catch (error: unknown) {
                ctx.logger.warn(`upstream-radar: webhook delivery failed; will retry: ${safeMessage(error)}`)
              }
            }
          }
          if (result.events.length > 0) {
            ctx.logger.info(`upstream-radar: ${result.events.length} change(s), ${result.analysisTasks.length} analysis task(s)`)
          }
          for (const error of result.sourceErrors) {
            ctx.logger.warn(`upstream-radar: ${error.source}: ${safeMessage(error.message)}`)
          }
        } else if (!notificationPoliciesLoaded) {
          const configured = await readConfig(configFile)
          activeNotificationPolicies = createNotificationPolicyMap(configured.projects)
          notificationPolicies = activeNotificationPolicies
          notificationPoliciesLoaded = true
        }
        const agents = ctx.agents.roots()
        if (agents.length === 0 || state.pendingAnalysisTasks.length === 0) return
        const next = deliverPendingAnalysisTasksToAgents(
          state,
          agents,
          new Date(),
          (delivery, phase) => {
            if (phase === 'rejected') inFlightDeliveries.delete(delivery.id)
            else inFlightDeliveries.set(delivery.id, delivery)
          },
          notificationPolicies,
        )
        if (next !== state) await saveRadarState(stateFile, next)
        const unrouted = groupPendingAnalysisTasks(next.pendingAnalysisTasks).find((group) => {
          const first = group[0]
          return first !== undefined && selectDshAgentForProject(first.event.project, agents) === undefined
        })
        if (unrouted !== undefined) {
          const first = unrouted[0]
          if (first !== undefined) {
            ctx.logger.warn(`upstream-radar: kept ${unrouted.length} analysis task(s) queued; no DSH root matches project ${first.event.project.name} workspace ${first.event.project.workspace ?? '(not configured)'}`)
          }
        }
      }).catch((error: unknown) => {
        ctx.logger.warn(`upstream-radar: cycle failed: ${safeMessage(error)}`)
      })
    }

    const stopCreated = ctx.on('agent/created', () => { run(false) })
    const stopSessionEvents = ctx.on('session/event', onSessionEvent)
    if (config.runOnStart !== false) run(true)
    const timer = setInterval(() => { run(true) }, intervalSeconds * 1_000)
    return async () => {
      stopped = true
      clearInterval(timer)
      stopCreated()
      stopSessionEvents()
      await serial
    }
  }, 'upstream-radar.lifecycle()')
}
