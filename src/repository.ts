import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitHubRepositoryTarget {
  owner: string
  repository: string
  url: string
}

export interface MaterializedRepository {
  root: string
  target: GitHubRepositoryTarget
  cleanup: () => Promise<void>
}

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/

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

  return {
    root: checkout,
    target,
    cleanup: async () => {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
    },
  }
}
