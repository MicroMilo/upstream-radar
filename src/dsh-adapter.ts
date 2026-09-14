import { createHash } from 'node:crypto'
import { parseDshInstallTargets, type DshInstallTargets } from './dsh-install-plan.js'
import { parseDshCompatibilityLedger } from './dsh-compatibility-ledger.js'
import { parseDshProfileEnvironment, selectDshProfileEnvironment, type DshProfileEnvironment } from './dsh-profile-environment.js'
import { parseNpmSpec } from './npm.js'
import { dependencyGraphDigest } from './graph.js'
import type { InstalledProfileGraph } from './installed-graph.js'
import type { DependencyEdge, DependencyNode } from './radar-types.js'
import { DSH_ADAPTER_EXECUTION_CONTRACT, dshAdapterHasIndependentRuntimeEvidence, type DshAdapterObservationReport } from './dsh-adapter-observation.js'

const SCHEMA = 'upstream-radar.dsh-adapter-ledger/v1alpha1' as const
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
export interface DshAdapterExpectedCase {
  id: string; targetId: string; plugin: string; dshVersion: string; nodeMajor: number
  adapter: 'sdk' | 'acp'; profile: string; recipe: 'feishu-0.19.16-doctor-initialize'
  platform: 'linux'; architecture: 'arm64' | 'x64'; profileEnvironment: DshProfileEnvironment
  expectedArtifactSha256: string; sourceFingerprint: string; contractFingerprint: string
  versionRole: 'author-baseline' | 'target'; allowedBuilds: ''; reasons: string[]
}
export interface DshAdapterLedger {
  schema: typeof SCHEMA
  entries: Array<{ cell: DshAdapterExpectedCase; report: DshAdapterObservationReport }>
}
export const emptyDshAdapterLedger = (): DshAdapterLedger => ({ schema: SCHEMA, entries: [] })

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('adapter evidence must be an object')
  return value as Record<string, unknown>
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error('adapter evidence text is absent or exceeds its bound')
  return value
}
function hash(value: unknown, prefixed = false): string {
  const result = text(value, 71)
  if (!(prefixed ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(result)) throw new Error('adapter evidence requires an exact digest')
  return result
}
function timestamp(value: unknown): string {
  const result = text(value, 40)
  if (!Number.isFinite(Date.parse(result))) throw new Error('adapter evidence requires a valid timestamp')
  return result
}
function parseCell(input: unknown): DshAdapterExpectedCase {
  const cell = object(input)
  for (const key of ['id', 'targetId']) if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text(cell[key], 64))) throw new Error('invalid adapter case identity')
  if (cell.plugin !== 'dsh-feishu-bot@0.19.16' || cell.recipe !== 'feishu-0.19.16-doctor-initialize'
    || !['sdk', 'acp'].includes(String(cell.adapter)) || cell.profile !== `dsh-lark-${cell.adapter}`) throw new Error('unsupported exact adapter recipe')
  parseNpmSpec(`@deepseek-ai/dsh@${text(cell.dshVersion, 128)}`)
  if (!Number.isSafeInteger(cell.nodeMajor) || (cell.nodeMajor as number) < 22 || (cell.nodeMajor as number) > 40
    || cell.platform !== 'linux' || !['arm64', 'x64'].includes(String(cell.architecture))
    || !['target', 'author-baseline'].includes(String(cell.versionRole)) || cell.allowedBuilds !== '') throw new Error('unsupported adapter runtime or build authority')
  hash(cell.expectedArtifactSha256); hash(cell.sourceFingerprint, true); hash(cell.contractFingerprint, true)
  if (cell.profileEnvironment === undefined) throw new Error('adapter case lacks its explicit profile environment')
  parseDshProfileEnvironment(cell.profileEnvironment)
  if (!Array.isArray(cell.reasons) || cell.reasons.length > 16) throw new Error('invalid adapter planning reasons')
  cell.reasons.forEach(reason => text(reason))
  return structuredClone(cell) as unknown as DshAdapterExpectedCase
}

