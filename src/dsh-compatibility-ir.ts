import { createHash } from 'node:crypto'
import { parseDshCompatibilityLedger, type DshCompatibilityLedger, type DshCompatibilityLedgerEntry, type DshCompatibilityPeerContractRelation } from './dsh-compatibility-ledger.js'
import { parseNpmSpec } from './npm.js'

/**
 * A normalized, durable view of the exact direct contracts between one plugin
 * artifact and the host packages a DSH runtime actually resolves for it.
 *
 * This intentionally is not a second copy of the full pnpm graph. The full
 * graph can be large and is already bound by its digest in the ledger. This
 * IR keeps the small compatibility frontier that answers a product question:
 * when host package X changes, which exact plugin contracts need retesting?
 */
export const DSH_COMPATIBILITY_IR_SCHEMA = 'upstream-radar.dsh-compatibility-ir/v1alpha1' as const
export const DSH_COMPATIBILITY_REVERSE_INDEX_SCHEMA = 'upstream-radar.dsh-compatibility-reverse-index/v1alpha1' as const

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_CELLS = 500
const MAX_RELATIONS_PER_CELL = 64
const MAX_RELATIONS = MAX_CELLS * MAX_RELATIONS_PER_CELL

export type DshCompatibilityPeerStatus = 'satisfied' | 'mismatched' | 'indeterminate' | 'missing'

export interface DshCompatibilityIrPlugin {
  name: string
  version: string
  /** Exact packed artifact when the isolated observation could bind one. */
  artifactSha256?: string
  /** Static identity evidence that scheduled this cell. */
  staticFingerprint: string
}

export interface DshCompatibilityIrRuntime {
  dshVersion: string
  nodeMajor: number
  nodeVersion: string
  platform: string
  architecture: string
  pnpmVersion?: string
  /** Controlled execution policy that produced the observation. */
  contractFingerprint: string
}

export interface DshCompatibilityIrCell {
  id: string
  caseId: string
  targetId: string
  observedAt: string
  result: DshCompatibilityLedgerEntry['result']
  plugin: DshCompatibilityIrPlugin
  runtime: DshCompatibilityIrRuntime
  evidence: {
    runtimeGraphDigest?: string
    runtimeGraphNodes?: number
    runtimeGraphEdges?: number
    requiredUnresolved?: number
    declaredPeerContracts?: number
    requiredDependencyBuilds?: string[]
  }
}

/** One measured direct plugin → DSH-host dependency edge. */
export interface DshCompatibilityIrRelation {
  id: string
  cellId: string
  dependency: {
    name: string
    required: string
    status: DshCompatibilityPeerStatus
    staticUsage: DshCompatibilityPeerContractRelation['staticUsage']
    /** Concrete version from `import.meta.resolve()` inside the DSH profile. */
    resolvedVersion?: string
  }
}

export interface DshCompatibilityIR {
  schema: typeof DSH_COMPATIBILITY_IR_SCHEMA
  cells: DshCompatibilityIrCell[]
  relations: DshCompatibilityIrRelation[]
}

export interface DshCompatibilityReverseImpact {
  relationId: string
  cellId: string
  caseId: string
  plugin: string
  dshVersion: string
  nodeMajor: number
  required: string
  status: DshCompatibilityPeerStatus
  staticUsage: DshCompatibilityPeerContractRelation['staticUsage']
  resolvedVersion?: string
}

export interface DshCompatibilityReverseDependency {
  name: string
  impacts: DshCompatibilityReverseImpact[]
}

