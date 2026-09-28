import { createHash } from 'node:crypto'
import { parseDshAnalysisPolicy, type DshAnalysisExecutionProfile, type DshAnalysisPolicy } from './dsh-analysis-policy.js'
import { parseDshInstallTargets, type DshInstallTargets } from './dsh-install-plan.js'
import { parseObserverConfig, type ObserverConfig } from './upstream-observer.js'

export const DSH_ACTIVE_AGENT_POLICY_SCHEMA = 'upstream-radar.dsh-active-agent-policy/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SAFE_CHANNEL = /^[a-z][a-z0-9._-]{0,127}$/
const SAFE_TARGET = /^[a-z0-9][a-z0-9._-]{0,63}$/

interface DshActiveAgentEnvironmentOverride {
  nodeMajors?: number[]
  executionProfiles?: DshAnalysisExecutionProfile[]
}

interface DshActiveAgentPluginPolicy extends DshActiveAgentEnvironmentOverride {
  targetId: string
  version?: string
  sourceRef?: string
}

export interface DshActiveAgentPolicy {
  schema: typeof DSH_ACTIVE_AGENT_POLICY_SCHEMA
  dsh: { channel: string; version?: never; sourceRef?: never }
    | { version: string; sourceRef: string; channel?: never }
  defaults: DshActiveAgentEnvironmentOverride
  plugins: DshActiveAgentPluginPolicy[]
}

