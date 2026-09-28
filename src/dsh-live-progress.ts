/** Live worker telemetry is a monitoring hint, never a compatibility verdict. */
export interface DshLiveProgress {
  schema: 'upstream-radar.dsh-live-progress/v1alpha1'
  caseId: string
  observedAt: string
  phase: 'runtime' | 'artifact' | 'profile' | 'install' | 'load'
  kind: 'started' | 'heartbeat' | 'finished'
  elapsedMs: number
  stdoutBytes: number
  stderrBytes: number
  code?: number | null
  timedOut?: boolean
  outputExceeded?: boolean
}

const PREFIX = 'RADAR_PROGRESS:'
const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KEYS = new Set(['schema', 'caseId', 'observedAt', 'phase', 'kind', 'elapsedMs',
  'stdoutBytes', 'stderrBytes', 'code', 'timedOut', 'outputExceeded'])

export function parseDshLiveProgressLine(line: string, expectedCaseId: string): DshLiveProgress | undefined {
  if (!CASE_ID.test(expectedCaseId) || !line.startsWith(PREFIX) || Buffer.byteLength(line) > 2048) return undefined
  let value: unknown
  try { value = JSON.parse(line.slice(PREFIX.length)) } catch { return undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !KEYS.has(key)) || item.schema !== 'upstream-radar.dsh-live-progress/v1alpha1'
    || item.caseId !== expectedCaseId || typeof item.observedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.observedAt)
    || !Number.isFinite(Date.parse(item.observedAt))
    || !['runtime', 'artifact', 'profile', 'install', 'load'].includes(String(item.phase))
    || !['started', 'heartbeat', 'finished'].includes(String(item.kind))) return undefined
  for (const key of ['elapsedMs', 'stdoutBytes', 'stderrBytes']) {
    if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0 || (item[key] as number) > 600_000_000) return undefined
  }
  if (item.code !== undefined && item.code !== null && (!Number.isSafeInteger(item.code) || (item.code as number) < -1 || (item.code as number) > 255)) return undefined
  if (item.timedOut !== undefined && typeof item.timedOut !== 'boolean') return undefined
  if (item.outputExceeded !== undefined && typeof item.outputExceeded !== 'boolean') return undefined
  return item as unknown as DshLiveProgress
}

/** Docker stderr is untrusted; only validated progress records cross this bridge. */
export async function consumeDshLiveProgress(
  chunks: AsyncIterable<Buffer>, expectedCaseId: string,
  onEvent: (event: DshLiveProgress) => Promise<void>,
): Promise<{ events: number; incomplete: boolean }> {
  if (!CASE_ID.test(expectedCaseId)) throw new Error('live progress requires an exact managed case id')
  let bytes = 0
  let events = 0
  let incomplete = false
  let line = ''
  let discarded = false
  for await (const chunk of chunks) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) { incomplete = true; break }
    for (const character of chunk.toString('utf8')) {
      if (character === '\n') {
        if (!discarded) {
          const event = parseDshLiveProgressLine(line.replace(/\r$/, ''), expectedCaseId)
          if (event !== undefined) {
            if (events >= 8192) { incomplete = true; return { events, incomplete } }
            await onEvent(event)
            events += 1
          } else if (line.startsWith(PREFIX)) incomplete = true
        }
        line = ''
        discarded = false
      } else if (!discarded) {
        line += character
        if (Buffer.byteLength(line) > 2048) {
          if (line.startsWith(PREFIX)) incomplete = true
          line = ''
          discarded = true
        }
      }
    }
  }
  if (line.startsWith(PREFIX)) incomplete = true
  return { events, incomplete }
}
