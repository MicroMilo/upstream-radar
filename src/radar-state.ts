import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { emptyRadarState } from './radar.js'
import {
  ANALYSIS_TASK_SCHEMA,
  RADAR_EVENT_SCHEMA,
  RADAR_STATE_SCHEMA,
  type RadarState,
} from './radar-types.js'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function parseRadarState(value: unknown): RadarState {
  const root = asRecord(value)
  if (root?.schema !== RADAR_STATE_SCHEMA) throw new Error('radar state has an unsupported schema')
  const active = asRecord(root.activeVulnerabilities)
  if (active === undefined) throw new Error('radar state has no active vulnerability map')
  const activeCompatibility = asRecord(root.activeCompatibility)
  if (activeCompatibility === undefined) throw new Error('radar state has no active compatibility map')
  if (!Array.isArray(root.pendingAnalysisTasks) || root.pendingAnalysisTasks.length > 100_000) {
    throw new Error('radar state has an invalid pending analysis queue')
  }
  for (const rawTask of root.pendingAnalysisTasks) {
    const task = asRecord(rawTask)
    const event = asRecord(task?.event)
    if (task?.schema !== ANALYSIS_TASK_SCHEMA || typeof task.id !== 'string'
      || typeof task.createdAt !== 'string' || event?.schema !== RADAR_EVENT_SCHEMA
      || typeof event.id !== 'string' || typeof event.incidentId !== 'string'
      || (event.kind !== 'vulnerability' && event.kind !== 'malware' && event.kind !== 'compatibility')) {
      throw new Error('radar state contains an invalid pending analysis task')
    }
  }
  if (Object.keys(active).length > 1_000_000) throw new Error('radar state exceeds the active match limit')
  if (Object.keys(activeCompatibility).length > 1_000_000) {
    throw new Error('radar state exceeds the active compatibility limit')
  }
  for (const [key, rawStored] of Object.entries(active)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    const advisory = asRecord(event?.advisory)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA || typeof event.incidentId !== 'string'
      || (event.kind !== 'vulnerability' && event.kind !== 'malware')
      || typeof advisory?.id !== 'string' || typeof advisory.modified !== 'string') {
      throw new Error(`radar state contains an invalid active match: ${key.slice(0, 256)}`)
    }
  }
  for (const [key, rawStored] of Object.entries(activeCompatibility)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA
      || event.kind !== 'compatibility' || event.incidentId !== key) {
      throw new Error(`radar state contains an invalid compatibility match: ${key.slice(0, 256)}`)
    }
  }
  return structuredClone(value) as RadarState
}

export async function loadRadarState(path: string): Promise<RadarState> {
  try {
    const contents = await readFile(resolve(path), 'utf8')
    if (Buffer.byteLength(contents) > 256 * 1024 * 1024) throw new Error('radar state exceeds the file size limit')
    return parseRadarState(JSON.parse(contents) as unknown)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRadarState()
    if (error instanceof SyntaxError) throw new Error('radar state is not valid JSON')
    throw error
  }
}

export async function saveRadarState(path: string, state: RadarState): Promise<void> {
  const destination = resolve(path)
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
