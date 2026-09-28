import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import {
  addDshActiveRepositoryEvidence,
  emptyDshActiveRepositoryEvidence,
  fetchDshActiveRepositoryDocument,
  fetchDshActiveRepositoryExcerpt,
  rebaseDshActiveRepositoryEvidenceReviewContract,
  parseDshActiveRepositoryEvidence,
} from '../src/dsh-active-repository-evidence.js'
import { createDshEnvironmentRecommendationInputFingerprint } from '../src/dsh-environment-recommendation.js'

const candidate = { targetId: 'fixture', plugin: 'fixture@1.0.0', dshVersion: '0.1.6-alpha.1',
  sourceFingerprint: `sha256:${'a'.repeat(64)}`, repository: 'example/fixture',
  sourceCommit: 'b'.repeat(40), documents: [{ path: 'README.md', text: 'Use the author profile.' }] }

it('persists a pinned supplemental repository file and forces the Agent to re-review the changed evidence', () => {
  const baseFingerprint = createDshEnvironmentRecommendationInputFingerprint(candidate)
  const empty = emptyDshActiveRepositoryEvidence(candidate)
  const added = addDshActiveRepositoryEvidence(empty, candidate,
    { path: '.github/workflows/ci.yml', text: 'node-version: 20\n' },
    '2026-09-16T00:00:00.000Z')
  assert.equal(added.state.baseInputFingerprint, baseFingerprint)
  assert.equal(added.state.extraDocuments.length, 1)
  assert.equal(added.candidate.documents.length, 2)
  assert.notEqual(added.inputFingerprint, baseFingerprint)
  assert.deepEqual(parseDshActiveRepositoryEvidence(added.state, candidate), added.state)
  assert.throws(() => parseDshActiveRepositoryEvidence(added.state, {
    ...candidate, plugin: 'fixture@1.0.1',
  }), /stale|base/i)
  assert.throws(() => addDshActiveRepositoryEvidence(added.state, candidate,
    { path: '.github/workflows/ci.yml', text: 'different' }), /duplicate/i)
})

it('rebases supplemental excerpts only when the exact base corpus is unchanged across the v12 to v13 review contract', () => {
  const old = { ...emptyDshActiveRepositoryEvidence(candidate),
    baseInputFingerprint: createDshEnvironmentRecommendationInputFingerprint(candidate, 'dsh-environment/v12'),
    extraDocuments: [{ path: 'README.md#bytes=0-24576', text: 'Author Web instructions.',
      requestedAt: '2026-09-16T00:00:00.000Z' }] }
  const rebased = rebaseDshActiveRepositoryEvidenceReviewContract(old, candidate)
  assert.equal(rebased.migratedFrom, old.baseInputFingerprint)
  assert.equal(rebased.state.baseInputFingerprint, createDshEnvironmentRecommendationInputFingerprint(candidate))
  assert.deepEqual(rebased.state.extraDocuments, old.extraDocuments)
  assert.deepEqual(parseDshActiveRepositoryEvidence(rebased.state, candidate), rebased.state)
  assert.throws(() => rebaseDshActiveRepositoryEvidenceReviewContract(old, {
    ...candidate, documents: [{ path: 'README.md', text: 'Changed source content.' }],
  }), /stale|base/i)
  assert.throws(() => rebaseDshActiveRepositoryEvidenceReviewContract(old, {
    ...candidate, plugin: 'fixture@1.0.1',
  }), /stale|base/i)
})

it('rebases exact v13 supplemental evidence into v14 without transferring changed plugin bytes', () => {
  const old = { ...emptyDshActiveRepositoryEvidence(candidate),
    baseInputFingerprint: createDshEnvironmentRecommendationInputFingerprint(candidate, 'dsh-environment/v13'),
    extraDocuments: [{ path: 'README.md#bytes=24576-49152', text: 'Pinned author workflow evidence.',
      requestedAt: '2026-09-16T00:00:00.000Z' }] }
  const rebased = rebaseDshActiveRepositoryEvidenceReviewContract(old, candidate)
  assert.equal(rebased.migratedFrom, old.baseInputFingerprint)
  assert.deepEqual(rebased.state.extraDocuments, old.extraDocuments)
  assert.equal(rebased.state.baseInputFingerprint, createDshEnvironmentRecommendationInputFingerprint(candidate))
  assert.throws(() => rebaseDshActiveRepositoryEvidenceReviewContract(old, {
    ...candidate, documents: [{ path: 'README.md', text: 'A different immutable corpus.' }],
  }), /stale|base/i)
})

it('still permits a bounded supplemental file when the initial 24-file collection is full', () => {
  const full = { ...candidate, documents: Array.from({ length: 24 }, (_, index) =>
    ({ path: `docs/${index}.md`, text: `Initial evidence ${index}` })) }
  const first = emptyDshActiveRepositoryEvidence(full)
  const extra = addDshActiveRepositoryEvidence(first, full,
    { path: '.github/workflows/ci.yml', text: 'The author tests Node 20.' })
  assert.equal(extra.candidate.documents.length, 25)
  assert.notEqual(extra.inputFingerprint, first.baseInputFingerprint)
  assert.throws(() => emptyDshActiveRepositoryEvidence({ ...full,
    documents: [...full.documents, { path: 'docs/24.md', text: 'collector must not use the reserved slot' }] }),
  /collected.*24|file-count/i)
})