/** Materialized upstream-package → exact downstream-plugin impact index. */
export interface DshCompatibilityReverseIndex {
  schema: typeof DSH_COMPATIBILITY_REVERSE_INDEX_SCHEMA
  dependencies: DshCompatibilityReverseDependency[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

function exactVersion(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 256)
  if (!EXACT_VERSION.test(parsed)) throw new Error(`${label} must be an exact semantic version`)
  return parsed
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded non-negative integer`)
  }
  return value as number
}

function peerStatus(value: unknown, label: string): DshCompatibilityPeerStatus {
  const status = boundedString(value, label, 32)
  if (status !== 'satisfied' && status !== 'mismatched' && status !== 'indeterminate' && status !== 'missing') {
    throw new Error(`${label} is unsupported`)
  }
  return status
}

function peerStaticUsage(value: unknown, label: string): DshCompatibilityPeerContractRelation['staticUsage'] {
  const usage = boundedString(value, label, 64)
  if (usage !== 'runtime-import-observed' && usage !== 'type-only-reference-observed'
    && usage !== 'no-literal-reference-observed' && usage !== 'scan-incomplete') {
    throw new Error(`${label} is unsupported`)
  }
  return usage
}

function result(value: unknown, label: string): DshCompatibilityLedgerEntry['result'] {
  const parsed = boundedString(value, label, 64)
  if (parsed !== 'compatible' && parsed !== 'runtime-incompatible' && parsed !== 'peer-contract-incompatible'
    && parsed !== 'build-approval-required' && parsed !== 'install-failed'
    && parsed !== 'load-failed' && parsed !== 'unknown') {
    throw new Error(`${label} is unsupported`)
  }
  return parsed
}

function packageName(value: unknown, label: string): string {
  const name = boundedString(value, label, 214)
  try {
    const parsed = parseNpmSpec(`${name}@0.0.0`)
    if (parsed.name !== name) throw new Error('canonical package name differs')
  } catch {
    throw new Error(`${label} must be an npm package name`)
  }
  return name
}

function exactPackage(value: unknown, label: string): { name: string, version: string } {
  const spec = boundedString(value, label, 512)
  const parsed = parseNpmSpec(spec)
  return { name: parsed.name, version: parsed.version }
}

function sha256(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  if (!SHA256.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`)
  return parsed
}

function stableId(prefix: string, value: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  return `${prefix}:${digest}`
}

function relationId(cellId: string, relation: DshCompatibilityPeerContractRelation): string {
  return stableId('relation', {
    cellId,
    name: relation.name,
    required: relation.required,
    status: relation.status,
    staticUsage: relation.staticUsage,
    ...(relation.resolvedVersion === undefined ? {} : { resolvedVersion: relation.resolvedVersion }),
  })
}

function cellId(entry: DshCompatibilityLedgerEntry): string {
  return stableId('cell', {
    caseId: entry.caseId,
    targetId: entry.targetId,
    plugin: entry.plugin,
    dshVersion: entry.dshVersion,
    nodeMajor: entry.runtime.nodeMajor,
    platform: entry.runtime.platform,
    architecture: entry.runtime.architecture,
    staticFingerprint: entry.staticFingerprint,
    contractFingerprint: entry.contractFingerprint,
    ...(entry.artifact.sha256 === undefined ? {} : { artifactSha256: entry.artifact.sha256 }),
  })
}

function sortRelations(left: DshCompatibilityIrRelation, right: DshCompatibilityIrRelation): number {
  return left.cellId.localeCompare(right.cellId)
    || left.dependency.name.localeCompare(right.dependency.name)
    || left.dependency.required.localeCompare(right.dependency.required)
    || left.id.localeCompare(right.id)
}

/**
 * Build the compatibility IR from already-validated durable evidence. It does
 * not fetch, install, or execute any target code.
 */