export const parseDshAdapterExpectedCase = parseCell

function parseProfileGraph(input: unknown): InstalledProfileGraph {
  const graph = object(input)
  if (graph.schema !== 'upstream-radar.installed-profile-graph/v1alpha1'
    || !Array.isArray(graph.roots) || graph.roots.length > 32 || !Array.isArray(graph.gaps) || graph.gaps.length > 32) throw new Error('invalid bounded adapter profile graph')
  text(graph.profilePath, 4096)
  const manifest = object(graph.manifest)
  hash(manifest.sha256)
  if (!Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) <= 0 || (manifest.bytes as number) > 256 * 1024) throw new Error('invalid adapter graph manifest identity')
  let nodes = 0, edges = 0
  const names = new Set<string>()
  for (const value of graph.roots) {
    const root = object(value), name = text(root.name, 256), version = text(root.version, 128)
    parseNpmSpec(`${name}@${version}`)
    if (names.has(name)) throw new Error('duplicate adapter graph root')
    names.add(name)
    text(root.requested, 4096)
    if (!['dependency', 'bundle'].includes(String(root.kind)) || !['satisfied', 'mismatched', 'indeterminate', 'linked'].includes(String(root.versionStatus))) throw new Error('invalid adapter root status')
    const tree = object(root.graph)
    if (tree.schema !== 'upstream-radar.dependency-graph/v1alpha1' || tree.source !== 'installed-node-modules'
      || !Array.isArray(tree.nodes) || !Array.isArray(tree.edges)) throw new Error('adapter dependency graph was not collected from the installed profile')
    nodes += tree.nodes.length; edges += tree.edges.length
    if (nodes > 10_000 || edges > 50_000) throw new Error('adapter dependency forest exceeds its bound')
    const ids = new Set<string>()
    for (const value of tree.nodes) {
      const node = object(value), id = text(node.id, 8192)
      if (ids.has(id)) throw new Error('duplicate adapter dependency node')
      ids.add(id)
      parseNpmSpec(`${text(node.name, 256)}@${text(node.version, 128)}`)
      if (node.source !== undefined && !['profile', 'dsh-host'].includes(String(node.source))) throw new Error('invalid adapter dependency provenance')
    }
    const kinds = ['runtime', 'development', 'optional', 'peer', 'host-runtime']
    for (const value of tree.edges) {
      const edge = object(value)
      if (!ids.has(text(edge.from, 8192)) || !ids.has(text(edge.to, 8192)) || !kinds.includes(String(edge.kind))) throw new Error('invalid adapter dependency edge')
    }
    if (!ids.has(text(tree.rootNodeId, 8192)) || !tree.nodes.some(value => {
      const node = object(value); return node.id === tree.rootNodeId && node.name === name && node.version === version
    })) throw new Error('adapter dependency root does not match its installed package')
    for (const [field, maximum] of [['unresolved', 50_000], ['rootPeerContracts', 1024]] as const) {
      if (tree[field] === undefined) continue
      if (!Array.isArray(tree[field]) || tree[field].length > maximum) throw new Error('adapter dependency gap evidence exceeds its bound')
      for (const value of tree[field]) {
        const fact = object(value)
        text(fact.name, 256)
        if (field === 'unresolved') {
          if (!ids.has(text(fact.from, 8192)) || !kinds.includes(String(fact.kind))) throw new Error('invalid unresolved adapter dependency')
          text(fact.spec, 4096)
        } else {
          text(fact.required, 4096)
          if (!['satisfied', 'mismatched', 'indeterminate', 'missing'].includes(String(fact.status))) throw new Error('invalid adapter peer contract')
          if (fact.resolvedVersion !== undefined) text(fact.resolvedVersion, 128)
        }
      }
    }
    if (hash(tree.digest, true) !== dependencyGraphDigest(tree.nodes as DependencyNode[], tree.edges as DependencyEdge[])) throw new Error('adapter dependency graph digest differs from its evidence')
  }
  for (const value of graph.gaps) { const gap = object(value); text(gap.name, 256); text(gap.reason, 1024) }
  const identity = { schema: graph.schema, profilePath: graph.profilePath, manifest: graph.manifest, roots: graph.roots, gaps: graph.gaps }
  if (hash(graph.digest, true) !== digest(identity)) throw new Error('adapter profile graph digest differs from its evidence')
  return structuredClone(graph) as unknown as InstalledProfileGraph
}

