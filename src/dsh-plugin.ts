import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderAgentAnalysisGroupPrompt, renderAgentAnalysisPrompt } from './dsh-analysis.js'
import { GitHubReleaseClient } from './github-release.js'
import { parseRadarConfig } from './inventory.js'
import { refreshRadarConfigFromDshProfile } from './init.js'
import { OsvClient } from './osv.js'
import { NpmReleaseClient } from './npm-release.js'
import { pollRadar } from './radar.js'
import { loadRadarState, saveRadarState } from './radar-state.js'
import type { AnalysisTask, RadarState } from './radar-types.js'

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

interface DshAgentLike {
  followup(message: DshRadarMessage): void
}

interface DshRadarContext {
  agents: {
    roots(): DshAgentLike[]
  }
  logger: {
    info(message: string): void
    warn(message: string): void
  }
  effect(setup: () => void | (() => void | Promise<void>), label?: string): void
  on(event: 'agent/created', listener: () => void): () => void
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
  return name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/dsh-')
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

/** Synchronous follow-up admission is the acknowledgement boundary; failures stay queued. */
export function deliverPendingAnalysisTasks(state: RadarState, agent: DshAgentLike): RadarState {
  const deliveredIds = new Set<string>()
  for (const group of groupPendingAnalysisTasks(state.pendingAnalysisTasks)) {
    try {
      agent.followup(group.length === 1 ? createDshRadarMessage(group[0]!) : createDshRadarFamilyMessage(group))
      for (const task of group) deliveredIds.add(task.id)
    } catch {
      break
    }
  }
  if (deliveredIds.size === 0) return state
  return {
    ...state,
    pendingAnalysisTasks: state.pendingAnalysisTasks.filter(task => !deliveredIds.has(task.id)),
  }
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
  const releases = new NpmReleaseClient()
  const releaseNotes = new GitHubReleaseClient()

  ctx.effect(() => {
    let stopped = false
    let serial = Promise.resolve()
    const run = (poll: boolean): void => {
      serial = serial.then(async () => {
        if (stopped) return
        let state = await loadRadarState(stateFile)
        if (poll) {
          const configured = await readConfig(configFile)
          const radarConfig = config.profile === undefined || config.refreshProfile === false
            ? configured
            : await refreshRadarConfigFromDshProfile(configured, config.profile)
          if (radarConfig !== configured && JSON.stringify(radarConfig.projects) !== JSON.stringify(configured.projects)) {
            ctx.logger.info(`upstream-radar: refreshed installed DSH profile ${config.profile}`)
          }
          const result = await pollRadar(radarConfig.projects, state, source, new Date(), releases, releaseNotes)
          state = result.state
          // Persist before model delivery. A crash may duplicate a task, but cannot silently lose it.
          await saveRadarState(stateFile, state)
          if (result.events.length > 0) {
            ctx.logger.info(`upstream-radar: ${result.events.length} change(s), ${result.analysisTasks.length} analysis task(s)`)
          }
          for (const error of result.sourceErrors) {
            ctx.logger.warn(`upstream-radar: ${error.source}: ${safeMessage(error.message)}`)
          }
        }
        const agent = ctx.agents.roots()[0]
        if (agent === undefined || state.pendingAnalysisTasks.length === 0) return
        const next = deliverPendingAnalysisTasks(state, agent)
        if (next !== state) await saveRadarState(stateFile, next)
      }).catch((error: unknown) => {
        ctx.logger.warn(`upstream-radar: cycle failed: ${safeMessage(error)}`)
      })
    }

    const stopCreated = ctx.on('agent/created', () => { run(false) })
    if (config.runOnStart !== false) run(true)
    const timer = setInterval(() => { run(true) }, intervalSeconds * 1_000)
    return async () => {
      stopped = true
      clearInterval(timer)
      stopCreated()
      await serial
    }
  }, 'upstream-radar.lifecycle()')
}