export function buildDshCompatibilityIR(ledgerInput: DshCompatibilityLedger | unknown): DshCompatibilityIR {
  const ledger = parseDshCompatibilityLedger(ledgerInput)
  const cells: DshCompatibilityIrCell[] = []
  const relations: DshCompatibilityIrRelation[] = []

  for (const entry of ledger.entries) {
    const plugin = parseNpmSpec(entry.plugin)
    const id = cellId(entry)
    const runtimeGraph = entry.resolution?.runtimeGraph
    const contracts = runtimeGraph?.pluginPeerContracts
    cells.push({
      id,
      caseId: entry.caseId,
      targetId: entry.targetId,
      observedAt: entry.observedAt,
      result: entry.result,
      plugin: {
        name: plugin.name,
        version: plugin.version,
        ...(entry.artifact.sha256 === undefined ? {} : { artifactSha256: entry.artifact.sha256 }),
        staticFingerprint: entry.staticFingerprint,
      },
      runtime: {
        dshVersion: entry.dshVersion,
        nodeMajor: entry.runtime.nodeMajor,
        nodeVersion: entry.runtime.nodeVersion,
        platform: entry.runtime.platform,
        architecture: entry.runtime.architecture,
        ...(entry.runtime.pnpmVersion === undefined ? {} : { pnpmVersion: entry.runtime.pnpmVersion }),
        contractFingerprint: entry.contractFingerprint,
      },
      evidence: {
        ...(runtimeGraph?.digest === undefined ? {} : { runtimeGraphDigest: runtimeGraph.digest }),
        ...(runtimeGraph?.nodes === undefined ? {} : { runtimeGraphNodes: runtimeGraph.nodes }),
        ...(runtimeGraph?.edges === undefined ? {} : { runtimeGraphEdges: runtimeGraph.edges }),
        ...(runtimeGraph?.unresolved === undefined ? {} : { requiredUnresolved: runtimeGraph.unresolved }),
        ...(contracts === undefined ? {} : { declaredPeerContracts: contracts.declared }),
        ...(entry.requiredDependencyBuilds === undefined ? {} : { requiredDependencyBuilds: entry.requiredDependencyBuilds }),
      },
    })
    for (const relation of contracts?.relations ?? []) {
      relations.push({
        id: relationId(id, relation),
        cellId: id,
        dependency: {
          name: relation.name,
          required: relation.required,
          status: relation.status,
          staticUsage: relation.staticUsage,
          ...(relation.resolvedVersion === undefined ? {} : { resolvedVersion: relation.resolvedVersion }),
        },
      })
    }
  }
  cells.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.id.localeCompare(right.id))
  relations.sort(sortRelations)
  return { schema: DSH_COMPATIBILITY_IR_SCHEMA, cells, relations }
}

