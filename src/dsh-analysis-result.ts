import {
  ANALYSIS_TASK_SCHEMA,
  type AgentAnalysisResult,
} from './radar-types.js'

const TASK_ID = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}'
const MARKER_PATTERN = new RegExp(
  `^\\[UPSTREAM RADAR ANALYSIS TASK (?:id|ids)=(${TASK_ID}(?:,${TASK_ID})*) schema=${ANALYSIS_TASK_SCHEMA.replaceAll('.', '\\.') }\\]\\s*`,
)

const RESULT_KEYS = [
  'project_exposure',
  'confidence',
  'evidence',
  'recommended_action',
  'urgency',
  'reasoning_summary',
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
function boundedText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0)
}

/** Render a stable, machine-readable prefix that identifies the Radar task(s). */
export function renderAnalysisTaskMarker(taskIds: readonly string[]): string {
  if (taskIds.length === 0 || taskIds.length > 64) throw new Error('analysis task marker requires 1 to 64 task ids')
  const unique = new Set(taskIds)
  if (unique.size !== taskIds.length || taskIds.some(taskId => !new RegExp(`^${TASK_ID}$`).test(taskId))) {
    throw new Error('analysis task marker contains an invalid or duplicate task id')
  }
  const field = taskIds.length === 1 ? `id=${taskIds[0]}` : `ids=${taskIds.join(',')}`
  return `[UPSTREAM RADAR ANALYSIS TASK ${field} schema=${ANALYSIS_TASK_SCHEMA}]`
}

/** Read task ids only from the prefix emitted by this plugin. */
export function extractAnalysisTaskIds(text: string): string[] | undefined {
  const match = MARKER_PATTERN.exec(text)
  if (match === null) return undefined
  const raw = match[1]
  if (raw === undefined) return undefined
  const ids = raw.split(',')
  if (ids.length === 0 || ids.length > 64 || new Set(ids).size !== ids.length) return undefined
  return ids
}

function textFromMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const message = asRecord(value)
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const textBlocks = content.flatMap(block => {
    const record = asRecord(block)
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  })
  return textBlocks.length === 0 ? undefined : textBlocks.join('')
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // A few model adapters preserve a JSON code fence. Accept only a fence that
    // contains the complete response; never search arbitrary prose for JSON.
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
    if (fenced?.[1] === undefined) return undefined
    try {
      return JSON.parse(fenced[1]) as unknown
    } catch {
      return undefined
    }
  }
}

/**
 * Parse the exact JSON contract emitted by the DSH model.
 *
 * This function deliberately rejects prose, extra fields, and oversized text.
 * The result is advisory data only; callers still attach it to the exact Radar
 * event and must not treat it as proof that a project is safe.
 */
export function parseAgentAnalysisResult(value: unknown): AgentAnalysisResult | undefined {
  const message = asRecord(value)
  if (message !== undefined) {
    if (message.role !== 'assistant') return undefined
    const source = asRecord(message.source)
    if (source?.kind !== 'model') return undefined
  }
  const text = textFromMessage(value)
  if (text === undefined || text.length > 64 * 1024) return undefined
  const parsed = asRecord(parseJsonText(text))
  if (parsed === undefined) return undefined
  const keys = Object.keys(parsed).sort()
  const expectedKeys = [...RESULT_KEYS].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined
  if (parsed.project_exposure !== 'exposed'
    && parsed.project_exposure !== 'likely_exposed'
    && parsed.project_exposure !== 'not_exposed'
    && parsed.project_exposure !== 'unknown') return undefined
  if (parsed.confidence !== 'high' && parsed.confidence !== 'medium' && parsed.confidence !== 'low') return undefined
  if (parsed.urgency !== 'immediate'
    && parsed.urgency !== 'within_24_hours'
    && parsed.urgency !== 'planned'
    && parsed.urgency !== 'monitor') return undefined
  if (!Array.isArray(parsed.evidence) || parsed.evidence.length > 64
    || !parsed.evidence.every(item => boundedText(item, 4_096))) return undefined
  if (!boundedText(parsed.recommended_action, 8_192)
    || !boundedText(parsed.reasoning_summary, 16_384)) return undefined
  return {
    project_exposure: parsed.project_exposure,
    confidence: parsed.confidence,
    evidence: [...parsed.evidence],
    recommended_action: parsed.recommended_action,
    urgency: parsed.urgency,
    reasoning_summary: parsed.reasoning_summary,
  }
}
