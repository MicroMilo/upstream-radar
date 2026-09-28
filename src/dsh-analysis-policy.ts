export type DshAnalysisExecutionProfile = 'headless' | 'web' | 'tui' | 'sdk' | 'acp'

export interface DshAnalysisPolicy {
  fingerprint: string
  /** An exact operator-selected plugin artifact. Repository evidence remains bound separately. */
  pluginVersion?: string
  /** Omitted means the Agent's evidence-backed Node recommendation remains authoritative. */
  nodeMajors?: number[]
  /** Omitted means the Agent's evidence-backed execution-profile recommendation remains authoritative. */
  executionProfiles?: DshAnalysisExecutionProfile[]
}

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const PROFILE_ORDER: DshAnalysisExecutionProfile[] = ['headless', 'web', 'tui', 'sdk', 'acp']

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function parseDshAnalysisPolicy(value: unknown, label = 'analysisPolicy'): DshAnalysisPolicy {
  const item = record(value, label)
  if (Object.keys(item).some(key => !['fingerprint', 'pluginVersion', 'nodeMajors', 'executionProfiles'].includes(key))) {
    throw new Error(`${label} contains an unsupported field`)
  }
  if (typeof item.fingerprint !== 'string' || !FINGERPRINT.test(item.fingerprint)) {
    throw new Error(`${label}.fingerprint must be a SHA-256 fingerprint`)
  }
  const pluginVersion = item.pluginVersion
  if (pluginVersion !== undefined && (typeof pluginVersion !== 'string' || !EXACT_VERSION.test(pluginVersion))) {
    throw new Error(`${label}.pluginVersion must be an exact semantic version`)
  }
  let nodeMajors: number[] | undefined
  if (item.nodeMajors !== undefined) {
    if (!Array.isArray(item.nodeMajors) || item.nodeMajors.length === 0 || item.nodeMajors.length > 16) {
      throw new Error(`${label}.nodeMajors must contain between 1 and 16 executable Node.js majors`)
    }
    nodeMajors = item.nodeMajors.map((nodeMajor, index) => {
      if (!Number.isSafeInteger(nodeMajor) || (nodeMajor as number) < 20 || (nodeMajor as number) > 40) {
        throw new Error(`${label}.nodeMajors[${index}] must be between 20 and 40`)
      }
      return nodeMajor as number
    }).sort((left, right) => left - right)
    if (new Set(nodeMajors).size !== nodeMajors.length) throw new Error(`${label}.nodeMajors must be unique`)
  }
  let executionProfiles: DshAnalysisExecutionProfile[] | undefined
  if (item.executionProfiles !== undefined) {
    if (!Array.isArray(item.executionProfiles) || item.executionProfiles.length === 0
      || item.executionProfiles.length > PROFILE_ORDER.length) {
      throw new Error(`${label}.executionProfiles must contain between 1 and 5 profiles`)
    }
    executionProfiles = item.executionProfiles.map((profile, index) => {
      if (typeof profile !== 'string' || !PROFILE_ORDER.includes(profile as DshAnalysisExecutionProfile)) {
        throw new Error(`${label}.executionProfiles[${index}] must be headless, web, tui, sdk, or acp`)
      }
      return profile as DshAnalysisExecutionProfile
    }).sort((left, right) => PROFILE_ORDER.indexOf(left) - PROFILE_ORDER.indexOf(right))
    if (new Set(executionProfiles).size !== executionProfiles.length) {
      throw new Error(`${label}.executionProfiles must be unique`)
    }
  }
  return {
    fingerprint: item.fingerprint,
    ...(pluginVersion === undefined ? {} : { pluginVersion }),
    ...(nodeMajors === undefined ? {} : { nodeMajors }),
    ...(executionProfiles === undefined ? {} : { executionProfiles }),
  }
}