function parseReport(input: unknown, cell: DshAdapterExpectedCase): DshAdapterObservationReport {
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new Error('adapter report exceeds its byte bound')
  const report = object(input)
  if (report.schema !== 'upstream-radar.dsh-adapter-observation/v1alpha1' || report.executionContract !== DSH_ADAPTER_EXECUTION_CONTRACT) throw new Error('unsupported adapter observation contract')
  for (const field of ['plugin', 'dshVersion', 'adapter', 'profile', 'recipe'] as const) if (report[field] !== cell[field]) throw new Error(`adapter ${field} does not match the scheduled case`)
  const runtime = object(report.runtime)
  if (runtime.platform !== cell.platform || runtime.architecture !== cell.architecture
    || !/^\d+\.\d+\.\d+$/.test(text(runtime.nodeVersion, 64)) || Number((runtime.nodeVersion as string).split('.')[0]) !== cell.nodeMajor
    || runtime.pnpmVersion !== undefined && runtime.pnpmVersion !== cell.profileEnvironment.pnpmVersion) throw new Error('adapter runtime differs from the scheduled environment')
  if (report.profileEnvironment === undefined || JSON.stringify(parseDshProfileEnvironment(report.profileEnvironment)) !== JSON.stringify(cell.profileEnvironment)) throw new Error('adapter profile environment differs from the scheduled environment')
  const startedAt = timestamp(report.startedAt), completedAt = timestamp(report.completedAt)
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error('adapter timestamps are reversed')
  const stages = object(report.stages)
  for (const stage of ['runtime', 'artifact', 'install', 'initialize', 'profileGraph']) if (!['passed', 'failed', 'skipped'].includes(String(stages[stage]))) throw new Error('invalid adapter observation stage')
  if (report.artifact !== undefined) {
    const artifact = object(report.artifact)
    if (hash(artifact.sha256) !== cell.expectedArtifactSha256 || !Number.isSafeInteger(artifact.bytes)
      || (artifact.bytes as number) <= 0 || (artifact.bytes as number) > 128 * 1024 * 1024) throw new Error('adapter artifact does not match the exact scheduled bytes')
  } else if (stages.artifact === 'passed') throw new Error('adapter artifact stage lacks its byte identity')
  if (!Array.isArray(report.commands) || report.commands.length > 8) throw new Error('adapter commands exceed their evidence bound')
  for (const raw of report.commands) {
    const command = object(raw)
    if (!['runtime', 'artifact', 'install', 'load'].includes(String(command.phase))) throw new Error('invalid adapter command phase')
    text(command.command, 4096)
    if (!Array.isArray(command.args) || command.args.length > 64) throw new Error('invalid adapter command arguments')
    command.args.forEach(arg => text(arg, 4096))
    if (typeof command.stdout !== 'string' || typeof command.stderr !== 'string'
      || Buffer.byteLength(command.stdout) + Buffer.byteLength(command.stderr) > 64 * 1024
      || typeof command.timedOut !== 'boolean' || typeof command.outputExceeded !== 'boolean'
      || command.code !== null && !Number.isSafeInteger(command.code)) throw new Error('invalid bounded adapter command output')
    if (command.launchError !== undefined) text(command.launchError)
  }
  if (!Array.isArray(report.coverageGaps) || report.coverageGaps.length > 64) throw new Error('adapter coverage gaps exceed their bound')
  report.coverageGaps.forEach(gap => text(gap, 2048))
  text(report.reason, 2048)
  if (!Number.isSafeInteger(report.fixtureRequests) || (report.fixtureRequests as number) < 0 || (report.fixtureRequests as number) > 1_000_000) throw new Error('invalid adapter fixture request count')
  const boundary = object(report.boundary)
  if (boundary.lifecycleScripts !== 'disabled' || boundary.inheritedHostSecrets !== false) throw new Error('adapter execution boundary differs from the reviewed recipe')
  text(boundary.note, 2048)
  if (!['unknown', 'initialize-compatible', 'initialize-failed'].includes(String(report.result))) throw new Error('invalid adapter result')
  if (report.profileGraph !== undefined) parseProfileGraph(report.profileGraph)
  if (report.applicationGraph !== undefined) parseProfileGraph(report.applicationGraph)
  const result = structuredClone(report) as unknown as DshAdapterObservationReport
  if (result.result !== 'unknown') {
    const doctor = result.commands.find(command => command.phase === 'load')
    const commandOK = doctor && !doctor.timedOut && !doctor.outputExceeded && !doctor.launchError
    const observed = result.result === 'initialize-compatible'
      ? commandOK && doctor.code === 0 && new RegExp(`^adapter: ${cell.adapter}$`, 'm').test(doctor.stdout) && /^dsh: ok(?: |$)/m.test(doctor.stdout) && stages.initialize === 'passed'
      : commandOK && doctor.code === 1 && /^dsh: unavailable/m.test(doctor.stdout) && stages.initialize === 'failed'
    if (!observed || !dshAdapterHasIndependentRuntimeEvidence(result) || result.fixtureRequests !== 0
      || runtime.pnpmVersion !== cell.profileEnvironment.pnpmVersion
      || !['runtime', 'artifact', 'install', 'profileGraph'].every(stage => stages[stage] === 'passed')) throw new Error('adapter result lacks its independent initialization evidence')
  }
  return result
}

