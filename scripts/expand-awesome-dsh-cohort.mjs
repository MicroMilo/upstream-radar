#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseAwesomeDshCohort } from '../dist/src/dsh-directory-feed.js'
import { parseDshInstallTargets } from '../dist/src/dsh-install-plan.js'
import { parseNpmSpec } from '../dist/src/npm.js'
import { satisfiesSemverRange } from '../dist/src/semver.js'
import { parseObserverConfigText } from '../dist/src/upstream-observer.js'

const execFile = promisify(execFileCallback)
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const MAX_CATALOG_BYTES = 64 * 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_CATALOG_ENTRIES = 10_000
const MAX_CATEGORY_ENTRIES = 8
const MAX_OWNER_ENTRIES = 4
const VERIFY_BATCH = 8
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

const COHORT_PATH = resolve('examples/dsh/awesome-observer/cohort.json')
const OBSERVER_TARGETS_PATH = resolve('examples/upstream-observer/targets.yml')
const INSTALL_TARGETS_PATH = resolve('examples/dsh/install-observer/targets.json')
const PRODUCER_REPOSITORY = 'micromilo/upstream-radar'

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function string(value, label, maximum = 2_048) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new Error(`${label} must be a bounded non-empty string`)
  return value
}

async function readJson(path, maximum = MAX_CATALOG_BYTES) {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > maximum) throw new Error(`${path} exceeds ${maximum} bytes`)
  return JSON.parse(contents)
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'upstream-radar/cohort-import', ...headers },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`)
  if (response.body === null) throw new Error(`${new URL(url).hostname} returned no body`)
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error(`${new URL(url).hostname} response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks.map(value => Buffer.from(value)), bytes).toString('utf8'))
}

function repositoryFromUrl(value) {
  const parsed = new URL(string(value, 'catalog plugin URL'))
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('catalog plugin URL must be a credential-free GitHub HTTPS URL')
  }
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  if (segments.length < 2) throw new Error('catalog plugin URL does not identify a repository')
  const repository = `${segments[0]}/${segments[1]}`
  if (!REPOSITORY.test(repository)) throw new Error('catalog plugin URL has an invalid repository coordinate')
  if (segments.length === 2) return { repository, requestedRef: undefined, packageDirectory: '' }
  if (segments[2] !== 'tree' || segments.length < 4 || !/^[A-Za-z0-9._-]+$/.test(segments[3])) {
    throw new Error('catalog subdirectory URL must use /tree/<simple-ref>/<path>')
  }
  const packageDirectory = segments.slice(4).join('/')
  if (packageDirectory === '' || packageDirectory.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('catalog subdirectory URL has an invalid package path')
  }
  return { repository, requestedRef: segments[3], packageDirectory }
}

function catalogEntryPath(url) {
  const { repository, packageDirectory } = repositoryFromUrl(url)
  const base = repository.replace('/', '__')
  return `data/plugins/${packageDirectory === '' ? base : `${base}--${packageDirectory.replaceAll('/', '-')}`}.yml`
}

function normalizeRepository(value) {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.url === 'string'
      ? value.url
      : undefined
  if (raw === undefined) return undefined
  const normalized = raw.trim()
    .replace(/^git\+/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
  let parsed
  try { parsed = new URL(normalized) } catch { return undefined }
  if (parsed.hostname.toLowerCase() !== 'github.com') return undefined
  const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  if (segments.length < 2) return undefined
  const repository = `${segments[0]}/${segments[1]}`
  return REPOSITORY.test(repository) ? repository : undefined
}

function exactInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function candidate(value) {
  const item = object(value, 'catalog plugin')
  if (item.npm === null || item.npm === undefined) return undefined
  const npm = string(item.npm, 'catalog npm package', 214)
  if (!PACKAGE_NAME.test(npm)) throw new Error(`catalog npm package is invalid: ${npm}`)
  const coordinate = repositoryFromUrl(item.url)
  return {
    name: string(item.name, 'catalog plugin name', 256),
    npm,
    url: string(item.url, 'catalog plugin URL'),
    category: string(item.category, 'catalog category', 64),
    downloads: exactInteger(item.downloads),
    stars: exactInteger(item.stars),
    ...coordinate,
  }
}

function packageId(name, repository, usedIds) {
  const base = name.split('/').at(-1).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const owner = repository.split('/')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  for (const proposal of [base, `${owner}-${base}`]) {
    const bounded = proposal.slice(0, 64).replace(/[-_.]+$/, '')
    if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bounded) && !usedIds.has(bounded)) return bounded
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const proposal = `${base.slice(0, 60 - String(suffix).length)}-${suffix}`
    if (!usedIds.has(proposal)) return proposal
  }
  throw new Error(`could not create a unique cohort id for ${name}`)
}

