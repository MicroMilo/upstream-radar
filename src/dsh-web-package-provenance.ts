import { createHash } from 'node:crypto'
import { collectDshWebBootRoster, type DshWebBootRoster } from './dsh-web-contract.js'
import { parseDshClientContract } from './dsh-peer-planes.js'
import { parseSemver } from './semver.js'

export const DSH_WEB_PROVENANCE_LIMITS = { artifacts: 2048, manifestBytes: 1024 * 1024, clientBytes: 8 * 1024 * 1024,
  totalManifestBytes: 32 * 1024 * 1024, totalClientBytes: 64 * 1024 * 1024, gaps: 64, reportBytes: 2 * 1024 * 1024 } as const

export interface DshWebBundleCapture {
  id: string
  url: string
  status: number
  sha256?: string
  bytes?: number
  error?: string
}

export interface DshWebPackageInventory {
  artifacts: Array<{ location: string; manifest: Uint8Array; clientPath: string; client: Uint8Array }>
  gaps: string[]
}

export interface DshWebPackageMatch {
  location: string
  version: string
  manifestSha256: string
  clientPath: string
  clientSha256: string
  servedSha256: string
  transform: 'identity' | 'dsh-single-entry-combo/v1'
}

export interface DshWebPackageProvenance {
  revision: 'dsh-web-package-provenance/1'
  sha256: string
  bootSha256: string
  entries: Array<{ id: string; url: string; status: 'version-observed' | 'unresolved' | 'ambiguous' | 'scan-incomplete' | 'fetch-failed'; version?: string; capture?: DshWebBundleCapture; matches: DshWebPackageMatch[] }>
  gaps: string[]
}

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('provenance string bound exceeded')
  return value
}
function path(value: unknown): string {
  const result = text(value, 2048)
  if (result.includes('\\') || result.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('provenance path must stay within its inspected root')
  return result
}
function version(value: unknown): string {
  const result = text(value, 256)
  if (!/^\d/.test(result) || parseSemver(result) === undefined) throw new Error('package version is not exact')
  return result
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('provenance must be an object')
  return value as Record<string, unknown>
}

function resultEntry(row: DshWebBootRoster['entries'][number], capture: DshWebBundleCapture | undefined, matches: DshWebPackageMatch[], gaps: string[]): DshWebPackageProvenance['entries'][number] {
  const versions = new Set(matches.map(match => match.version))
  const fetched = capture?.status === 200 && capture.sha256 !== undefined && capture.error === undefined
  const status = !fetched ? 'fetch-failed' : gaps.length > 0 ? 'scan-incomplete' : versions.size > 1 ? 'ambiguous' : versions.size === 1 ? 'version-observed' : 'unresolved'
  const normalized = capture === undefined ? undefined : { id: capture.id, url: capture.url, status: capture.status,
    ...(capture.sha256 === undefined ? {} : { sha256: capture.sha256 }), ...(capture.bytes === undefined ? {} : { bytes: capture.bytes }),
    ...(capture.error === undefined ? {} : { error: capture.error }) }
  return { id: row.id, url: row.url, ...(normalized === undefined ? {} : { capture: normalized }), matches, status,
    ...(status === 'version-observed' ? { version: matches[0]!.version } : {}) }
}

function seal(boot: DshWebBootRoster, entries: DshWebPackageProvenance['entries'], gaps: string[]): DshWebPackageProvenance {
  const payload = { revision: 'dsh-web-package-provenance/1' as const, bootSha256: boot.sha256, entries, gaps }
  const bytes = Buffer.from(JSON.stringify(payload))
  if (bytes.length > DSH_WEB_PROVENANCE_LIMITS.reportBytes) throw new Error('provenance report byte bound exceeded')
  return { ...payload, sha256: hash(bytes) }
}

function validateCaptures(boot: DshWebBootRoster, captures: DshWebBundleCapture[]): void {
  if (!Array.isArray(captures) || captures.length > 512) throw new Error('capture entry bound exceeded')
  const ids = new Set<string>()
  let total = 0
  for (const capture of captures) {
    if (!boot.entries.some(row => row.id === capture.id && row.url === capture.url)) throw new Error('capture does not match the boot roster')
    if (ids.has(capture.id)) throw new Error('duplicate capture id')
    ids.add(capture.id)
    if (!Number.isInteger(capture.status) || capture.status < 0 || capture.status > 599) throw new Error('capture status is invalid')
    if ((capture.sha256 === undefined) !== (capture.bytes === undefined)) throw new Error('capture digest and bytes must occur together')
    if (capture.sha256 !== undefined && (!digest(capture.sha256) || capture.status !== 200)) throw new Error('capture digest or status is invalid')
    if (capture.bytes !== undefined) {
      total += capture.bytes
      if (!Number.isSafeInteger(capture.bytes) || capture.bytes < 1 || capture.bytes > DSH_WEB_PROVENANCE_LIMITS.clientBytes || total > DSH_WEB_PROVENANCE_LIMITS.totalClientBytes) throw new Error('capture byte bound exceeded')
    }
    if (capture.error !== undefined) text(capture.error, 512)
  }
}

/** Exact byte representation, not a normalization heuristic. Reviewed upstream:
 * deepseek-ai/deepseek-harness@c291e7961a515f6d7af9304e7fd1d257929aef26,
 * packages/client/modules/src/index.ts: comboSource, comboScript, buildCombo.
 */
function servedBytes(row: DshWebBootRoster['entries'][number], client: Uint8Array): { bytes: Uint8Array; transform: DshWebPackageMatch['transform'] } {
  const url = new URL(row.url, 'http://127.0.0.1/')
  if (`${url.pathname}${url.search}${url.hash}` !== `/plugins/??${row.id}/client.js&rev=${row.rev}`) return { bytes: client, transform: 'identity' }
  let source = Buffer.from(client).toString('utf8')
    .replace(/(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/, '')
    .replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '')
  if (!source.endsWith('\n')) source += '\n'
  return { bytes: Buffer.from(`${source};\n//# sourceMappingURL=/plugins/??${row.id}/client.js.map&rev=${row.rev}\n`), transform: 'dsh-single-entry-combo/v1' }
}

/** Bind independently fetched browser bytes to inspected manifest/client pairs. */
export function bindDshWebPackageVersions(boot: DshWebBootRoster, captures: DshWebBundleCapture[], inventory: DshWebPackageInventory): DshWebPackageProvenance {
  if (collectDshWebBootRoster(boot).sha256 !== boot.sha256) throw new Error('boot roster digest mismatch')
  validateCaptures(boot, captures)
  if (inventory.artifacts.length > DSH_WEB_PROVENANCE_LIMITS.artifacts || inventory.gaps.length > DSH_WEB_PROVENANCE_LIMITS.gaps) throw new Error('inventory entry bound exceeded')
  inventory.gaps.forEach(gap => text(gap, 512))
  let manifestBytes = 0
  let clientBytes = 0
  for (const artifact of inventory.artifacts) {
    path(artifact.location); path(artifact.clientPath)
    manifestBytes += artifact.manifest.length
    clientBytes += artifact.client.length
    if (artifact.manifest.length > DSH_WEB_PROVENANCE_LIMITS.manifestBytes || artifact.client.length > DSH_WEB_PROVENANCE_LIMITS.clientBytes
      || manifestBytes > DSH_WEB_PROVENANCE_LIMITS.totalManifestBytes || clientBytes > DSH_WEB_PROVENANCE_LIMITS.totalClientBytes) throw new Error('inventory byte bound exceeded')
  }
  const gaps = [...inventory.gaps]
  const artifacts = inventory.artifacts.flatMap(artifact => {
    try {
      const manifest = JSON.parse(Buffer.from(artifact.manifest).toString('utf8')) as Record<string, unknown>
      return [{ ...artifact, name: manifest.name, version: version(manifest.version), contract: parseDshClientContract(manifest) }]
    } catch {
      if (!gaps.includes('a package manifest could not be parsed')) {
        if (gaps.length === DSH_WEB_PROVENANCE_LIMITS.gaps) gaps.pop()
        gaps.push('a package manifest could not be parsed')
      }
      return []
    }
  })
  const entries: DshWebPackageProvenance['entries'] = boot.entries.map(row => {
    const capture = captures.find(item => item.id === row.id && item.url === row.url)
    const matches: DshWebPackageMatch[] = []
    for (const artifact of artifacts) {
      if (artifact.name !== row.id || typeof artifact.version !== 'string' || artifact.contract?.platform !== 'web' || !artifact.contract.entryPoints.includes(artifact.clientPath)) continue
      const served = servedBytes(row, artifact.client)
      const servedSha256 = hash(served.bytes)
      if (capture?.status !== 200 || capture.error !== undefined || capture.sha256 !== servedSha256 || capture.bytes !== served.bytes.length) continue
      matches.push({ location: artifact.location, version: artifact.version, manifestSha256: hash(artifact.manifest),
        clientPath: artifact.clientPath, clientSha256: hash(artifact.client), servedSha256, transform: served.transform })
    }
    return resultEntry(row, capture, matches, gaps)
  })
  return seal(boot, entries, gaps)
}

/** Persisted evidence cannot widen coverage, detach from its roster, or choose a different matching version. */
export function parseDshWebPackageProvenance(value: unknown, boot: DshWebBootRoster): DshWebPackageProvenance {
  if (collectDshWebBootRoster(boot).sha256 !== boot.sha256) throw new Error('boot roster digest mismatch')
  const wire = object(value)
  if (wire.revision !== 'dsh-web-package-provenance/1' || wire.bootSha256 !== boot.sha256) throw new Error('provenance revision or roster binding is invalid')
  if (!Array.isArray(wire.gaps) || wire.gaps.length > DSH_WEB_PROVENANCE_LIMITS.gaps) throw new Error('provenance gaps bound exceeded')
  const gaps = wire.gaps.map(gap => text(gap, 512))
  if (!Array.isArray(wire.entries) || wire.entries.length !== boot.entries.length) throw new Error('provenance must cover every roster row')
  let matchCount = 0
  const entries = wire.entries.map((value, index) => {
    const item = object(value)
    const row = boot.entries[index]!
    if (item.id !== row.id || item.url !== row.url) throw new Error('provenance row does not match the boot roster')
    let capture: DshWebBundleCapture | undefined
    if (item.capture !== undefined) {
      const raw = object(item.capture)
      capture = { id: raw.id as string, url: raw.url as string, status: raw.status as number,
        ...(raw.sha256 === undefined ? {} : { sha256: raw.sha256 as string }), ...(raw.bytes === undefined ? {} : { bytes: raw.bytes as number }),
        ...(raw.error === undefined ? {} : { error: text(raw.error, 512) }) }
      if (capture.id !== row.id || capture.url !== row.url) throw new Error('capture does not match its roster row')
    }
    if (!Array.isArray(item.matches) || (matchCount += item.matches.length) > DSH_WEB_PROVENANCE_LIMITS.artifacts) throw new Error('provenance match bound exceeded')
    const matches: DshWebPackageMatch[] = item.matches.map(value => {
      const match = object(value)
      for (const field of ['manifestSha256', 'clientSha256', 'servedSha256']) if (!digest(match[field])) throw new Error('provenance match digest is invalid')
      if (!['identity', 'dsh-single-entry-combo/v1'].includes(match.transform as string)) throw new Error('provenance transform is unsupported')
      if (capture?.error !== undefined || capture?.status !== 200 || capture.sha256 !== match.servedSha256) throw new Error('provenance match digest contradicts its fetch evidence')
      return { location: path(match.location), version: version(match.version), manifestSha256: match.manifestSha256 as string,
        clientPath: path(match.clientPath), clientSha256: match.clientSha256 as string, servedSha256: match.servedSha256 as string,
        transform: match.transform as DshWebPackageMatch['transform'] }
    })
    const result = resultEntry(row, capture, matches, gaps)
    if (item.status !== result.status || item.version !== result.version) throw new Error('provenance status or version contradicts its evidence')
    return result
  })
  validateCaptures(boot, entries.flatMap(entry => entry.capture === undefined ? [] : [entry.capture]))
  const result = seal(boot, entries, gaps)
  if (wire.sha256 !== result.sha256) throw new Error('provenance digest does not match its evidence')
  return result
}
