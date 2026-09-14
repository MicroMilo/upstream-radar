import { posix } from 'node:path'
import type { TarEntry } from './tar.js'

export type DshPeerStaticUsage = 'runtime-import-observed' | 'type-only-reference-observed'
  | 'no-literal-reference-observed' | 'scan-incomplete'

export interface DshClientContract {
  platform: string
  inject: string[]
  entryPoints: string[]
}

/** Syntactic observations only: absence of a literal is not proof of runtime absence. */
export interface DshPeerPlaneEvidence {
  /** Exact artifact declaration; omitted only in legacy evidence. */
  clientPlatform?: string
  host: DshPeerStaticUsage
  webClient: DshPeerStaticUsage
  unattributed: DshPeerStaticUsage
}

const MAX_SCAN_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_POINTS = 64
const MAX_LOCAL_IMPORTS = 512
const MAX_CLOSURE_FILES = 512
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
const USAGES = new Set<DshPeerStaticUsage>(['runtime-import-observed', 'type-only-reference-observed', 'no-literal-reference-observed', 'scan-incomplete'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function entryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[*\\\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('client entry path must be a bounded relative file path')
  }
  const path = value.replace(/^\.\//, '')
  if (path.startsWith('/') || path.split('/').some(part => part === '..' || part === '' || part === '.')) {
    throw new Error('client entry path must stay inside the artifact')
  }
  return path
}

function injectionNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('client.inject must contain at most 64 names')
  const names = value.map(name => {
    if (typeof name !== 'string' || name.length === 0 || name.length > 214 || !/^[A-Za-z@_][A-Za-z0-9@._/:-]*$/.test(name)) {
      throw new Error('client.inject contains an invalid name')
    }
    return name
  })
  if (new Set(names).size !== names.length) throw new Error('client.inject contains duplicate names')
  return names
}

/** Validate persisted metadata with the same bounds as exact tarball metadata. */
export function parseDshClientContractEvidence(value: unknown): DshClientContract | undefined {
  if (value === undefined) return undefined
  const item = object(value, 'client contract')
  if (typeof item.platform !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.platform)) throw new Error('client.platform is invalid')
  if (!Array.isArray(item.entryPoints) || item.entryPoints.length > MAX_ENTRY_POINTS) throw new Error('client.entryPoints exceeds the entry bound')
  const entryPoints = item.entryPoints.map(entryPath)
  if (new Set(entryPoints).size !== entryPoints.length) throw new Error('client.entryPoints contains duplicates')
  return { platform: item.platform, inject: injectionNames(item.inject), entryPoints }
}

function exportTargets(value: unknown, depth = 0): string[] {
  if (depth > 6) throw new Error('client export exceeds the nesting bound')
  if (typeof value === 'string') return [entryPath(value)]
  if (value === undefined || value === null) return []
  const children = Array.isArray(value) ? value : Object.entries(object(value, 'client export')).filter(([key]) => key !== 'types').map(([, child]) => child)
  if (children.length > MAX_ENTRY_POINTS) throw new Error('client export exceeds the entry bound')
  const targets = children.flatMap(child => exportTargets(child, depth + 1))
  if (targets.length > MAX_ENTRY_POINTS) throw new Error('client export exceeds the entry bound')
  return targets
}

/** Manifest declarations remain untrusted evidence, never an instruction to import a file. */
export function parseDshClientContract(manifest: Record<string, unknown>): DshClientContract | undefined {
  if (manifest.dsh === undefined) return undefined
  const dsh = object(manifest.dsh, 'dsh')
  if (dsh.client === undefined) return undefined
  const client = object(dsh.client, 'dsh.client')
  const exports = manifest.exports === undefined ? undefined : object(manifest.exports, 'client exports')
  return parseDshClientContractEvidence({ platform: client.platform, inject: client.inject ?? [],
    entryPoints: [...new Set(exportTargets(exports?.['./client']))] })
}

