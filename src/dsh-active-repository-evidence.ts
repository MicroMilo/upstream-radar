import { createHash } from 'node:crypto'
import {
  createDshEnvironmentRecommendationInputFingerprint,
  type DshEnvironmentRecommendationCandidate,
  type DshEnvironmentRecommendationDocument,
} from './dsh-environment-recommendation.js'

export const DSH_ACTIVE_REPOSITORY_EVIDENCE_SCHEMA = 'upstream-radar.dsh-active-repository-evidence/v1alpha1' as const
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT = /^[a-f0-9]{40}$/
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const MAX_EXTRA_DOCUMENTS = 8
const MAX_COLLECTED_DOCUMENTS = 24
const MAX_DOCUMENTS = 32 // Reserve eight supplement slots even when the collector already used 24.
const MAX_DOCUMENT_BYTES = 48 * 1024
const MAX_TOTAL_BYTES = 192 * 1024
const MAX_EXCERPT_SOURCE_BYTES = 256 * 1024
const MAX_EXCERPT_BYTES = 24 * 1024

export interface DshActiveRepositoryEvidenceState {
  schema: typeof DSH_ACTIVE_REPOSITORY_EVIDENCE_SCHEMA
  targetId: string
  baseInputFingerprint: string
  repository?: string
  sourceCommit?: string
  extraDocuments: Array<DshEnvironmentRecommendationDocument & { requestedAt: string }>
}

function exactPath(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 512
    || value.startsWith('/') || value.includes('\\') || value.includes('://')
    || /^[a-z]+:/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('supplemental repository evidence requires a clean bounded relative path')
  }
  return value
}

function document(input: unknown, requestedAt: string): DshActiveRepositoryEvidenceState['extraDocuments'][number] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('supplemental document must be an object')
  const value = input as Record<string, unknown>
  const path = exactPath(value.path)
  if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_DOCUMENT_BYTES) {
    throw new Error('supplemental repository document exceeds its byte bound')
  }
  if (!Number.isFinite(Date.parse(requestedAt))) throw new Error('supplemental evidence has no bounded request time')
  return { path, text: value.text, requestedAt }
}

function validateCorpus(base: DshEnvironmentRecommendationCandidate,
  extras: DshActiveRepositoryEvidenceState['extraDocuments']): void {
  if (base.documents.length > MAX_COLLECTED_DOCUMENTS) {
    throw new Error('collected repository evidence exceeds its 24-file bound')
  }
  const documents = [...base.documents, ...extras]
  if (documents.length > MAX_DOCUMENTS || extras.length > MAX_EXTRA_DOCUMENTS) {
    throw new Error('supplemental evidence exceeds the file-count bound')
  }
  const paths = new Set<string>()
  let bytes = 0
  for (const item of documents) {
    const path = exactPath(item.path)
    if (paths.has(path)) throw new Error(`duplicate supplemental repository document: ${path}`)
    paths.add(path)
    const size = Buffer.byteLength(item.text)
    if (size > MAX_DOCUMENT_BYTES) throw new Error('repository document exceeds its byte bound')
    bytes += size
  }
  if (bytes > MAX_TOTAL_BYTES) throw new Error('supplemental repository evidence exceeds its total byte bound')
}

export function emptyDshActiveRepositoryEvidence(
  base: DshEnvironmentRecommendationCandidate,
): DshActiveRepositoryEvidenceState {
  validateCorpus(base, [])
  return { schema: DSH_ACTIVE_REPOSITORY_EVIDENCE_SCHEMA, targetId: base.targetId,
    baseInputFingerprint: createDshEnvironmentRecommendationInputFingerprint(base),
    ...(base.repository === undefined ? {} : { repository: base.repository }),
    ...(base.sourceCommit === undefined ? {} : { sourceCommit: base.sourceCommit }),
    extraDocuments: [] }
}

