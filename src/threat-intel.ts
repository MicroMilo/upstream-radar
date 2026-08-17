import type {
  AdvisoryRiskSignals,
  EpssSignal,
  CisaKevSignal,
  ThreatIntelSourceName,
  VulnerabilityAdvisory,
} from './radar-types.js'

const DEFAULT_CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
const DEFAULT_EPSS_URL = 'https://api.first.org/data/v1/epss'
const CISA_KEV_REFERENCE = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog'
const EPSS_REFERENCE = 'https://www.first.org/epss/'
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_CVE_IDS = 20_000
const MAX_EPSS_QUERY_BYTES = 1_800

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ThreatIntelSource {
  query(advisories: readonly VulnerabilityAdvisory[]): Promise<Map<string, AdvisoryRiskSignals>>
}

export interface ThreatIntelSourceBinding {
  name: ThreatIntelSourceName
  source: ThreatIntelSource
}

export interface CisaKevClientOptions {
  url?: string
  fetch?: FetchLike
  timeoutMs?: number
}

export interface EpssClientOptions {
  url?: string
  fetch?: FetchLike
  timeoutMs?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function boundedString(value: unknown, maxLength = 8_192): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined
}

function cveIds(advisory: VulnerabilityAdvisory): string[] {
  return [...new Set([advisory.id, ...advisory.aliases]
    .filter(value => /^CVE-\d{4}-\d{4,}$/iu.test(value))
    .map(value => value.toUpperCase()))]
}

function uniqueCveIds(advisories: readonly VulnerabilityAdvisory[]): string[] {
  const ids = [...new Set(advisories.flatMap(cveIds))]
  if (ids.length > MAX_CVE_IDS) throw new Error(`threat-intel query exceeds the ${MAX_CVE_IDS} CVE limit`)
  return ids
}

function emptyResults(advisories: readonly VulnerabilityAdvisory[]): Map<string, AdvisoryRiskSignals> {
  return new Map(advisories.map(advisory => [advisory.id, {}]))
}

function normalizeHttpsUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`)
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error(`${label} must not contain credentials or a fragment`)
  }
  return url.toString()
}

async function boundedJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds the byte limit`)
  }
  if (response.body === null) throw new Error(`${label} returned an empty response`)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = Buffer.from(next.value)
    total += chunk.length
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel(`${label} response exceeded byte limit`)
      throw new Error(`${label} response exceeds the byte limit`)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function readCisaKevSignal(value: unknown): { cve: string; signal: CisaKevSignal } | undefined {
  const entry = asRecord(value)
  const cve = boundedString(entry?.cveID, 128)?.toUpperCase()
  if (cve === undefined || !/^CVE-\d{4}-\d{4,}$/u.test(cve)) return undefined
  const dateAdded = boundedString(entry?.dateAdded, 128)
  const dueDate = boundedString(entry?.dueDate, 128)
  const ransomwareUse = boundedString(entry?.knownRansomwareCampaignUse, 128)
  const requiredAction = boundedString(entry?.requiredAction, 8_192)
  const notes = boundedString(entry?.notes, 8_192)
  const signal: CisaKevSignal = {
    knownExploited: true,
    ...(dateAdded === undefined ? {} : { dateAdded }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(ransomwareUse === undefined ? {} : { knownRansomwareCampaignUse: ransomwareUse }),
    ...(requiredAction === undefined ? {} : { requiredAction }),
    ...(notes === undefined ? {} : { notes }),
  }
  return { cve, signal }
}

function parseCisaKevCatalog(value: unknown): Map<string, CisaKevSignal> {
  const root = asRecord(value)
  if (!Array.isArray(root?.vulnerabilities)) throw new Error('CISA KEV response has no vulnerabilities array')
  if (root.vulnerabilities.length > MAX_CVE_IDS) throw new Error('CISA KEV response contains too many entries')
  const result = new Map<string, CisaKevSignal>()
  for (const entry of root.vulnerabilities) {
    const parsed = readCisaKevSignal(entry)
    if (parsed !== undefined) result.set(parsed.cve, parsed.signal)
  }
  return result
}

function parseProbability(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} must be a number between 0 and 1`)
  return parsed
}

function parseEpssRows(value: unknown): Map<string, EpssSignal> {
  const root = asRecord(value)
  if (root?.status !== undefined && root.status !== 'OK') throw new Error('FIRST EPSS response status is not OK')
  if (!Array.isArray(root?.data)) throw new Error('FIRST EPSS response has no data array')
  const result = new Map<string, EpssSignal>()
  for (const raw of root.data) {
    const row = asRecord(raw)
    const cve = boundedString(row?.cve, 128)?.toUpperCase()
    if (cve === undefined || !/^CVE-\d{4}-\d{4,}$/u.test(cve)) throw new Error('FIRST EPSS response contains an invalid CVE')
    const signal: EpssSignal = {
      score: parseProbability(row?.epss, 'FIRST EPSS score'),
      percentile: parseProbability(row?.percentile, 'FIRST EPSS percentile'),
      ...(boundedString(row?.date, 64) === undefined ? {} : { date: boundedString(row?.date, 64) as string }),
    }
    result.set(cve, signal)
  }
  return result
}

function queryCveMap(
  advisories: readonly VulnerabilityAdvisory[],
  byCve: ReadonlyMap<string, CisaKevSignal | EpssSignal>,
  kind: 'cisaKev' | 'epss',
): Map<string, AdvisoryRiskSignals> {
  const result = emptyResults(advisories)
  for (const advisory of advisories) {
    for (const id of cveIds(advisory)) {
      const signal = byCve.get(id)
      if (signal === undefined) continue
      result.set(advisory.id, kind === 'cisaKev'
        ? { cisaKev: signal as CisaKevSignal }
        : { epss: signal as EpssSignal })
      break
    }
  }
  return result
}

class JsonThreatIntelClient {
  protected readonly fetcher: FetchLike
  protected readonly timeoutMs: number

  constructor(fetcher: FetchLike | undefined, timeoutMs: number | undefined, label: string) {
    this.fetcher = fetcher ?? fetch
    this.timeoutMs = timeoutMs ?? 20_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error(`${label} timeout must be between 1000 and 120000 milliseconds`)
    }
  }

  protected async getJson(url: string | URL, label: string): Promise<unknown> {
    return boundedJson(await this.fetcher(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'upstream-radar/threat-intel',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    }), label)
  }
}

/** CISA's authoritative known-exploited-in-the-wild catalog. */
export class CisaKevClient extends JsonThreatIntelClient implements ThreatIntelSource {
  readonly name = 'cisa-kev' as const
  private readonly url: string

  constructor(options: CisaKevClientOptions = {}) {
    super(options.fetch, options.timeoutMs, 'CISA KEV')
    this.url = normalizeHttpsUrl(options.url ?? DEFAULT_CISA_KEV_URL, 'CISA KEV URL')
  }

  async query(advisories: readonly VulnerabilityAdvisory[]): Promise<Map<string, AdvisoryRiskSignals>> {
    const result = emptyResults(advisories)
    if (uniqueCveIds(advisories).length === 0) return result
    const catalog = parseCisaKevCatalog(await this.getJson(this.url, 'CISA KEV'))
    for (const advisory of advisories) {
      for (const id of cveIds(advisory)) {
        const signal = catalog.get(id)
        if (signal === undefined) continue
        result.set(advisory.id, {
          cisaKev: { ...signal },
        })
        break
      }
    }
    return result
  }
}

/** FIRST's daily EPSS probability and percentile for CVE identifiers. */
export class EpssClient extends JsonThreatIntelClient implements ThreatIntelSource {
  readonly name = 'epss' as const
  private readonly url: string

  constructor(options: EpssClientOptions = {}) {
    super(options.fetch, options.timeoutMs, 'FIRST EPSS')
    this.url = normalizeHttpsUrl(options.url ?? DEFAULT_EPSS_URL, 'FIRST EPSS URL')
  }

  private chunks(ids: readonly string[]): string[][] {
    const result: string[][] = []
    let current: string[] = []
    for (const id of ids) {
      const candidate = [...current, id]
      const url = new URL(this.url)
      url.searchParams.set('cve', candidate.join(','))
      if (current.length > 0 && Buffer.byteLength(url.toString(), 'utf8') > MAX_EPSS_QUERY_BYTES) {
        result.push(current)
        current = [id]
      } else {
        current = candidate
      }
    }
    if (current.length > 0) result.push(current)
    return result
  }

  async query(advisories: readonly VulnerabilityAdvisory[]): Promise<Map<string, AdvisoryRiskSignals>> {
    const ids = uniqueCveIds(advisories)
    const byCve = new Map<string, EpssSignal>()
    for (const chunk of this.chunks(ids)) {
      const url = new URL(this.url)
      url.searchParams.set('cve', chunk.join(','))
      const parsed = parseEpssRows(await this.getJson(url, 'FIRST EPSS'))
      for (const [id, signal] of parsed) byCve.set(id, signal)
    }
    return queryCveMap(advisories, byCve, 'epss')
  }
}

export const THREAT_INTEL_REFERENCES = Object.freeze({
  cisaKev: CISA_KEV_REFERENCE,
  epss: EPSS_REFERENCE,
})