/** Create the bounded reverse view used when a DSH host dependency changes. */
export function buildDshCompatibilityReverseIndex(irInput: DshCompatibilityIR | unknown): DshCompatibilityReverseIndex {
  const ir = parseDshCompatibilityIR(irInput)
  const cells = new Map(ir.cells.map(cell => [cell.id, cell]))
  const dependencies = new Map<string, DshCompatibilityReverseImpact[]>()
  for (const relation of ir.relations) {
    const cell = cells.get(relation.cellId)
    if (cell === undefined) throw new Error(`IR relation ${relation.id} refers to an unknown cell`)
    const impacts = dependencies.get(relation.dependency.name) ?? []
    impacts.push({
      relationId: relation.id,
      cellId: cell.id,
      caseId: cell.caseId,
      plugin: `${cell.plugin.name}@${cell.plugin.version}`,
      dshVersion: cell.runtime.dshVersion,
      nodeMajor: cell.runtime.nodeMajor,
      required: relation.dependency.required,
      status: relation.dependency.status,
      staticUsage: relation.dependency.staticUsage,
      ...(relation.dependency.resolvedVersion === undefined ? {} : { resolvedVersion: relation.dependency.resolvedVersion }),
    })
    dependencies.set(relation.dependency.name, impacts)
  }
  return {
    schema: DSH_COMPATIBILITY_REVERSE_INDEX_SCHEMA,
    dependencies: [...dependencies.entries()]
      .map(([name, impacts]) => ({
        name,
        impacts: impacts.sort((left, right) => left.plugin.localeCompare(right.plugin)
          || left.dshVersion.localeCompare(right.dshVersion)
          || left.nodeMajor - right.nodeMajor
          || left.caseId.localeCompare(right.caseId)
          || left.relationId.localeCompare(right.relationId)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

function parseCell(value: unknown, index: number): DshCompatibilityIrCell {
  const item = record(value, `cells[${index}]`)
  const plugin = record(item.plugin, `cells[${index}].plugin`)
  const runtime = record(item.runtime, `cells[${index}].runtime`)
  const evidence = record(item.evidence, `cells[${index}].evidence`)
  const parsedPlugin = exactPackage(`${boundedString(plugin.name, `cells[${index}].plugin.name`, 214)}@${exactVersion(plugin.version, `cells[${index}].plugin.version`)}`, `cells[${index}].plugin`)
  const artifactSha256 = plugin.artifactSha256 === undefined ? undefined : sha256(plugin.artifactSha256, `cells[${index}].plugin.artifactSha256`)
  const observedAt = boundedString(item.observedAt, `cells[${index}].observedAt`, 64)
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`cells[${index}].observedAt must be an ISO timestamp`)
  const nodeMajor = boundedInteger(runtime.nodeMajor, `cells[${index}].runtime.nodeMajor`, 40)
  if (nodeMajor < 16) throw new Error(`cells[${index}].runtime.nodeMajor must be a supported Node.js major version`)
  const pnpmVersion = runtime.pnpmVersion === undefined ? undefined : exactVersion(runtime.pnpmVersion, `cells[${index}].runtime.pnpmVersion`)
  const runtimeGraphDigest = evidence.runtimeGraphDigest === undefined ? undefined : boundedString(evidence.runtimeGraphDigest, `cells[${index}].evidence.runtimeGraphDigest`, 80)
  const runtimeGraphNodes = evidence.runtimeGraphNodes === undefined ? undefined : boundedInteger(evidence.runtimeGraphNodes, `cells[${index}].evidence.runtimeGraphNodes`, 100_000)
  const runtimeGraphEdges = evidence.runtimeGraphEdges === undefined ? undefined : boundedInteger(evidence.runtimeGraphEdges, `cells[${index}].evidence.runtimeGraphEdges`, 250_000)
  const requiredUnresolved = evidence.requiredUnresolved === undefined ? undefined : boundedInteger(evidence.requiredUnresolved, `cells[${index}].evidence.requiredUnresolved`, 250_000)
  const declaredPeerContracts = evidence.declaredPeerContracts === undefined ? undefined : boundedInteger(evidence.declaredPeerContracts, `cells[${index}].evidence.declaredPeerContracts`, MAX_RELATIONS_PER_CELL)
  let requiredDependencyBuilds: string[] | undefined
  if (evidence.requiredDependencyBuilds !== undefined) {
    if (!Array.isArray(evidence.requiredDependencyBuilds) || evidence.requiredDependencyBuilds.length === 0 || evidence.requiredDependencyBuilds.length > 16) {
      throw new Error(`cells[${index}].evidence.requiredDependencyBuilds must contain between one and 16 package names`)
    }
    requiredDependencyBuilds = evidence.requiredDependencyBuilds
      .map((name, dependencyIndex) => packageName(name, `cells[${index}].evidence.requiredDependencyBuilds[${dependencyIndex}]`))
      .sort()
    if (new Set(requiredDependencyBuilds).size !== requiredDependencyBuilds.length) {
      throw new Error(`cells[${index}].evidence.requiredDependencyBuilds must not contain duplicates`)
    }
  }
  const parsedResult = result(item.result, `cells[${index}].result`)
  if ((parsedResult === 'build-approval-required') !== (requiredDependencyBuilds !== undefined)) {
    throw new Error(`cells[${index}] must bind build-approval-required to requiredDependencyBuilds evidence`)
  }
  const cell: DshCompatibilityIrCell = {
    id: boundedString(item.id, `cells[${index}].id`, 80),
    caseId: boundedString(item.caseId, `cells[${index}].caseId`, 64),
    targetId: boundedString(item.targetId, `cells[${index}].targetId`, 64),
    observedAt,
    result: parsedResult,
    plugin: {
      name: parsedPlugin.name,
      version: parsedPlugin.version,
      ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
      staticFingerprint: boundedString(plugin.staticFingerprint, `cells[${index}].plugin.staticFingerprint`, 80),
    },
    runtime: {
      dshVersion: exactVersion(runtime.dshVersion, `cells[${index}].runtime.dshVersion`),
      nodeMajor,
      nodeVersion: exactVersion(runtime.nodeVersion, `cells[${index}].runtime.nodeVersion`),
      platform: boundedString(runtime.platform, `cells[${index}].runtime.platform`, 64),
      architecture: boundedString(runtime.architecture, `cells[${index}].runtime.architecture`, 64),
      ...(pnpmVersion === undefined ? {} : { pnpmVersion }),
      contractFingerprint: boundedString(runtime.contractFingerprint, `cells[${index}].runtime.contractFingerprint`, 80),
    },
    evidence: {
      ...(runtimeGraphDigest === undefined ? {} : { runtimeGraphDigest }),
      ...(runtimeGraphNodes === undefined ? {} : { runtimeGraphNodes }),
      ...(runtimeGraphEdges === undefined ? {} : { runtimeGraphEdges }),
      ...(requiredUnresolved === undefined ? {} : { requiredUnresolved }),
      ...(declaredPeerContracts === undefined ? {} : { declaredPeerContracts }),
      ...(requiredDependencyBuilds === undefined ? {} : { requiredDependencyBuilds }),
    },
  }
  return cell
}

function parseRelation(value: unknown, index: number): DshCompatibilityIrRelation {
  const item = record(value, `relations[${index}]`)
  const dependency = record(item.dependency, `relations[${index}].dependency`)
  const status = peerStatus(dependency.status, `relations[${index}].dependency.status`)
  const resolvedVersion = dependency.resolvedVersion === undefined
    ? undefined
    : exactVersion(dependency.resolvedVersion, `relations[${index}].dependency.resolvedVersion`)
  if ((status === 'satisfied' || status === 'mismatched') && resolvedVersion === undefined) {
    throw new Error(`relations[${index}].dependency requires a resolvedVersion for ${status}`)
  }
  if (status === 'missing' && resolvedVersion !== undefined) {
    throw new Error(`relations[${index}].dependency.resolvedVersion must be absent for a missing peer`)
  }
  return {
    id: boundedString(item.id, `relations[${index}].id`, 80),
    cellId: boundedString(item.cellId, `relations[${index}].cellId`, 80),
    dependency: {
      name: packageName(dependency.name, `relations[${index}].dependency.name`),
      required: boundedString(dependency.required, `relations[${index}].dependency.required`, 512),
      status,
      staticUsage: peerStaticUsage(dependency.staticUsage, `relations[${index}].dependency.staticUsage`),
      ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
    },
  }
}

/** Validate a persisted compatibility IR before using it for impact routing. */
export function parseDshCompatibilityIR(input: unknown): DshCompatibilityIR {
  const root = record(input, 'DSH compatibility IR')
  if (root.schema !== DSH_COMPATIBILITY_IR_SCHEMA) throw new Error(`DSH compatibility IR schema must be ${DSH_COMPATIBILITY_IR_SCHEMA}`)
  if (!Array.isArray(root.cells) || root.cells.length > MAX_CELLS) throw new Error(`DSH compatibility IR cells must contain at most ${MAX_CELLS} entries`)
  if (!Array.isArray(root.relations) || root.relations.length > MAX_RELATIONS) throw new Error(`DSH compatibility IR relations must contain at most ${MAX_RELATIONS} entries`)
  const cells = root.cells.map(parseCell)
  const cellIds = new Set<string>()
  for (const cell of cells) {
    if (cellIds.has(cell.id)) throw new Error(`DSH compatibility IR has a duplicate cell id: ${cell.id}`)
    cellIds.add(cell.id)
  }
  const relations = root.relations.map(parseRelation)
  const relationIds = new Set<string>()
  const relationCounts = new Map<string, number>()
  for (const relation of relations) {
    if (relationIds.has(relation.id)) throw new Error(`DSH compatibility IR has a duplicate relation id: ${relation.id}`)
    if (!cellIds.has(relation.cellId)) throw new Error(`DSH compatibility IR relation ${relation.id} references an unknown cell`)
    relationIds.add(relation.id)
    relationCounts.set(relation.cellId, (relationCounts.get(relation.cellId) ?? 0) + 1)
  }
  for (const cell of cells) {
    const count = relationCounts.get(cell.id) ?? 0
    if (count > MAX_RELATIONS_PER_CELL) throw new Error(`DSH compatibility IR cell ${cell.caseId} exceeds ${MAX_RELATIONS_PER_CELL} relations`)
    if (cell.evidence.declaredPeerContracts !== undefined && count !== cell.evidence.declaredPeerContracts) {
      throw new Error(`DSH compatibility IR cell ${cell.caseId} relation count does not match declared peer contracts`)
    }
  }
  cells.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.id.localeCompare(right.id))
  relations.sort(sortRelations)
  return { schema: DSH_COMPATIBILITY_IR_SCHEMA, cells, relations }
}

/** Validate the materialized reverse index before an observer consumes it. */
export function parseDshCompatibilityReverseIndex(input: unknown): DshCompatibilityReverseIndex {
  const root = record(input, 'DSH compatibility reverse index')
  if (root.schema !== DSH_COMPATIBILITY_REVERSE_INDEX_SCHEMA) {
    throw new Error(`DSH compatibility reverse index schema must be ${DSH_COMPATIBILITY_REVERSE_INDEX_SCHEMA}`)
  }
  if (!Array.isArray(root.dependencies) || root.dependencies.length > MAX_RELATIONS) {
    throw new Error(`DSH compatibility reverse index dependencies must contain at most ${MAX_RELATIONS} entries`)
  }
  const seenDependencies = new Set<string>()
  const dependencies = root.dependencies.map((value, index): DshCompatibilityReverseDependency => {
    const dependency = record(value, `dependencies[${index}]`)
    const name = packageName(dependency.name, `dependencies[${index}].name`)
    if (seenDependencies.has(name)) throw new Error(`DSH compatibility reverse index has duplicate dependency ${name}`)
    seenDependencies.add(name)
    if (!Array.isArray(dependency.impacts) || dependency.impacts.length === 0 || dependency.impacts.length > MAX_RELATIONS) {
      throw new Error(`dependencies[${index}].impacts must contain between 1 and ${MAX_RELATIONS} entries`)
    }
    const seenRelations = new Set<string>()
    const impacts = dependency.impacts.map((valueToParse, impactIndex): DshCompatibilityReverseImpact => {
      const impact = record(valueToParse, `dependencies[${index}].impacts[${impactIndex}]`)
      const relationId = boundedString(impact.relationId, `dependencies[${index}].impacts[${impactIndex}].relationId`, 80)
      if (seenRelations.has(relationId)) throw new Error(`dependencies[${index}].impacts has duplicate relation ${relationId}`)
      seenRelations.add(relationId)
      const resolvedVersion = impact.resolvedVersion === undefined
        ? undefined
        : exactVersion(impact.resolvedVersion, `dependencies[${index}].impacts[${impactIndex}].resolvedVersion`)
      const status = peerStatus(impact.status, `dependencies[${index}].impacts[${impactIndex}].status`)
      if ((status === 'satisfied' || status === 'mismatched') && resolvedVersion === undefined) {
        throw new Error(`dependencies[${index}].impacts[${impactIndex}] requires a resolvedVersion for ${status}`)
      }
      if (status === 'missing' && resolvedVersion !== undefined) {
        throw new Error(`dependencies[${index}].impacts[${impactIndex}].resolvedVersion must be absent for a missing peer`)
      }
      return {
        relationId,
        cellId: boundedString(impact.cellId, `dependencies[${index}].impacts[${impactIndex}].cellId`, 80),
        caseId: boundedString(impact.caseId, `dependencies[${index}].impacts[${impactIndex}].caseId`, 64),
        plugin: boundedString(impact.plugin, `dependencies[${index}].impacts[${impactIndex}].plugin`, 512),
        dshVersion: exactVersion(impact.dshVersion, `dependencies[${index}].impacts[${impactIndex}].dshVersion`),
        nodeMajor: boundedInteger(impact.nodeMajor, `dependencies[${index}].impacts[${impactIndex}].nodeMajor`, 40),
        required: boundedString(impact.required, `dependencies[${index}].impacts[${impactIndex}].required`, 512),
        status,
        staticUsage: peerStaticUsage(impact.staticUsage, `dependencies[${index}].impacts[${impactIndex}].staticUsage`),
        ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
      }
    })
    return { name, impacts: impacts.sort((left, right) => left.relationId.localeCompare(right.relationId)) }
  })
  dependencies.sort((left, right) => left.name.localeCompare(right.name))
  return { schema: DSH_COMPATIBILITY_REVERSE_INDEX_SCHEMA, dependencies }
}