export function parseDshAdapterLedger(input: unknown = emptyDshAdapterLedger()): DshAdapterLedger {
  const ledger = object(input)
  if (ledger.schema !== SCHEMA || !Array.isArray(ledger.entries) || ledger.entries.length > 500) throw new Error('unsupported or oversized adapter ledger')
  const entries = ledger.entries.map(raw => {
    const entry = object(raw), cell = parseCell(entry.cell)
    return { cell, report: parseReport(entry.report, cell) }
  })
  if (new Set(entries.map(entry => entry.cell.id)).size !== entries.length) throw new Error('duplicate adapter ledger cell')
  return { schema: SCHEMA, entries }
}

export function mergeDshAdapterLedger(ledgerInput: unknown, expected: DshAdapterExpectedCase, reportInput: unknown) {
  const ledger = parseDshAdapterLedger(ledgerInput), cell = parseCell(expected), report = parseReport(reportInput, cell)
  const previous = ledger.entries.find(entry => entry.cell.id === cell.id)
  const unchanged = previous?.report.result === report.result && previous.cell.contractFingerprint === cell.contractFingerprint
    && previous.report.profileGraph?.digest === report.profileGraph?.digest && previous.report.applicationGraph?.digest === report.applicationGraph?.digest
    && previous.report.reason === report.reason
  return { ledger: { schema: SCHEMA, entries: [...ledger.entries.filter(entry => entry.cell.id !== cell.id), { cell, report }].sort((a, b) => a.cell.id.localeCompare(b.cell.id)) },
    transitions: unchanged ? [] : [{ caseId: cell.id, plane: cell.adapter, result: report.result, previousResult: previous?.report.result }] }
}

