import { packageKey } from './osv.js'
import type { NpmReleaseObservation } from './npm-release.js'
import { TOOL_VERSION } from './version.js'

const API_ORIGIN = 'https://api.github.com'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_RELEASE_NOTES = 64 * 1024
const MAX_PACKAGES = 1_000
const NOT_FOUND_CACHE_TTL_MS = 60 * 60 * 1_000

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ReleaseNotes {
  text: string
  url: string
}

export interface ReleaseNotesSource {
  query(observations: readonly NpmReleaseObservation[]): Promise<Map<string, ReleaseNotes>>
}

export interface GitHubReleaseClientOptions {
  fetch?: FetchLike
  timeoutMs?: number
}

interface GitHubRepository {
  owner: string
  name: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function parseGitHubRepository(value: string | undefined): GitHubRepository | undefined {
  if (value === undefined || value.length === 0 || value.length > 4_096) return undefined
  const candidate = value.startsWith('git+') ? value.slice(4) : value
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return undefined
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) return undefined
  const owner = segments[0]
  const name = segments[1]?.replace(/\.git$/, '')
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) return undefined
  return { owner, name }
}

function safeGitHubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
      || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('GitHub release returned an empty response')
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new Error('GitHub release exceeds the byte limit')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = Buffer.from(next.value)
    total += chunk.length
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel('GitHub release exceeded byte limit')
      throw new Error('GitHub release exceeds the byte limit')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    throw new Error('GitHub release returned invalid JSON')
  }
}

function truncate(value: string): string {
  return value.length <= MAX_RELEASE_NOTES ? value : `${value.slice(0, MAX_RELEASE_NOTES - 1)}…`
}

export class GitHubReleaseClient implements ReleaseNotesSource {
  private readonly fetcher: FetchLike
  private readonly timeoutMs: number
  private readonly releaseCache = new Map<string, ReleaseNotes>()
  private readonly missingReleaseCache = new Map<string, number>()

  constructor(options: GitHubReleaseClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error('GitHub release timeout must be between 1000 and 120000 milliseconds')
    }
  }

  private async fetchRelease(repository: GitHubRepository, version: string): Promise<ReleaseNotes | undefined> {
    const cacheKey = `${repository.owner}/${repository.name}\0${version}`
    const cached = this.releaseCache.get(cacheKey)
    if (cached !== undefined) return cached
    const missingUntil = this.missingReleaseCache.get(cacheKey)
    if (missingUntil !== undefined) {
      if (missingUntil > Date.now()) return undefined
      this.missingReleaseCache.delete(cacheKey)
    }
    const tags = [`v${version}`, version]
    for (const tag of tags) {
      const encodedTag = encodeURIComponent(tag)
      const url = `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases/tags/${encodedTag}`
      const response = await this.fetcher(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `upstream-radar/${TOOL_VERSION}`,
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.status === 404) continue
      if (!response.ok) throw new Error(`GitHub releases returned HTTP ${response.status}`)
      const payload = asRecord(await boundedJson(response))
      const body = typeof payload?.body === 'string' ? payload.body : ''
      if (body.trim().length === 0) {
        this.missingReleaseCache.set(cacheKey, Date.now() + NOT_FOUND_CACHE_TTL_MS)
        return undefined
      }
      const releaseUrl = safeGitHubUrl(payload?.html_url)
        ?? `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases/tag/${encodedTag}`
      const notes = { text: truncate(body), url: releaseUrl }
      this.releaseCache.set(cacheKey, notes)
      return notes
    }
    this.missingReleaseCache.set(cacheKey, Date.now() + NOT_FOUND_CACHE_TTL_MS)
    return undefined
  }

  async query(observations: readonly NpmReleaseObservation[]): Promise<Map<string, ReleaseNotes>> {
    const unique = new Map<string, { keys: string[]; repository: GitHubRepository; version: string }>()
    for (const observation of observations) {
      if (observation.candidate.version === observation.installed.version) continue
      const repository = parseGitHubRepository(observation.repository)
      if (repository === undefined) continue
      const key = `${repository.owner}/${repository.name}\0${observation.candidate.version}`
      const existing = unique.get(key)
      if (existing === undefined) {
        unique.set(key, {
          keys: [packageKey(observation.installed)],
          repository,
          version: observation.candidate.version,
        })
      } else if (!existing.keys.includes(packageKey(observation.installed))) {
        existing.keys.push(packageKey(observation.installed))
      }
    }
    if (unique.size > MAX_PACKAGES) throw new Error(`GitHub release query exceeds the ${MAX_PACKAGES} package limit`)

    const queue = [...unique.values()]
    const result = new Map<string, ReleaseNotes>()
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (item === undefined) return
        const notes = await this.fetchRelease(item.repository, item.version)
        if (notes !== undefined) {
          for (const key of item.keys) result.set(key, notes)
        }
      }
    })
    await Promise.all(workers)
    return result
  }
}