export function parseDshActiveRepositoryEvidence(
  input: unknown, base: DshEnvironmentRecommendationCandidate,
): DshActiveRepositoryEvidenceState {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('active repository evidence state must be an object')
  const state = input as Record<string, unknown>
  if (state.schema !== DSH_ACTIVE_REPOSITORY_EVIDENCE_SCHEMA || state.targetId !== base.targetId
    || typeof state.baseInputFingerprint !== 'string' || !FINGERPRINT.test(state.baseInputFingerprint)
    || state.baseInputFingerprint !== createDshEnvironmentRecommendationInputFingerprint(base)
    || state.repository !== base.repository || state.sourceCommit !== base.sourceCommit) {
    throw new Error('supplemental repository evidence is stale against its exact base candidate')
  }
  if (!Array.isArray(state.extraDocuments) || state.extraDocuments.length > MAX_EXTRA_DOCUMENTS) {
    throw new Error('supplemental evidence file-count bound exceeded')
  }
  const extraDocuments = state.extraDocuments.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('supplemental document must be an object')
    const value = item as Record<string, unknown>
    if (Object.keys(value).some(key => !['path', 'text', 'requestedAt'].includes(key))
      || typeof value.requestedAt !== 'string' || value.requestedAt.length > 64) {
      throw new Error('supplemental repository document has unsupported fields')
    }
    return document(value, value.requestedAt)
  })
  validateCorpus(base, extraDocuments)
  return { schema: DSH_ACTIVE_REPOSITORY_EVIDENCE_SCHEMA, targetId: base.targetId,
    baseInputFingerprint: state.baseInputFingerprint,
    ...(base.repository === undefined ? {} : { repository: base.repository }),
    ...(base.sourceCommit === undefined ? {} : { sourceCommit: base.sourceCommit }),
    extraDocuments }
}

/** Re-key pinned source bytes only when the exact base corpus is unchanged and
 * only the bounded review contract moved from v12/v13 to the current rules. */
export function rebaseDshActiveRepositoryEvidenceReviewContract(
  input: unknown, base: DshEnvironmentRecommendationCandidate,
): { state: DshActiveRepositoryEvidenceState; migratedFrom?: string } {
  try { return { state: parseDshActiveRepositoryEvidence(input, base) } }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'supplemental repository evidence is stale against its exact base candidate') {
      throw error
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('supplemental repository evidence is stale against its exact base candidate')
  }
  const old = input as Record<string, unknown>
  const oldFingerprint = (['dsh-environment/v13', 'dsh-environment/v12'] as const)
    .map(contract => createDshEnvironmentRecommendationInputFingerprint(base, contract))
    .find(fingerprint => old.baseInputFingerprint === fingerprint)
  if (oldFingerprint === undefined) {
    throw new Error('supplemental repository evidence is stale against its exact base candidate')
  }
  const state = parseDshActiveRepositoryEvidence({ ...old,
    baseInputFingerprint: createDshEnvironmentRecommendationInputFingerprint(base) }, base)
  return { state, migratedFrom: oldFingerprint }
}

export function addDshActiveRepositoryEvidence(
  stateInput: unknown, base: DshEnvironmentRecommendationCandidate,
  fetched: DshEnvironmentRecommendationDocument, requestedAt = new Date().toISOString(),
): { state: DshActiveRepositoryEvidenceState; candidate: DshEnvironmentRecommendationCandidate;
  inputFingerprint: string } {
  const prior = parseDshActiveRepositoryEvidence(stateInput, base)
  const appended = [...prior.extraDocuments, document(fetched, requestedAt)]
  validateCorpus(base, appended)
  const state = parseDshActiveRepositoryEvidence({ ...prior, extraDocuments: appended }, base)
  const candidate = { ...base, documents: [...base.documents, ...state.extraDocuments.map(({ path, text }) => ({ path, text }))] }
  return { state, candidate, inputFingerprint: createDshEnvironmentRecommendationInputFingerprint(candidate) }
}

/** The broker fetches text only from one exact repo/commit; the YOLO container has no URL tool. */
export async function fetchDshActiveRepositoryDocument(
  candidate: DshEnvironmentRecommendationCandidate, pathInput: unknown,
  request: typeof fetch = fetch,
): Promise<DshEnvironmentRecommendationDocument> {
  const path = exactPath(pathInput), repository = candidate.repository, commit = candidate.sourceCommit
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)
    || typeof commit !== 'string' || !COMMIT.test(commit)) {
    throw new Error('exact immutable repository coordinates are unavailable for supplemental evidence')
  }
  const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${encoded}`
  const headers: Record<string, string> = { accept: 'text/plain', 'user-agent': 'upstream-radar/active-repository-evidence' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`exact repository evidence returned HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_DOCUMENT_BYTES) {
    throw new Error('supplemental repository response exceeds its byte bound')
  }
  if (response.body === null) throw new Error('supplemental repository response had no body')
  const chunks: Buffer[] = []
  let bytes = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_DOCUMENT_BYTES) {
        await reader.cancel()
        throw new Error('supplemental repository response exceeds its byte bound')
      }
      chunks.push(Buffer.from(next.value))
    }
  } finally { reader.releaseLock() }
  const raw = Buffer.concat(chunks, bytes), text = raw.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(raw)) throw new Error('supplemental repository document is not UTF-8 text')
  return { path, text }
}

