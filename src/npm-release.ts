import { parsePackageManifestSnapshot } from './inventory.js'
import { packageKey } from './osv.js'
import type { PackageCoordinate, PackageManifestSnapshot } from './radar-types.js'
import { TOOL_VERSION } from './version.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_PACKAGES = 10_000

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface NpmReleaseClientOptions {
  registry?: string
  fetch?: FetchLike
  timeoutMs?: number
}

export interface NpmReleaseObservation {
  installed: PackageCoordinate
  latestVersion: string
  previous: PackageManifestSnapshot
  candidate: PackageManifestSnapshot
  publishedAt?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function normalizeRegistry(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error('npm release registry must use HTTPS')
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('npm release registry must not contain credentials, a query string or a fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new Error('npm packument exceeds the byte limit')
  if (response.body === null) throw new Error('npm registry returned an empty packument')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = Buffer.from(next.value)
    total += chunk.length
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel('npm packument exceeded byte limit')
      throw new Error('npm packument exceeds the byte limit')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    throw new Error('npm registry returned invalid JSON')
  }
}

export class NpmReleaseClient {
  private readonly registry: string
  private readonly fetcher: FetchLike
  private readonly timeoutMs: number

  constructor(options: NpmReleaseClientOptions = {}) {
    this.registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error('npm release timeout must be between 1000 and 120000 milliseconds')
    }
  }

  private async fetchPackument(name: string): Promise<unknown> {
    const url = new URL(encodeURIComponent(name), this.registry)
    return boundedJson(await this.fetcher(url, {
      headers: {
        accept: 'application/vnd.npm.install-v1+json, application/json',
        'user-agent': `upstream-radar/${TOOL_VERSION}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    }))
  }

  async query(input: readonly PackageCoordinate[]): Promise<Map<string, NpmReleaseObservation>> {
    const unique = [...new Map(input.map(item => [packageKey(item), item])).values()]
    if (unique.length > MAX_PACKAGES) throw new Error(`npm release query exceeds the ${MAX_PACKAGES} package limit`)
    const byName = new Map<string, PackageCoordinate[]>()
    for (const item of unique) {
      if (item.ecosystem !== 'npm' || item.name.length === 0 || item.version.length === 0) {
        throw new Error('npm release queries require exact package names and versions')
      }
      const list = byName.get(item.name) ?? []
      list.push(item)
      byName.set(item.name, list)
    }

    const packuments = new Map<string, unknown>()
    const queue = [...byName.keys()]
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length > 0) {
        const name = queue.shift()
        if (name === undefined) return
        packuments.set(name, await this.fetchPackument(name))
      }
    })
    await Promise.all(workers)

    const result = new Map<string, NpmReleaseObservation>()
    for (const [name, coordinates] of byName) {
      const packument = asRecord(packuments.get(name))
      const tags = asRecord(packument?.['dist-tags'])
      const versions = asRecord(packument?.versions)
      const times = asRecord(packument?.time)
      const latestVersion = typeof tags?.latest === 'string' ? tags.latest : undefined
      if (latestVersion === undefined || versions === undefined) throw new Error(`npm packument has no latest release for ${name}`)
      const rawCandidate = versions[latestVersion]
      const candidate = parsePackageManifestSnapshot(rawCandidate)
      if (candidate.name !== name || candidate.version !== latestVersion) throw new Error(`npm latest manifest identity mismatch for ${name}`)
      for (const installed of coordinates) {
        const previous = parsePackageManifestSnapshot(versions[installed.version])
        if (previous.name !== name || previous.version !== installed.version) {
          throw new Error(`npm installed manifest identity mismatch for ${name}@${installed.version}`)
        }
        const publishedAt = typeof times?.[latestVersion] === 'string' ? times[latestVersion] : undefined
        result.set(packageKey(installed), {
          installed: { ...installed },
          latestVersion,
          previous,
          candidate,
          ...(publishedAt === undefined ? {} : { publishedAt }),
        })
      }
    }
    return result
  }
}
