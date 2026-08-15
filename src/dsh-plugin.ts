import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderAgentAnalysisPrompt } from './dsh-analysis.js'
import { GitHubReleaseClient } from './github-release.js'
import { parseRadarConfig } from './inventory.js'
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
  return task.event.kind === 'compatibility'
    ? `Compatibility change for ${project}`
    : `${task.event.kind === 'malware' ? 'Malicious package' : 'Vulnerability'} for ${project}`
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

/** Synchronous follow-up admission is the acknowledgement boundary; failures stay queued. */
export function deliverPendingAnalysisTasks(state: RadarState, agent: DshAgentLike): RadarState {
  let delivered = 0
  for (const task of state.pendingAnalysisTasks) {
    try {
      agent.followup(createDshRadarMessage(task))
      delivered += 1
    } catch {
      break
    }
  }
  if (delivered === 0) return state
  return { ...state, pendingAnalysisTasks: state.pendingAnalysisTasks.slice(delivered) }
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
          const radarConfig = await readConfig(configFile)
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