it('fetches only a bounded file under the immutable repository commit, never a target-supplied URL', async () => {
  const requests: Array<{ url: string; redirect: string | undefined }> = []
  const request = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), redirect: options?.redirect })
    return new Response('node-version: 20\n', { status: 200 })
  }
  const document = await fetchDshActiveRepositoryDocument(candidate,
    '.github/workflows/ci.yml', request as typeof fetch)
  assert.deepEqual(document, { path: '.github/workflows/ci.yml', text: 'node-version: 20\n' })
  assert.equal(requests[0]?.url,
    `https://raw.githubusercontent.com/example/fixture/${candidate.sourceCommit}/.github/workflows/ci.yml`)
  assert.equal(requests[0]?.redirect, 'error')
  for (const path of ['../token', '/etc/passwd', 'https://evil.example/x', 'docs/../../x', 'a\\b']) {
    await assert.rejects(fetchDshActiveRepositoryDocument(candidate, path, request as typeof fetch), /path/i)
  }
  assert.equal(requests.length, 1, 'invalid paths never reach the network')
  const oversized = async () => new Response('x'.repeat(48 * 1024 + 1), { status: 200 })
  await assert.rejects(fetchDshActiveRepositoryDocument(candidate, 'docs/huge.md', oversized as typeof fetch),
    /byte|bound/i)
})

it('lets the Agent read a bounded UTF-8 excerpt of an oversized immutable README and binds it to review evidence', async () => {
  const raw = '作者建议 Node 24。Web profile 是主入口。\n'.repeat(5_000)
  const request = async () => new Response(raw, { status: 200 })
  const excerpt = await fetchDshActiveRepositoryExcerpt(candidate, 'docs/large.md', 24 * 1024,
    request as typeof fetch)
  assert.match(excerpt.path, /^docs\/large\.md#bytes=\d+-\d+$/)
  assert.ok(excerpt.text.includes('作者建议 Node 24'))
  assert.ok(Buffer.byteLength(excerpt.text) <= 48 * 1024)
  assert.ok(excerpt.endByte - excerpt.startByte <= 24 * 1024)
  assert.equal(excerpt.totalBytes, Buffer.byteLength(raw))
  assert.equal(excerpt.sourcePath, 'docs/large.md')
  const added = addDshActiveRepositoryEvidence(emptyDshActiveRepositoryEvidence(candidate), candidate, excerpt)
  assert.notEqual(added.inputFingerprint, added.state.baseInputFingerprint)
  assert.equal(added.candidate.documents.at(-1)?.path, excerpt.path)
  await assert.rejects(fetchDshActiveRepositoryExcerpt(candidate, 'docs/large.md', 256 * 1024 + 1,
    request as typeof fetch), /offset|bound/i)
  const tooLarge = async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 })
  await assert.rejects(fetchDshActiveRepositoryExcerpt(candidate, 'docs/large.md', 0,
    tooLarge as typeof fetch), /bound|byte/i)
})

it('uses the pinned GitHub contents API for a large README when the trusted broker has a source-read token', async () => {
  const raw = Buffer.from('Node 22 and author web profile.\n'.repeat(4_000))
  const blob = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')
  const urls: string[] = []
  const request = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    urls.push(String(url))
    assert.equal((options?.headers as Record<string, string>).authorization, 'Bearer fixture-token')
    return new Response(JSON.stringify({ type: 'file', encoding: 'base64', size: raw.length, sha: blob,
      content: raw.toString('base64') }), { status: 200 })
  }
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'fixture-token'
  try {
    const excerpt = await fetchDshActiveRepositoryExcerpt(candidate, 'README.md', 0, request as typeof fetch)
    assert.equal(excerpt.totalBytes, raw.length)
    assert.ok(excerpt.text.includes('Node 22 and author web profile.'))
    assert.deepEqual(urls, [`https://api.github.com/repos/example/fixture/contents/README.md?ref=${candidate.sourceCommit}`])
    const bad = async () => new Response(JSON.stringify({ type: 'file', encoding: 'base64', size: raw.length,
      sha: '0'.repeat(40), content: raw.toString('base64') }), { status: 200 })
    await assert.rejects(fetchDshActiveRepositoryExcerpt(candidate, 'README.md', 0,
      bad as typeof fetch), /digest|blob|sha/i)
    const symlink = async () => new Response(JSON.stringify({ type: 'symlink', encoding: 'base64',
      size: raw.length, sha: blob, content: raw.toString('base64') }), { status: 200 })
    await assert.rejects(fetchDshActiveRepositoryExcerpt(candidate, 'README.md', 0,
      symlink as typeof fetch), /type|symlink|source/i)
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
})
