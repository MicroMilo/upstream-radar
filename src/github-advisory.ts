import type {
  AdvisoryMatch,
  PackageCoordinate,
  RadarSeverity,
  VulnerabilityAdvisory,
} from './radar-types.js'
import { packageKey } from './osv.js'
import { satisfiesSemverRange } from './semver.js'
import { TOOL_VERSION } from './version.js'

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com/'
const GITHUB_API_VERSION = '2022-11-28'
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_PACKAGES = 10_000
const MAX_AFFECTS_PER_REQUEST = 100
const MAX_URL_LENGTH = 6_000
const MAX_PAGES_PER_QUERY = 20
const MAX_ADVISORIES = 10_000
const ADVISORY_TYPES = ['reviewed', 'unreviewed'] as const

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface GitHubAdvisoryClientOptions {
  /** GitHub API base URL; useful for GitHub Enterprise or a deterministic test server. */
  baseUrl?: string
  /** An optional token read from the caller's environment; never persisted by the client. */
  token?: string
  fetch?: FetchLike
  timeoutMs?: number
  /** Query unreviewed advisories in addition to GitHub-reviewed advisories. */
  includeUnreviewed?: boolean
}

interface GitHubAdvisoryVulnerability {
  packageName: string
  vulnerableRange?: string
  firstPatchedVersion?: string
}