/** Author intent selects a reviewed, bounded recipe; repository commands never become executable instructions. */
export function buildDshAdapterPlan(targetsInput: DshInstallTargets, nativeInput: unknown, ledger = emptyDshAdapterLedger(), now = new Date()) {
  const targets = parseDshInstallTargets(targetsInput)
  const native = parseDshCompatibilityLedger(nativeInput)
  const selected = new Map<string, DshAdapterExpectedCase>()
  const blocked: Array<{ targetId: string; plugin: string; reason: string }> = []
  for (const target of targets.plugins) {
    const recommendation = target.environmentRecommendation
    const adapters = recommendation?.executionProfiles.filter(profile => profile === 'sdk' || profile === 'acp') ?? []
    if (adapters.length === 0) continue
    const sources = native.entries.filter(entry => entry.targetId === target.id && entry.runtime.platform === 'linux'
      && ['arm64', 'x64'].includes(entry.runtime.architecture) && recommendation?.nodeMajors.includes(entry.runtime.nodeMajor)
      && entry.artifact.sha256 && now.getTime() - Date.parse(entry.observedAt) < targets.refreshAfterHours * 3_600_000)
    if (sources.length === 0) blocked.push({ targetId: target.id, plugin: target.spec, reason: 'The intended adapter requires a current byte-bound artifact observation.' })
    for (const source of sources) {
      if (source.plugin !== 'dsh-feishu-bot@0.19.16') {
        blocked.push({ targetId: target.id, plugin: source.plugin, reason: 'No reviewed isolated adapter recipe covers this exact published plugin version.' }); continue
      }
      const author = recommendation?.authorEnvironment
      const versions = [...new Set([source.dshVersion, ...author?.dshVersions.map(item => item.version) ?? []])]
      for (const adapter of adapters) {
        if (!author?.workflows.some(item => item.kind === adapter)) {
          blocked.push({ targetId: target.id, plugin: source.plugin, reason: `The ${adapter} workflow lacks quoted author evidence.` }); continue
        }
        const profile = `dsh-lark-${adapter}`
        let profileEnvironment: DshProfileEnvironment
        try { profileEnvironment = selectDshProfileEnvironment(author, profile) }
        catch (error) { blocked.push({ targetId: target.id, plugin: source.plugin, reason: String(error).slice(0, 1024) }); continue }
        for (const dshVersion of versions) {
          const id = `${target.id.slice(0, 25)}-node${source.runtime.nodeMajor}-${adapter}-${createHash('sha256').update(dshVersion).digest('hex').slice(0, 12)}`
          const sourceFingerprint = digest({ plugin: source.plugin, artifact: source.artifact.sha256,
            static: source.staticFingerprint, author: recommendation?.sourceFingerprint })
          const coordinates = { plugin: source.plugin, dshVersion, nodeMajor: source.runtime.nodeMajor,
            adapter, profile, recipe: 'feishu-0.19.16-doctor-initialize' as const,
            platform: 'linux' as const, architecture: source.runtime.architecture as 'arm64' | 'x64',
            profileEnvironment, expectedArtifactSha256: source.artifact.sha256! }
          const contractFingerprint = digest({ ...coordinates, executionContract: DSH_ADAPTER_EXECUTION_CONTRACT })
          const previous = ledger.entries.find(entry => entry.cell.id === id)
          const staleHours = previous?.report.result === 'unknown' ? Math.min(24, targets.refreshAfterHours) : targets.refreshAfterHours
          if (previous && previous.cell.sourceFingerprint === sourceFingerprint && previous.cell.contractFingerprint === contractFingerprint
            && now.getTime() - Date.parse(previous.report.completedAt) < staleHours * 3_600_000) continue
          selected.set(id, { ...coordinates, id, targetId: target.id, sourceFingerprint, contractFingerprint,
            versionRole: dshVersion === source.dshVersion ? 'target' : 'author-baseline', allowedBuilds: '',
            reasons: [previous ? 'adapter-evidence-changed-or-expired' : 'missing-independent-adapter-evidence'] })
        }
      }
    }
  }
  if (selected.size > 500) throw new Error('adapter matrix exceeds 500 bounded cells')
  return { matrix: { include: [...selected.values()].sort((a, b) => a.id.localeCompare(b.id)) }, blocked }
}