function yamlString(value) {
  return JSON.stringify(value)
}

function observerBlock(items) {
  const lines = [
    '',
    '  # Identity-checked expansion generated from the same immutable',
    '  # awesome-dsh-plugin catalog snapshot.',
  ]
  for (const item of items) {
    lines.push(
      `  - id: ${item.id}`,
      '    ecosystem: dsh',
      `    repository: ${item.repository}`,
      `    ref: ${yamlString(item.ref)}`,
      `    package: ${yamlString(item.distribution.name)}`,
      `    packagePath: ${yamlString(item.packagePath)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

async function atomicWrite(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  }
}

async function verifyCandidate(item, input) {
  const [owner, repo] = item.repository.split('/')
  const repositoryApi = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const npmApi = `https://registry.npmjs.org/${encodeURIComponent(item.npm)}/latest`
  const [repositoryMetadataValue, npmManifestValue] = await Promise.all([
    fetchJson(repositoryApi, githubHeaders(input.token)),
    fetchJson(npmApi, { accept: 'application/json' }),
  ])
  const repositoryMetadata = object(repositoryMetadataValue, `${item.repository} metadata`)
  if (repositoryMetadata.archived === true || repositoryMetadata.disabled === true) throw new Error('repository is archived or disabled')
  const defaultBranch = string(repositoryMetadata.default_branch, `${item.repository} default branch`, 256)
  const ref = item.requestedRef ?? defaultBranch
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error('repository ref is not a simple immutable-input branch name')
  const packagePath = item.packageDirectory === '' ? 'package.json' : `${item.packageDirectory}/package.json`
  const encodedPath = packagePath.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const sourceValue = await fetchJson(`${repositoryApi}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, githubHeaders(input.token))
  const source = object(sourceValue, `${item.repository} source package`)
  if (source.type !== 'file' || source.encoding !== 'base64' || typeof source.content !== 'string') throw new Error('source package.json was not returned as a regular base64 file')
  const decoded = Buffer.from(source.content.replace(/\s+/g, ''), 'base64')
  if (decoded.length === 0 || decoded.length > MAX_MANIFEST_BYTES) throw new Error('source package.json is empty or exceeds the byte budget')
  const sourceManifest = object(JSON.parse(decoded.toString('utf8')), `${item.repository} package.json`)
  const npmManifest = object(npmManifestValue, `${item.npm} latest manifest`)
  if (sourceManifest.name !== item.npm || npmManifest.name !== item.npm) throw new Error('catalog, source and npm package names do not align')
  const sourceVersion = string(sourceManifest.version, `${item.repository} source version`, 256)
  const selectedVersion = string(npmManifest.version, `${item.npm} latest version`, 256)
  if (!EXACT_VERSION.test(sourceVersion) || !EXACT_VERSION.test(selectedVersion)) throw new Error('source or npm version is not exact')
  const publishedRepository = normalizeRepository(npmManifest.repository)
  if (publishedRepository?.toLowerCase() !== item.repository.toLowerCase()) throw new Error('npm repository metadata does not point to the catalog repository')
  if (typeof sourceManifest.dsh !== 'object' || sourceManifest.dsh === null || Array.isArray(sourceManifest.dsh)) throw new Error('source package does not declare a DSH plugin contract')
  if (typeof npmManifest.dsh !== 'object' || npmManifest.dsh === null || Array.isArray(npmManifest.dsh)) throw new Error('published package does not declare a DSH plugin contract')
  const engines = typeof npmManifest.engines === 'object' && npmManifest.engines !== null && !Array.isArray(npmManifest.engines)
    ? npmManifest.engines
    : {}
  const nodeEngine = engines.node === undefined ? undefined : string(engines.node, `${item.npm} engines.node`, 512)
  let runtimeProfiles
  if (nodeEngine !== undefined) {
    const node22 = satisfiesSemverRange('22.23.2', nodeEngine)
    const node24 = satisfiesSemverRange('24.11.1', nodeEngine)
    if (node22 === undefined || node24 === undefined) throw new Error('Node engine range cannot be evaluated safely')
    if (!node22 && !node24) throw new Error('Node engine excludes both maintained runtimes')
    if (!node22 && node24) runtimeProfiles = ['node24']
  }
  const scripts = typeof npmManifest.scripts === 'object' && npmManifest.scripts !== null && !Array.isArray(npmManifest.scripts)
    ? npmManifest.scripts
    : {}
  const lifecycleScripts = LIFECYCLE_SCRIPTS.filter(name => typeof scripts[name] === 'string')
  const entry = catalogEntryPath(item.url)
  const entryMetadata = await lstat(join(input.catalogRoot, entry))
  if (!entryMetadata.isFile() || entryMetadata.size > 64 * 1024) throw new Error('catalog entry is not a bounded regular file')
  return {
    id: packageId(item.npm, item.repository, input.usedIds),
    catalogEntry: entry,
    catalogUrl: item.url,
    repository: item.repository,
    ref,
    category: item.category,
    packagePath,
    sourceCoordinateAtSelection: { name: item.npm, version: sourceVersion },
    distribution: { kind: 'npm', name: item.npm, selectedVersion, distTag: 'latest' },
    signals: {
      downloads: item.downloads,
      stars: item.stars,
      nodeEngine: nodeEngine ?? null,
      lifecycleScripts,
    },
    ...(runtimeProfiles === undefined ? {} : { runtimeProfiles }),
  }
}

const argumentsList = process.argv.slice(2)
if (argumentsList[0] === '--') argumentsList.shift()
const [catalogJsonPath, catalogCheckoutPath, requestedSizeRaw = '100'] = argumentsList
if (catalogJsonPath === undefined || catalogCheckoutPath === undefined) {
  throw new Error('usage: expand-awesome-dsh-cohort.mjs <plugins.json> <catalog-checkout> [desired-size]')
}
const requestedSize = Number(requestedSizeRaw)
if (!Number.isSafeInteger(requestedSize) || requestedSize < 1 || requestedSize > 100) throw new Error('desired-size must be an integer between 1 and 100')
const token = process.env.GITHUB_TOKEN
if (token === undefined || token.length < 20) throw new Error('GITHUB_TOKEN is required for bounded GitHub identity checks')

const catalogRoot = resolve(catalogCheckoutPath)
const [catalogValue, cohort, observerText, installTargets, catalogFiles, gitResult] = await Promise.all([
  readJson(catalogJsonPath),
  readJson(COHORT_PATH),
  readFile(OBSERVER_TARGETS_PATH, 'utf8'),
  readJson(INSTALL_TARGETS_PATH),
  readdir(join(catalogRoot, 'data/plugins')),
  execFile('git', ['-C', catalogRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4_096 }),
])
const catalog = object(catalogValue, 'awesome-dsh-plugin catalog')
if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0 || catalog.plugins.length > MAX_CATALOG_ENTRIES) throw new Error('catalog plugins are missing or exceed the bounded entry count')
if (catalog.count !== catalog.plugins.length || catalogFiles.filter(name => name.endsWith('.yml')).length !== catalog.plugins.length) throw new Error('catalog JSON and pinned YAML snapshot entry counts do not agree')
if (gitResult.stdout.trim() !== cohort.source?.commit) throw new Error('catalog checkout commit does not match the cohort provenance commit')
if (!Array.isArray(cohort.plugins) || cohort.plugins.length > requestedSize) throw new Error('existing cohort is invalid or already exceeds desired-size')
if (cohort.plugins.length === requestedSize) {
  process.stdout.write(`${JSON.stringify({ changed: false, size: requestedSize, reason: 'cohort already has the requested size' }, null, 2)}\n`)
  process.exit(0)
}

const parsedObserver = parseObserverConfigText(observerText)
const parsedInstall = parseDshInstallTargets(installTargets)
const excludedRepositories = new Set(parsedObserver.targets.map(item => item.repository.toLowerCase()))
const usedPackages = new Set(parsedInstall.plugins.map(item => parseNpmSpec(item.spec).name))
const usedIds = new Set([...cohort.plugins.map(item => item.id), ...parsedObserver.targets.map(item => item.id), ...parsedInstall.plugins.map(item => item.id)])
const categoryCounts = new Map()
const ownerCounts = new Map()
for (const item of cohort.plugins) {
  categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1)
  const owner = item.repository.split('/')[0].toLowerCase()
  ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1)
}

const ranked = []
const candidateRepositories = new Set()
for (const value of catalog.plugins) {
  let item
  try { item = candidate(value) } catch { continue }
  if (item === undefined || item.repository.toLowerCase() === PRODUCER_REPOSITORY
    || excludedRepositories.has(item.repository.toLowerCase()) || usedPackages.has(item.npm)) continue
  const repositoryKey = item.repository.toLowerCase()
  if (candidateRepositories.has(repositoryKey)) continue
  candidateRepositories.add(repositoryKey)
  ranked.push(item)
}
ranked.sort((left, right) => right.downloads - left.downloads || right.stars - left.stars || left.url.localeCompare(right.url))

const needed = requestedSize - cohort.plugins.length
const additions = []
const skipped = new Map()
let cursor = 0
while (additions.length < needed && cursor < ranked.length) {
  const batch = []
  while (batch.length < VERIFY_BATCH && cursor < ranked.length) {
    const item = ranked[cursor++]
    const owner = item.repository.split('/')[0].toLowerCase()
    if ((categoryCounts.get(item.category) ?? 0) >= MAX_CATEGORY_ENTRIES) continue
    if ((ownerCounts.get(owner) ?? 0) >= MAX_OWNER_ENTRIES) continue
    batch.push(item)
  }
  const verified = await Promise.allSettled(batch.map(item => verifyCandidate(item, { token, catalogRoot, usedIds })))
  for (const [index, result] of verified.entries()) {
    const item = batch[index]
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
      continue
    }
    const verifiedItem = result.value
    const owner = verifiedItem.repository.split('/')[0].toLowerCase()
    if ((categoryCounts.get(verifiedItem.category) ?? 0) >= MAX_CATEGORY_ENTRIES || (ownerCounts.get(owner) ?? 0) >= MAX_OWNER_ENTRIES) continue
    additions.push(verifiedItem)
    usedIds.add(verifiedItem.id)
    usedPackages.add(verifiedItem.distribution.name)
    excludedRepositories.add(verifiedItem.repository.toLowerCase())
    categoryCounts.set(verifiedItem.category, (categoryCounts.get(verifiedItem.category) ?? 0) + 1)
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1)
    if (additions.length === needed) break
  }
}
if (additions.length !== needed) throw new Error(`only ${additions.length}/${needed} requested identity-checked additions were available`)

const nextCohort = {
  ...cohort,
  selectedAt: new Date().toISOString(),
  source: { ...cohort.source, entryCount: catalog.plugins.length },
  plugins: [...cohort.plugins, ...additions.map(({ runtimeProfiles: _runtimeProfiles, ...item }) => item)],
}
const nextInstallTargets = {
  ...installTargets,
  plugins: [
    ...installTargets.plugins,
    ...additions.map(item => ({
      id: item.id,
      spec: `${item.distribution.name}@${item.distribution.selectedVersion}`,
      observerTargetId: item.id,
      ...(item.runtimeProfiles === undefined ? {} : { runtimeProfiles: item.runtimeProfiles }),
      reason: `Identity-checked npm artifact from the 100-plugin catalog cohort; selected with ${item.signals.downloads} downloads and ${item.signals.stars} GitHub stars to expand ${item.category} coverage.`,
    })),
  ],
}
const nextObserverText = `${observerText.replace('Adoption-stratified 50-plugin cohort', 'Adoption-stratified 100-plugin cohort').trimEnd()}${observerBlock(additions)}`

parseAwesomeDshCohort(nextCohort)
parseDshInstallTargets(nextInstallTargets)
const nextObserver = parseObserverConfigText(nextObserverText)
const importedIds = new Set(nextCohort.plugins.map(item => item.id))
if (nextObserver.targets.filter(item => importedIds.has(item.id)).length !== requestedSize) throw new Error('generated static targets do not align with the expanded cohort')

await Promise.all([
  atomicWrite(COHORT_PATH, `${JSON.stringify(nextCohort, null, 2)}\n`),
  atomicWrite(INSTALL_TARGETS_PATH, `${JSON.stringify(nextInstallTargets, null, 2)}\n`),
  atomicWrite(OBSERVER_TARGETS_PATH, nextObserverText),
])
process.stdout.write(`${JSON.stringify({
  changed: true,
  previousSize: requestedSize - additions.length,
  size: requestedSize,
  added: additions.length,
  executableNpmTargets: nextInstallTargets.plugins.length,
  additions: additions.map(item => ({ id: item.id, repository: item.repository, package: `${item.distribution.name}@${item.distribution.selectedVersion}`, category: item.category })),
  skipped: Object.fromEntries([...skipped.entries()].sort(([left], [right]) => left.localeCompare(right))),
}, null, 2)}\n`)