interface GitHubAdvisoryRecord {
  id: string
  aliases: string[]
  summary: string
  details: string
  severity: RadarSeverity
  published?: string
  modified: string
  withdrawn?: string
  references: string[]
  vulnerabilities: GitHubAdvisoryVulnerability[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined
  return value
}

function normalizeBaseUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error('GitHub advisory base URL must use HTTPS')
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('GitHub advisory base URL must not contain credentials, a query string or a fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function severity(value: unknown): RadarSeverity {
  if (typeof value !== 'string') return 'unknown'
  switch (value.toLowerCase()) {
    case 'low': return 'low'
    case 'moderate':
    case 'medium': return 'medium'
    case 'high': return 'high'
    case 'critical': return 'critical'
    default: return 'unknown'
  }
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`GitHub advisories returned HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error('GitHub advisories response exceeds the byte limit')
  }
  if (response.body === null) throw new Error('GitHub advisories returned an empty response')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = Buffer.from(next.value)
    total += chunk.length
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel('GitHub advisories response exceeded byte limit')
      throw new Error('GitHub advisories response exceeds the byte limit')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    throw new Error('GitHub advisories returned invalid JSON')
  }
}

function nextLink(response: Response): string | undefined {
  const link = response.headers.get('link')
  if (link === null) return undefined
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link)
  return match?.[1]
}

function parsePatchedVersion(value: unknown): string | undefined {
  if (typeof value === 'string') return asString(value, 256)
  return asString(asRecord(value)?.identifier, 256)
}

function parseVulnerabilities(value: unknown): GitHubAdvisoryVulnerability[] {
  if (!Array.isArray(value)) throw new Error('GitHub advisory is missing its vulnerabilities list')
  return value.slice(0, MAX_ADVISORIES).flatMap((raw) => {
    const item = asRecord(raw)
    const packageName = asString(asRecord(item?.package)?.name, 512)
    if (packageName === undefined) return []
    const vulnerableRange = asString(item?.vulnerable_version_range, 2_048)
    const firstPatchedVersion = parsePatchedVersion(item?.first_patched_version)
    return [{
      packageName,
      ...(vulnerableRange === undefined ? {} : { vulnerableRange }),
      ...(firstPatchedVersion === undefined ? {} : { firstPatchedVersion }),
    }]
  })
}

function parseAdvisory(value: unknown): GitHubAdvisoryRecord {
  const root = asRecord(value)
  if (root === undefined) throw new Error('GitHub advisory is not an object')
  const id = asString(root.ghsa_id, 512)
  if (id === undefined || !/^GHSA-[A-Za-z0-9-]+$/.test(id)) throw new Error('GitHub advisory has an invalid ghsa_id')
  const summary = asString(root.summary, 8_192) ?? '(no summary supplied)'
  const details = asString(root.description, 64 * 1_024) ?? ''
  const published = asString(root.published_at, 256)
  const modified = asString(root.updated_at, 256) ?? published
  if (modified === undefined) throw new Error(`GitHub advisory ${id} is missing updated_at/published_at`)
  const withdrawn = root.withdrawn_at === null ? undefined : asString(root.withdrawn_at, 256)
  const aliases = new Set<string>()
  const cve = asString(root.cve_id, 256)
  if (cve !== undefined && cve !== id) aliases.add(cve)
  if (Array.isArray(root.identifiers)) {
    for (const rawIdentifier of root.identifiers) {
      const identifier = asString(asRecord(rawIdentifier)?.value, 256)
      if (identifier !== undefined && identifier !== id) aliases.add(identifier)
    }
  }
  const references = new Set<string>()
  const htmlUrl = safeUrl(root.html_url)
  if (htmlUrl !== undefined) references.add(htmlUrl)
  if (Array.isArray(root.references)) {
    for (const rawReference of root.references) {
      const reference = safeUrl(rawReference)
      if (reference !== undefined) references.add(reference)
    }
  }
  return {
    id,
    aliases: [...aliases].sort(),
    summary,
    details,
    severity: severity(root.severity),
    ...(published === undefined ? {} : { published }),
    modified,
    ...(withdrawn === undefined ? {} : { withdrawn }),
    references: [...references].slice(0, 100),
    vulnerabilities: parseVulnerabilities(root.vulnerabilities),
  }
}

function advisoryForPackage(
  advisory: GitHubAdvisoryRecord,
  coordinate: PackageCoordinate,
): VulnerabilityAdvisory | undefined {
  const vulnerabilities = advisory.vulnerabilities.filter(item => {
    if (item.packageName !== coordinate.name) return false
    if (item.vulnerableRange === undefined) return true
    return satisfiesSemverRange(coordinate.version, item.vulnerableRange) !== false
  })
  if (vulnerabilities.length === 0) return undefined
  return {
    id: advisory.id,
    aliases: [...advisory.aliases],
    summary: advisory.summary,
    details: advisory.details,
    severity: advisory.severity,
    ...(advisory.published === undefined ? {} : { published: advisory.published }),
    modified: advisory.modified,
    ...(advisory.withdrawn === undefined ? {} : { withdrawn: advisory.withdrawn }),
    fixedVersions: [...new Set(vulnerabilities
      .flatMap(item => item.firstPatchedVersion === undefined ? [] : [item.firstPatchedVersion]))].sort(),
    references: [...advisory.references],
  }
}

function packageChunks(packages: readonly PackageCoordinate[], baseUrl: string, type: string): PackageCoordinate[][] {
  const chunks: PackageCoordinate[][] = []
  let current: PackageCoordinate[] = []
  for (const item of packages) {
    const candidate = [...current, item]
    const url = new URL('advisories', baseUrl)
    url.searchParams.set('ecosystem', 'npm')
    url.searchParams.set('type', type)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('affects', candidate.map(packageKeyCoordinate).join(','))
    if (current.length > 0 && (candidate.length > MAX_AFFECTS_PER_REQUEST || url.toString().length > MAX_URL_LENGTH)) {
      chunks.push(current)
      current = [item]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function packageKeyCoordinate(item: PackageCoordinate): string {
  return `${item.name}@${item.version}`
}

function sameOrigin(value: string, baseUrl: string): boolean {
  try {
    return new URL(value).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

export class GitHubAdvisoryClient {
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly fetcher: FetchLike
  private readonly timeoutMs: number
  private readonly types: readonly string[]

  constructor(options: GitHubAdvisoryClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL)
    const token = options.token?.trim()
    this.token = token === undefined || token.length === 0 ? undefined : token
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error('GitHub advisory timeout must be between 1000 and 120000 milliseconds')
    }
    this.types = options.includeUnreviewed === false ? ['reviewed'] : [...ADVISORY_TYPES]
  }

  private async fetchPage(url: string): Promise<{ value: unknown; next?: string }> {
    const response = await this.fetcher(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `upstream-radar/${TOOL_VERSION}`,
        'x-github-api-version': GITHUB_API_VERSION,
        ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const value = await boundedJson(response)
    const next = nextLink(response)
    if (next !== undefined && !sameOrigin(next, this.baseUrl)) {
      throw new Error('GitHub advisory pagination escaped the configured API origin')
    }
    return { value, ...(next === undefined ? {} : { next }) }
  }

  private async fetchAdvisories(packages: readonly PackageCoordinate[], type: string): Promise<GitHubAdvisoryRecord[]> {
    const records: GitHubAdvisoryRecord[] = []
    for (const chunk of packageChunks(packages, this.baseUrl, type)) {
      const url = new URL('advisories', this.baseUrl)
      url.searchParams.set('ecosystem', 'npm')
      url.searchParams.set('type', type)
      url.searchParams.set('per_page', '100')
      url.searchParams.set('affects', chunk.map(packageKeyCoordinate).join(','))
      let next: string | undefined = url.toString()
      let pages = 0
      while (next !== undefined) {
        const page = await this.fetchPage(next)
        if (!Array.isArray(page.value)) throw new Error('GitHub advisory response is not an array')
        for (const raw of page.value) records.push(parseAdvisory(raw))
        next = page.next
        pages += 1
        if (pages >= MAX_PAGES_PER_QUERY && next !== undefined) {
          throw new Error('GitHub advisory pagination exceeds the page limit')
        }
      }
    }
    if (records.length > MAX_ADVISORIES) throw new Error(`GitHub advisory query exceeds the ${MAX_ADVISORIES} advisory limit`)
    return records
  }

  async query(input: readonly PackageCoordinate[]): Promise<Map<string, AdvisoryMatch[]>> {
    const unique = [...new Map(input.map(item => [packageKey(item), item])).values()]
    if (unique.length > MAX_PACKAGES) throw new Error(`GitHub advisory query exceeds the ${MAX_PACKAGES} package limit`)
    for (const item of unique) {
      if (item.ecosystem !== 'npm' || item.name.length === 0 || item.version.length === 0) {
        throw new Error('GitHub advisory queries require exact npm package names and versions')
      }
    }
    const records: GitHubAdvisoryRecord[] = []
    for (const type of this.types) records.push(...await this.fetchAdvisories(unique, type))
    const result = new Map<string, AdvisoryMatch[]>()
    for (const coordinate of unique) {
      const matches = new Map<string, AdvisoryMatch>()
      for (const advisory of records) {
        if (advisory.withdrawn !== undefined) continue
        const parsed = advisoryForPackage(advisory, coordinate)
        if (parsed === undefined) continue
        matches.set(parsed.id, { package: { ...coordinate }, advisory: parsed })
      }
      result.set(packageKey(coordinate), [...matches.values()].sort((left, right) => left.advisory.id.localeCompare(right.advisory.id)))
    }
    return result
  }
}
