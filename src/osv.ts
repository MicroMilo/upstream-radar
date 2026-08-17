import type {
  AdvisoryMatch,
  PackageCoordinate,
  RadarSeverity,
  VulnerabilityAdvisory,
} from './radar-types.js'
import { TOOL_VERSION } from './version.js'

const DEFAULT_OSV_BASE_URL = 'https://api.osv.dev/'
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_BATCH_SIZE = 1_000
const MAX_PACKAGES = 50_000
const MAX_ADVISORIES = 5_000

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface OsvClientOptions {
  baseUrl?: string
  fetch?: FetchLike
  timeoutMs?: number
}

interface OsvStub {
  id: string
  modified: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function strings(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, limit)
}

function normalizeBaseUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error('OSV base URL must use HTTPS')
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('OSV base URL must not contain credentials, a query string or a fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function severity(value: unknown): RadarSeverity {
  if (typeof value !== 'string') return 'unknown'
  switch (value.toLowerCase()) {
    case 'info': return 'info'
    case 'low': return 'low'
    case 'moderate':
    case 'medium': return 'medium'
    case 'high': return 'high'
    case 'critical': return 'critical'
    default: return 'unknown'
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`OSV returned HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new Error('OSV response exceeds the byte limit')
  if (response.body === null) throw new Error('OSV returned an empty response')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = Buffer.from(next.value)
    total += chunk.length
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel('OSV response exceeded byte limit')
      throw new Error('OSV response exceeds the byte limit')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    throw new Error('OSV returned invalid JSON')
  }
}

function parseStubs(value: unknown, expected: number): OsvStub[][] {
  const root = asRecord(value)
  if (!Array.isArray(root?.results) || root.results.length !== expected) {
    throw new Error('OSV batch response does not align with the submitted package versions')
  }
  return root.results.map((rawResult) => {
    const result = asRecord(rawResult)
    if (!Array.isArray(result?.vulns)) return []
    return result.vulns.slice(0, MAX_ADVISORIES).flatMap((rawVulnerability) => {
      const vulnerability = asRecord(rawVulnerability)
      const id = typeof vulnerability?.id === 'string' ? vulnerability.id : undefined
      const modified = typeof vulnerability?.modified === 'string' ? vulnerability.modified : undefined
      return id === undefined || modified === undefined ? [] : [{ id, modified }]
    })
  })
}

function parseAdvisory(value: unknown, packageName: string): VulnerabilityAdvisory {
  const root = asRecord(value)
  if (root === undefined) throw new Error('OSV advisory is not an object')
  const id = typeof root?.id === 'string' ? root.id : undefined
  const modified = typeof root?.modified === 'string' ? root.modified : undefined
  if (id === undefined || modified === undefined) throw new Error('OSV advisory is missing id or modified time')

  let rawSeverity = asRecord(root.database_specific)?.severity
  const fixedVersions = new Set<string>()
  if (Array.isArray(root.affected)) {
    for (const rawAffected of root.affected) {
      const affected = asRecord(rawAffected)
      const affectedPackage = asRecord(affected?.package)
      if (affectedPackage?.ecosystem !== 'npm' || affectedPackage.name !== packageName) continue
      rawSeverity ??= asRecord(affected?.ecosystem_specific)?.severity
      if (!Array.isArray(affected?.ranges)) continue
      for (const rawRange of affected.ranges) {
        const range = asRecord(rawRange)
        if (!Array.isArray(range?.events)) continue
        for (const rawEvent of range.events) {
          const event = asRecord(rawEvent)
          if (typeof event?.fixed === 'string') fixedVersions.add(event.fixed)
        }
      }
    }
  }

  const references = Array.isArray(root.references)
    ? root.references.flatMap((rawReference) => {
        const reference = asRecord(rawReference)
        if (typeof reference?.url !== 'string') return []
        try {
          const url = new URL(reference.url)
          return url.protocol === 'https:' || url.protocol === 'http:' ? [url.toString()] : []
        } catch {
          return []
        }
      }).slice(0, 100)
    : []
  const published = typeof root.published === 'string' ? root.published : undefined
  const withdrawn = typeof root.withdrawn === 'string' ? root.withdrawn : undefined

  return {
    id,
    aliases: strings(root.aliases),
    summary: typeof root.summary === 'string' ? root.summary.slice(0, 8_192) : '(no summary supplied)',
    details: typeof root.details === 'string' ? root.details.slice(0, 64 * 1_024) : '',
    severity: id.startsWith('MAL-') ? 'critical' : severity(rawSeverity),
    ...(published === undefined ? {} : { published }),
    modified,
    ...(withdrawn === undefined ? {} : { withdrawn }),
    fixedVersions: [...fixedVersions].sort(),
    references,
    sources: ['osv'],
  }
}

export function packageKey(value: PackageCoordinate): string {
  return `${value.ecosystem}:${value.name}@${value.version}`
}

export class OsvClient {
  private readonly baseUrl: string
  private readonly fetcher: FetchLike
  private readonly timeoutMs: number

  constructor(options: OsvClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OSV_BASE_URL)
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error('OSV timeout must be between 1000 and 120000 milliseconds')
    }
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    return boundedJson(await this.fetcher(url, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': `upstream-radar/${TOOL_VERSION}`,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    }))
  }

  async query(input: readonly PackageCoordinate[]): Promise<Map<string, AdvisoryMatch[]>> {
    const unique = [...new Map(input.map(item => [packageKey(item), item])).values()]
    if (unique.length > MAX_PACKAGES) throw new Error(`OSV query exceeds the ${MAX_PACKAGES} package limit`)
    for (const item of unique) {
      if (item.ecosystem !== 'npm' || item.name.length === 0 || item.version.length === 0) {
        throw new Error('OSV queries require an exact npm package name and version')
      }
    }

    const stubsByPackage = new Map<string, OsvStub[]>()
    for (let offset = 0; offset < unique.length; offset += MAX_BATCH_SIZE) {
      const chunk = unique.slice(offset, offset + MAX_BATCH_SIZE)
      const response = await this.fetchJson('v1/querybatch', {
        method: 'POST',
        body: JSON.stringify({
          queries: chunk.map(item => ({
            package: { ecosystem: item.ecosystem, name: item.name },
            version: item.version,
          })),
        }),
      })
      const parsed = parseStubs(response, chunk.length)
      for (let index = 0; index < chunk.length; index += 1) {
        const coordinate = chunk[index]
        if (coordinate !== undefined) stubsByPackage.set(packageKey(coordinate), parsed[index] ?? [])
      }
    }

    const requested = new Map<string, string>()
    for (const coordinate of unique) {
      for (const stub of stubsByPackage.get(packageKey(coordinate)) ?? []) {
        if (!/^[A-Za-z0-9._-]{1,256}$/.test(stub.id)) throw new Error('OSV returned an invalid advisory id')
        requested.set(stub.id, coordinate.name)
      }
    }
    if (requested.size > MAX_ADVISORIES) throw new Error(`OSV query exceeds the ${MAX_ADVISORIES} advisory limit`)

    const details = new Map<string, VulnerabilityAdvisory>()
    const queue = [...requested.entries()]
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) return
        const [id, packageName] = next
        const advisory = parseAdvisory(await this.fetchJson(`v1/vulns/${encodeURIComponent(id)}`), packageName)
        details.set(id, advisory)
      }
    })
    await Promise.all(workers)

    const result = new Map<string, AdvisoryMatch[]>()
    for (const coordinate of unique) {
      const matches = (stubsByPackage.get(packageKey(coordinate)) ?? []).flatMap((stub) => {
        const advisory = details.get(stub.id)
        return advisory === undefined || advisory.withdrawn !== undefined ? [] : [{ package: coordinate, advisory }]
      })
      result.set(packageKey(coordinate), matches)
    }
    return result
  }
}