export function parseDshPeerPlaneEvidence(value: unknown): DshPeerPlaneEvidence | undefined {
  if (value === undefined) return undefined
  const item = object(value, 'peer usageByPlane')
  if (item.clientPlatform !== undefined && (typeof item.clientPlatform !== 'string'
    || !/^[a-z][a-z0-9-]{0,31}$/.test(item.clientPlatform))) throw new Error('peer client platform is invalid')
  for (const key of ['host', 'webClient', 'unattributed']) {
    if (!USAGES.has(item[key] as DshPeerStaticUsage)) throw new Error(`peer usageByPlane.${key} is unsupported`)
  }
  return { ...(item.clientPlatform === undefined ? {} : { clientPlatform: item.clientPlatform as string }),
    host: item.host as DshPeerStaticUsage, webClient: item.webClient as DshPeerStaticUsage, unattributed: item.unattributed as DshPeerStaticUsage }
}

function literalUsage(text: string, name: string, declaration: boolean): DshPeerStaticUsage {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const literal = `['"]${escaped}(?:/[^'"]*)?['"]`
  const typeOnly = new RegExp(`(?:^|[;\\n])[\\t ]*import[\\t ]+type\\b[^;\\n]{0,1024}?\\bfrom[\\t ]*${literal}`)
  const runtime = new RegExp([
    `(?:^|[;\\n])[\\t ]*import[\\t ]+(?!type\\b)(?:[^;\\n]{0,1024}?[\\t ]+from[\\t ]+)?${literal}`,
    `(?:^|[;\\n])[\\t ]*export[\\t ]+(?!type\\b)[^;\\n]{0,1024}?[\\t ]+from[\\t ]+${literal}`,
    `\\b(?:require|import)\\s*\\(\\s*${literal}`,
  ].join('|'))
  if (!declaration && runtime.test(text)) return 'runtime-import-observed'
  if (declaration ? new RegExp(literal).test(text) : typeOnly.test(text)) return 'type-only-reference-observed'
  return 'no-literal-reference-observed'
}

function combine(usages: DshPeerStaticUsage[], incomplete: boolean): DshPeerStaticUsage {
  if (usages.includes('runtime-import-observed')) return 'runtime-import-observed'
  if (incomplete) return 'scan-incomplete'
  if (usages.includes('type-only-reference-observed')) return 'type-only-reference-observed'
  return 'no-literal-reference-observed'
}