export interface CompiledDshActiveAgentPolicy {
  policy: DshActiveAgentPolicy
  fingerprint: string
  observerTargets: ObserverConfig
  installTargets: DshInstallTargets
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new Error(`${label} contains unsupported field ${unexpected}`)
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be bounded text`)
  return value
}

function environmentOverride(value: unknown, label: string): DshActiveAgentEnvironmentOverride {
  const item = value === undefined ? {} : record(value, label)
  keys(item, ['nodeMajors', 'executionProfiles'], label)
  const placeholder = parseDshAnalysisPolicy({
    fingerprint: `sha256:${'0'.repeat(64)}`,
    ...(item.nodeMajors === undefined ? {} : { nodeMajors: item.nodeMajors }),
    ...(item.executionProfiles === undefined ? {} : { executionProfiles: item.executionProfiles }),
  }, label)
  return {
    ...(placeholder.nodeMajors === undefined ? {} : { nodeMajors: placeholder.nodeMajors }),
    ...(placeholder.executionProfiles === undefined ? {} : { executionProfiles: placeholder.executionProfiles }),
  }
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function parseDshActiveAgentPolicy(value: unknown): DshActiveAgentPolicy {
  const root = record(value, 'active Agent policy')
  keys(root, ['schema', 'dsh', 'defaults', 'plugins'], 'active Agent policy')
  if (root.schema !== DSH_ACTIVE_AGENT_POLICY_SCHEMA) {
    throw new Error(`active Agent policy schema must be ${DSH_ACTIVE_AGENT_POLICY_SCHEMA}`)
  }
  const rawDsh = record(root.dsh, 'active Agent policy.dsh')
  keys(rawDsh, ['channel', 'version', 'sourceRef'], 'active Agent policy.dsh')
  const hasChannel = rawDsh.channel !== undefined
  const hasVersion = rawDsh.version !== undefined
  if (hasChannel === hasVersion) throw new Error('active Agent policy.dsh must set exactly one of channel or version')
  let dsh: DshActiveAgentPolicy['dsh']
  if (hasChannel) {
    const channel = boundedText(rawDsh.channel, 'active Agent policy.dsh.channel', 128)
    if (!SAFE_CHANNEL.test(channel)) throw new Error('active Agent policy.dsh.channel must be a lowercase npm dist-tag')
    if (rawDsh.sourceRef !== undefined) throw new Error('active Agent policy.dsh.sourceRef is only valid with an exact version')
    dsh = { channel }
  } else {
    const version = boundedText(rawDsh.version, 'active Agent policy.dsh.version', 128)
    if (!EXACT_VERSION.test(version)) throw new Error('active Agent policy.dsh.version must be exact')
    const sourceRef = boundedText(rawDsh.sourceRef, 'active Agent policy.dsh.sourceRef', 256)
    dsh = { version, sourceRef }
  }
  const defaults = environmentOverride(root.defaults, 'active Agent policy.defaults')
  if (root.plugins !== undefined && (!Array.isArray(root.plugins) || root.plugins.length > 100)) {
    throw new Error('active Agent policy.plugins must be an array of at most 100 entries')
  }
  const seen = new Set<string>()
  const plugins = ((root.plugins ?? []) as unknown[]).map((value, index): DshActiveAgentPluginPolicy => {
    const item = record(value, `active Agent policy.plugins[${index}]`)
    keys(item, ['targetId', 'version', 'sourceRef', 'nodeMajors', 'executionProfiles'], `active Agent policy.plugins[${index}]`)
    const targetId = boundedText(item.targetId, `active Agent policy.plugins[${index}].targetId`, 64)
    if (!SAFE_TARGET.test(targetId) || seen.has(targetId)) throw new Error('active Agent policy plugin targetIds must be unique lowercase labels')
    seen.add(targetId)
    const override = environmentOverride({ nodeMajors: item.nodeMajors, executionProfiles: item.executionProfiles },
      `active Agent policy.plugins[${index}]`)
    let version: string | undefined
    let sourceRef: string | undefined
    if (item.version !== undefined) {
      version = boundedText(item.version, `active Agent policy.plugins[${index}].version`, 128)
      if (!EXACT_VERSION.test(version)) throw new Error(`active Agent policy.plugins[${index}].version must be exact`)
      sourceRef = boundedText(item.sourceRef, `active Agent policy.plugins[${index}].sourceRef`, 256)
    } else if (item.sourceRef !== undefined) {
      throw new Error(`active Agent policy.plugins[${index}].sourceRef requires version`)
    }
    return { targetId, ...(version === undefined ? {} : { version, sourceRef: sourceRef! }), ...override }
  }).sort((left, right) => left.targetId.localeCompare(right.targetId))
  return { schema: DSH_ACTIVE_AGENT_POLICY_SCHEMA, dsh, defaults, plugins }
}

export function compileDshActiveAgentPolicy(policyInput: unknown, observerInput: unknown,
  installInput: unknown): CompiledDshActiveAgentPolicy {
  const policy = parseDshActiveAgentPolicy(policyInput)
  const observerTargets = structuredClone(parseObserverConfig(observerInput))
  const installTargets = structuredClone(parseDshInstallTargets(installInput))
  const dsh = observerTargets.targets.find(target => target.id === 'deepseek-harness')
  if (dsh === undefined || dsh.observeNpm === false) throw new Error('active Agent policy requires the npm-backed deepseek-harness observer target')
  const dshSelectionChanged = 'channel' in policy.dsh
    ? dsh.packageTag !== policy.dsh.channel || dsh.packageVersion !== undefined
    : dsh.packageVersion !== policy.dsh.version || dsh.ref !== policy.dsh.sourceRef
  if ('channel' in policy.dsh) {
    dsh.packageTag = policy.dsh.channel
    delete dsh.packageVersion
  } else {
    dsh.packageVersion = policy.dsh.version
    dsh.ref = policy.dsh.sourceRef
    delete dsh.packageTag
  }
  const pluginsById = new Map(policy.plugins.map(item => [item.targetId, item]))
  for (const configured of policy.plugins) {
    const install = installTargets.plugins.find(item => item.id === configured.targetId)
    if (install?.observerTargetId === undefined) throw new Error(`active Agent policy target ${configured.targetId} is not in the install cohort`)
    if (configured.version !== undefined) {
      const observed = observerTargets.targets.find(item => item.id === install.observerTargetId)
      if (observed === undefined || observed.observeNpm === false) {
        throw new Error(`active Agent policy target ${configured.targetId} has no npm-backed observer target`)
      }
      observed.packageVersion = configured.version
      observed.ref = configured.sourceRef!
      delete observed.packageTag
    }
  }
  for (const target of installTargets.plugins) {
    const configured = pluginsById.get(target.id)
    const nodeMajors = configured?.nodeMajors ?? policy.defaults.nodeMajors
    const executionProfiles = configured?.executionProfiles ?? policy.defaults.executionProfiles
    const effective = {
      ...(configured?.version === undefined ? {} : { pluginVersion: configured.version }),
      ...(nodeMajors === undefined ? {} : { nodeMajors }),
      ...(executionProfiles === undefined ? {} : { executionProfiles }),
    }
    const identity = { ...(dshSelectionChanged ? { dshSelection: policy.dsh } : {}), ...effective }
    if (Object.keys(identity).length === 0) {
      delete target.analysisPolicy
    } else {
      target.analysisPolicy = parseDshAnalysisPolicy({ fingerprint: fingerprint(identity), ...effective },
        `active Agent policy for ${target.id}`)
    }
  }
  return {
    policy,
    fingerprint: fingerprint(policy),
    observerTargets: parseObserverConfig(observerTargets),
    installTargets: parseDshInstallTargets(installTargets),
  }
}
