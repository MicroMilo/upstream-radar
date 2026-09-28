import { dshExternalAuthPrompt } from './dsh-auth-redaction.js'

export const DSH_ACTIVE_CASE_CONCLUSION_SCHEMA = 'upstream-radar.dsh-active-case-conclusion/v1alpha1' as const

export interface DshActiveCaseConclusionReceipt {
  schema: typeof DSH_ACTIVE_CASE_CONCLUSION_SCHEMA
  targetId: string
  activeLaunchId: string
  evidenceDigest: string
  concludedAt: string
  modelAuthored: true
  compatibilityPass: false
  statement: string
  coverageNotes: string[]
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > maximum
    || /[\u0000-\u001f\u007f]/.test(value) || /https?:\/\//i.test(value)
    || dshExternalAuthPrompt(value)
    || /\b(?:api[_-]?key|token|secret|user_code|device_code)\s*[:=]/i.test(value)) {
    throw new Error(`${label} must be bounded plain text without URLs, login codes or secrets`)
  }
  return value.trim()
}

/** Model prose may interpret a result, but cannot invent an executed DSH version. */
export function validateDshActiveCaseConclusionVersions(statement: unknown,
  inspectedVersions: readonly string[]): void {
  if (typeof statement !== 'string') return // The receipt's text boundary reports this separately.
  const observed = new Set(inspectedVersions.filter(version => typeof version === 'string' && version !== ''))
  const version = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)`
  const references = [new RegExp(String.raw`\bDSH\b\s*(?:version|版本)?\s*[:：]?\s*\x60?v?${version}`, 'gi'),
    new RegExp(String.raw`@deepseek-ai/dsh@v?${version}`, 'gi')]
  for (const reference of references) {
    for (const match of statement.matchAll(reference)) {
      const attributed = match[1]
      if (attributed !== undefined && !observed.has(attributed)) {
        throw new Error(`Agent DSH version attribution ${attributed} is not in the exact inspected ledger; observed DSH versions: ${[...observed].sort().join(', ') || 'none'}. Reinspect exact case/version results before concluding.`)
      }
    }
  }
}

/** A conclusion is a model account of this bounded evidence, never a policy pass. */
export function createDshActiveCaseConclusionReceipt(
  targetId: string, activeLaunchId: string, evidenceDigest: string, input: unknown,
): DshActiveCaseConclusionReceipt {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)
    || !/^[a-f0-9]{32}$/.test(activeLaunchId)
    || !/^sha256:[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('invalid exact active-case conclusion scope')
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Agent conclusion must be an object')
  const item = input as Record<string, unknown>
  if (Object.keys(item).some(key => !['launchId', 'statement', 'coverageNotes'].includes(key))
    || item.launchId !== activeLaunchId) throw new Error('Agent conclusion must name only the exact completed launch')
  if (!Array.isArray(item.coverageNotes) || item.coverageNotes.length > 16) {
    throw new Error('Agent conclusion coverage notes exceed their bound')
  }
  return { schema: DSH_ACTIVE_CASE_CONCLUSION_SCHEMA, targetId, activeLaunchId, evidenceDigest,
    concludedAt: new Date().toISOString(), modelAuthored: true, compatibilityPass: false,
    statement: boundedText(item.statement, 'Agent conclusion statement', 4096),
    coverageNotes: item.coverageNotes.map(note => boundedText(note, 'Agent conclusion coverage note', 512)) }
}