/** One byte budget shared by both planes. Links are never opened or followed. */
export function collectDshPeerPlaneEvidence(
  manifest: Record<string, unknown>, entries: readonly TarEntry[], requirements: readonly { name: string }[],
): DshPeerPlaneEvidence[] {
  const client = parseDshClientContract(manifest)
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const scans = new Map<string, { usages: DshPeerStaticUsage[], imports: string[], incomplete: boolean }>()
  let scannedBytes = 0
  for (const entry of entries) {
    if (!CODE_FILE.test(entry.path)) continue
    if (entry.type !== 'file' || entry.contents === undefined || scannedBytes + entry.contents.length > MAX_SCAN_BYTES) {
      scans.set(entry.path, { usages: [], imports: [], incomplete: true })
      continue
    }
    scannedBytes += entry.contents.length
    const text = entry.contents.toString('utf8')
    const imports: string[] = []
    const expression = /(?:\b(?:import|export)\s+(?!type\b)[^;\n]{0,1024}?\bfrom\s*|\bimport\s*|\b(?:require|import)\s*\(\s*)['"]([^'"\n]{1,1024})['"]/g
    let incomplete = /\b(?:require|import)\s*\(\s*[^\s'"]/.test(text)
    for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
      if (imports.length >= MAX_LOCAL_IMPORTS) { incomplete = true; break }
      if (match[1]?.startsWith('.')) imports.push(match[1])
    }
    scans.set(entry.path, { usages: requirements.map(item => literalUsage(text, item.name, /\.d\.(?:[cm]?ts)$/i.test(entry.path))), imports, incomplete })
  }
  const closure = (anchors: string[]): { files: Set<string>, incomplete: boolean } => {
    const files = new Set<string>()
    const queue = [...anchors]
    let incomplete = anchors.length === 0
    for (let index = 0; index < queue.length; index += 1) {
      const path = queue[index] as string
      if (files.has(path)) continue
      if (files.size >= MAX_CLOSURE_FILES) { incomplete = true; break }
      files.add(path)
      const entry = byPath.get(path)
      const scan = scans.get(path)
      if (entry?.type !== 'file' || scan === undefined) { incomplete = true; continue }
      incomplete ||= scan.incomplete
      for (const spec of scan.imports) {
        const target = posix.normalize(posix.join(posix.dirname(path), spec))
        if (target.startsWith('../') || target.startsWith('/')) { incomplete = true; continue }
        const candidate = [target, `${target}.js`, `${target}.ts`, `${target}/index.js`, `${target}/index.ts`].find(item => byPath.has(item))
        if (candidate === undefined) incomplete = true
        else queue.push(candidate)
      }
    }
    return { files, incomplete }
  }
  const exports = typeof manifest.exports === 'object' && manifest.exports !== null && !Array.isArray(manifest.exports)
    ? manifest.exports as Record<string, unknown> : {}
  const hostTargets = Object.entries(exports).filter(([key]) => key !== './client' && !key.startsWith('./client/') && key !== './package.json' && !key.includes('*'))
    .flatMap(([, value]) => exportTargets(value)).filter(path => CODE_FILE.test(path) && !path.includes('*'))
  if (typeof manifest.main === 'string') hostTargets.push(entryPath(manifest.main))
  const host = closure([...new Set(hostTargets)])
  const web = closure(client?.platform === 'web' ? client.entryPoints : [])
  const other = [...scans.keys()].filter(path => !host.files.has(path) && !web.files.has(path))
  return requirements.map((_, index) => ({
    ...(client === undefined ? {} : { clientPlatform: client.platform }),
    host: combine([...host.files].map(path => scans.get(path)?.usages[index] ?? 'no-literal-reference-observed'), host.incomplete),
    webClient: combine([...web.files].map(path => scans.get(path)?.usages[index] ?? 'no-literal-reference-observed'), web.incomplete),
    unattributed: combine(other.map(path => scans.get(path)?.usages[index] ?? 'no-literal-reference-observed'), other.some(path => scans.get(path)?.incomplete)),
  }))
}

export function isExclusiveDshWebPeer(relation: { usageByPlane?: DshPeerPlaneEvidence, declaredClientInject?: boolean }): boolean {
  const usage = relation.usageByPlane
  return usage !== undefined
    && usage.clientPlatform === 'web'
    && (usage.host === 'no-literal-reference-observed' || usage.host === 'type-only-reference-observed')
    && (usage.unattributed === 'no-literal-reference-observed' || usage.unattributed === 'type-only-reference-observed')
    && (usage.webClient === 'runtime-import-observed' || usage.webClient === 'type-only-reference-observed' || relation.declaredClientInject === true)
}

/** Raw Node statuses are retained. This only decides what those facts justify. */
export function evaluateDshPeerContractCoverage(graph: { unresolved: number, pluginPeerContracts: {
  declared: number, satisfied: number, mismatched: number, indeterminate: number, missing: number,
  relations: Array<{ name: string, required: string, status: string, staticUsage: DshPeerStaticUsage,
    resolvedVersion?: string, usageByPlane?: DshPeerPlaneEvidence, declaredClientInject?: boolean }>,
} }): { result: 'compatible' | 'peer-contract-incompatible' | 'unknown', reason: string } {
  const contracts = graph.pluginPeerContracts
  const mismatch = contracts.relations.find(item => item.status === 'mismatched' && !isExclusiveDshWebPeer(item))
  if (mismatch !== undefined) return { result: 'peer-contract-incompatible',
    reason: `the exact artifact installed and loaded, but ${mismatch.name}@${mismatch.resolvedVersion} does not satisfy ${mismatch.required}; a declared-support fact, not proof of a runtime crash` }
  if (contracts.missing > 0 || contracts.indeterminate > 0 || contracts.mismatched > 0 || graph.unresolved > 0) {
    return { result: 'unknown', reason: `the exact artifact installed and loaded, but dependency coverage is incomplete (${contracts.missing} missing Node peers, ${contracts.indeterminate} indeterminate peers, ${contracts.mismatched} version facts, ${graph.unresolved} unresolved edges); this is not a demonstrated runtime failure` }
  }
  return { result: 'compatible', reason: 'the exact artifact installed, registered, loaded, and satisfied its direct Node peer contracts; client-plane compatibility requires its own profile evidence' }
}
