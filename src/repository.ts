import { spawnSync } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

export interface GitHubRepositoryTarget {
  owner: string
  repository: string
  url: string
}

export interface MaterializedRepository {
  root: string
  relativeRoot: string
  target: GitHubRepositoryTarget
  cleanup: () => Promise<void>
}

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_DISCOVERY_DEPTH = 3
const DISCOVERY_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules'])

interface PackageCandidate {
  directory: string
  relativeRoot: string
  isDshBundle: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function formatRelativeRoot(root: string, directory: string): string {
  const value = relative(root, directory).split(sep).join('/')
  return value === '' ? '.' : value
}

async function hasPackageJson(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function inspectPackageCandidate(root: string, directory: string): Promise<PackageCandidate | undefined> {
  const manifestPath = join(directory, 'package.json')
  let stats
  try {
    stats = await lstat(manifestPath)
  } catch {
    return undefined
  }
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
  const manifest = asRecord(parsed)
  if (manifest === undefined) return undefined
  const dsh = asRecord(manifest.dsh)
  const bundle = asRecord(dsh?.bundle)
  const isDshBundle = bundle !== undefined && Object.prototype.hasOwnProperty.call(bundle, 'patch')
  return {
    directory,
    relativeRoot: formatRelativeRoot(root, directory),
    isDshBundle,
  }
}

async function findPackageCandidates(root: string, maxDepth = MAX_DISCOVERY_DEPTH): Promise<PackageCandidate[]> {
  const candidates: PackageCandidate[] = []

  async function visit(directory: string, depth: number): Promise<void> {
    const candidate = await inspectPackageCandidate(root, directory)
    if (candidate !== undefined) candidates.push(candidate)
    if (depth >= maxDepth) return

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || DISCOVERY_EXCLUDED_DIRECTORIES.has(entry.name)) continue
      await visit(join(directory, entry.name), depth + 1)
    }
  }

  await visit(root, 0)
  return candidates
}

export async function discoverRepositoryScanRoot(checkout: string): Promise<{ root: string; relativeRoot: string }> {
  if (await hasPackageJson(checkout)) return { root: checkout, relativeRoot: '.' }

  const candidates = await findPackageCandidates(checkout)
  const dshCandidates = candidates.filter(candidate => candidate.isDshBundle)
  if (dshCandidates.length === 1) {
    const candidate = dshCandidates[0]
    if (candidate === undefined) throw new Error('internal error while selecting the DSH plugin directory')
    return { root: candidate.directory, relativeRoot: candidate.relativeRoot }
  }
  if (dshCandidates.length > 1) {
    const directories = dshCandidates.map(candidate => candidate.relativeRoot).join(', ')
    throw new Error(`repository contains multiple DSH plugin directories; choose one explicitly: ${directories}`)
  }
  if (candidates.length === 1) {
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('internal error while selecting the repository package directory')
    return { root: candidate.directory, relativeRoot: candidate.relativeRoot }
  }
  throw new Error('repository has no package.json at its root or one unique plugin directory within three levels')
}

export function parseGitHubRepositoryUrl(input: string): GitHubRepositoryTarget | undefined {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return undefined
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) return undefined
  const owner = segments[0]
  const repositoryWithSuffix = segments[1]
  if (owner === undefined || repositoryWithSuffix === undefined) return undefined
  const repository = repositoryWithSuffix.endsWith('.git')
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix
  if (repository.length === 0 || !GITHUB_REPOSITORY_SEGMENT.test(owner) || !GITHUB_REPOSITORY_SEGMENT.test(repository)) {
    return undefined
  }

  return {
    owner,
    repository,
    url: `https://github.com/${owner}/${repository}.git`,
  }
}

function cloneFailureMessage(target: GitHubRepositoryTarget, result: ReturnType<typeof spawnSync>): string {
  if (result.error !== undefined) return result.error.message
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return stderr || stdout || `git clone exited with status ${result.status ?? 'unknown'}`
}

export async function materializeGitHubRepository(input: string): Promise<MaterializedRepository> {
  const target = parseGitHubRepositoryUrl(input)
  if (target === undefined) {
    throw new Error('scan remote target must be a public GitHub repository URL such as https://github.com/owner/repository')
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'upstream-radar-repository-'))
  const checkout = join(temporaryRoot, 'repo')
  const result = spawnSync('git', [
    'clone',
    '--depth', '1',
    '--no-tags',
    '--single-branch',
    '--no-recurse-submodules',
    target.url,
    checkout,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })

  if (result.error !== undefined || result.status !== 0) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
    throw new Error(`could not read ${target.owner}/${target.repository}: ${cloneFailureMessage(target, result).slice(0, 1_024)}`)
  }

  let scanRoot
  try {
    scanRoot = await discoverRepositoryScanRoot(checkout)
  } catch (error: unknown) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`could not read ${target.owner}/${target.repository}: ${reason}`)
  }

  return {
    root: scanRoot.root,
    relativeRoot: scanRoot.relativeRoot,
    target,
    cleanup: async () => {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
    },
  }
}