/** A large author README stays source-pinned and bounded; each byte-range becomes fingerprinted evidence. */
export async function fetchDshActiveRepositoryExcerpt(
  candidate: DshEnvironmentRecommendationCandidate, pathInput: unknown, offsetInput: unknown,
  request: typeof fetch = fetch,
): Promise<DshEnvironmentRecommendationDocument & {
  sourcePath: string; totalBytes: number; startByte: number; endByte: number
}> {
  const sourcePath = exactPath(pathInput), repository = candidate.repository, commit = candidate.sourceCommit
  if (!Number.isSafeInteger(offsetInput) || (offsetInput as number) < 0
    || (offsetInput as number) > MAX_EXCERPT_SOURCE_BYTES) {
    throw new Error('repository excerpt requires a bounded byte offset')
  }
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)
    || typeof commit !== 'string' || !COMMIT.test(commit)) {
    throw new Error('exact immutable repository coordinates are unavailable for supplemental evidence')
  }
  const encoded = sourcePath.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const authenticated = typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN !== ''
  const url = authenticated
    ? `https://api.github.com/repos/${repository}/contents/${encoded}?ref=${commit}`
    : `https://raw.githubusercontent.com/${repository}/${commit}/${encoded}`
  const headers: Record<string, string> = { accept: authenticated ? 'application/vnd.github+json' : 'text/plain',
    'user-agent': 'upstream-radar/active-repository-evidence' }
  if (authenticated) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`exact repository excerpt returned HTTP ${response.status}`)
  const responseLimit = authenticated ? 512 * 1024 : MAX_EXCERPT_SOURCE_BYTES
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > responseLimit) {
    throw new Error('repository excerpt response exceeds its byte bound')
  }
  if (response.body === null) throw new Error('repository excerpt response had no body')
  const chunks: Buffer[] = []
  let responseBytes = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      responseBytes += next.value.byteLength
      if (responseBytes > responseLimit) {
        await reader.cancel()
        throw new Error('repository excerpt response exceeds its byte bound')
      }
      chunks.push(Buffer.from(next.value))
    }
  } finally { reader.releaseLock() }
  const responseBody = Buffer.concat(chunks, responseBytes)
  let raw: Buffer
  if (authenticated) {
    let envelope: Record<string, unknown>
    try { envelope = JSON.parse(responseBody.toString('utf8')) }
    catch { throw new Error('repository excerpt API response is not bounded JSON') }
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)
      || envelope.type !== 'file' || envelope.encoding !== 'base64' || !Number.isSafeInteger(envelope.size)
      || (envelope.size as number) > MAX_EXCERPT_SOURCE_BYTES || (envelope.size as number) < 0
      || typeof envelope.content !== 'string' || typeof envelope.sha !== 'string'
      || !/^[a-f0-9]{40}$/.test(envelope.sha)) {
      throw new Error('repository excerpt API has incomplete source identity or exceeds its byte bound')
    }
    const encodedContent = envelope.content.replace(/\s/g, '')
    if (encodedContent.length > 4 * Math.ceil(MAX_EXCERPT_SOURCE_BYTES / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedContent)) {
      throw new Error('repository excerpt API content is not bounded canonical base64')
    }
    raw = Buffer.from(encodedContent, 'base64')
    if (raw.length !== envelope.size || raw.toString('base64') !== encodedContent) {
      throw new Error('repository excerpt API source size does not match its content')
    }
    const blob = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')
    if (blob !== envelope.sha) throw new Error('repository excerpt API git blob digest does not match its content')
  } else raw = responseBody
  const bytes = raw.length, decoded = raw.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(raw)) throw new Error('repository excerpt source is not UTF-8 text')
  let startByte = offsetInput as number
  if (startByte >= bytes) throw new Error('repository excerpt offset is beyond the source text')
  while (startByte < bytes && (raw[startByte]! & 0xc0) === 0x80) startByte++
  if (startByte >= bytes) throw new Error('repository excerpt offset is beyond the source text')
  let endByte = Math.min(bytes, startByte + MAX_EXCERPT_BYTES)
  while (endByte < bytes && (raw[endByte]! & 0xc0) === 0x80) endByte--
  if (endByte <= startByte) throw new Error('repository excerpt contains no complete UTF-8 characters')
  const path = `${sourcePath}#bytes=${startByte}-${endByte}`
  const text = `[Immutable repository excerpt: ${repository}@${commit}/${sourcePath}, byte range ${startByte}-${endByte} of ${bytes}; this is not the complete file.]\n${raw.subarray(startByte, endByte).toString('utf8')}`
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error('repository excerpt exceeds its document byte bound')
  return { path, text, sourcePath, totalBytes: bytes, startByte, endByte }
}
