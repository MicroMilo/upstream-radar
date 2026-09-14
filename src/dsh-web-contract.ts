import { createHash } from 'node:crypto'
import { parseDshClientContractEvidence, type DshClientContract } from './dsh-peer-planes.js'
import { parseDshWebPackageProvenance, type DshWebPackageProvenance } from './dsh-web-package-provenance.js'

export interface DshWebBootRoster {
  sha256: string
  entries: Array<{ id: string; url: string; rev: string; inject: string[]; external: string[] }>
}

export interface DshWebContractEvidence {
  revision: 'dsh-web-client-contract/1' | 'dsh-web-client-contract/2'
  client?: DshClientContract
  boot?: DshWebBootRoster
  pluginBundle?: { sha256: string; bytes: number }
  /** DSH's boot revisions are opaque artifact revisions, not npm versions. */
  peerVersions: 'not-observed' | 'partial'
  /** Independently matched package rows; bundled/static aliases remain outside this evidence. */
  packageVersions?: DshWebPackageProvenance
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function requests(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} exceeds the roster edge bound`)
  const result = value.map(item => string(item, label, 512))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`)
  return result
}

/** A complete bounded projection of actual browser rows, independent of Node resolution. */
export function collectDshWebBootRoster(value: unknown): DshWebBootRoster {
  const wire = object(value, 'boot roster')
  if (!Array.isArray(wire.entries) || wire.entries.length === 0 || wire.entries.length > 512) throw new Error('boot roster exceeds its entry bound or is missing')
  const entries = wire.entries.map(value => {
    const entry = object(value, 'boot entry')
    const url = string(entry.url, 'boot entry url', 2048)
    const parsed = new URL(url, 'http://127.0.0.1/')
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.username !== '' || parsed.password !== '') throw new Error('boot entry must use a credential-free loopback URL')
    return { id: string(entry.id, 'boot entry id', 214), url, rev: string(entry.rev, 'boot entry revision', 256),
      inject: requests(entry.inject, 'boot inject'), external: requests(entry.external, 'boot external') }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('boot roster contains duplicate entry ids')
  const bytes = Buffer.from(JSON.stringify(entries))
  if (bytes.length > 256 * 1024) throw new Error('boot roster exceeds its byte bound')
  return { sha256: createHash('sha256').update(bytes).digest('hex'), entries }
}

export function parseDshWebContractEvidence(value: unknown): DshWebContractEvidence | undefined {
  if (value === undefined) return undefined
  const item = object(value, 'Web client contract')
  if (!['dsh-web-client-contract/1', 'dsh-web-client-contract/2'].includes(item.revision as string)
    || (item.revision === 'dsh-web-client-contract/1' && item.packageVersions !== undefined)) throw new Error('Web client contract revision is unsupported')
  const client = parseDshClientContractEvidence(item.client)
  const boot = item.boot === undefined ? undefined : collectDshWebBootRoster(item.boot)
  if (boot !== undefined && object(item.boot, 'boot roster').sha256 !== boot.sha256) throw new Error('boot roster digest does not match its rows')
  if (item.packageVersions !== undefined && boot === undefined) throw new Error('browser package versions require an independent boot roster')
  const packageVersions = item.packageVersions === undefined ? undefined : parseDshWebPackageProvenance(item.packageVersions, boot!)
  const peerVersions = packageVersions?.entries.some(entry => entry.status === 'version-observed') ? 'partial' : 'not-observed'
  if (item.peerVersions !== peerVersions) throw new Error('Web peer coverage contradicts its package evidence')
  let pluginBundle: DshWebContractEvidence['pluginBundle']
  if (item.pluginBundle !== undefined) {
    const bundle = object(item.pluginBundle, 'plugin bundle')
    if (typeof bundle.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.sha256)
      || !Number.isSafeInteger(bundle.bytes) || (bundle.bytes as number) < 1 || (bundle.bytes as number) > 8 * 1024 * 1024) throw new Error('plugin bundle digest or bytes is invalid')
    pluginBundle = { sha256: bundle.sha256, bytes: bundle.bytes as number }
  }
  return { revision: item.revision as DshWebContractEvidence['revision'], peerVersions,
    ...(packageVersions === undefined ? {} : { packageVersions }),
    ...(client === undefined ? {} : { client }), ...(boot === undefined ? {} : { boot }),
    ...(pluginBundle === undefined ? {} : { pluginBundle }) }
}
