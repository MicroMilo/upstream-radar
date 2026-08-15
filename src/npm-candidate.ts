import { parseNpmSpec, resolveNpmDependencyGraph, type NpmDependencyGraphOptions } from './npm.js'
import { packageKey } from './osv.js'
import type {
  CandidateDependencyGraphObservation,
  DependencyGraph,
  PackageCoordinate,
} from './radar-types.js'

export const MAX_CANDIDATE_GRAPHS = 64

const DEFAULT_CONCURRENCY = 2
const DEFAULT_TIMEOUT_MS = 60_000

export interface NpmCandidateGraphClientOptions {
  registry?: string
  timeoutMs?: number
  concurrency?: number
  /** Test seam; production uses the isolated package-lock-only resolver. */
  resolve?: (candidate: PackageCoordinate, options: NpmDependencyGraphOptions) => Promise<DependencyGraph>
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2_048)
}

/**
 * Resolve a bounded set of exact npm candidates on the manifest/lockfile plane.
 * Package code is not downloaded into the project and lifecycle scripts are disabled.
 */
export class NpmCandidateGraphClient {
  private readonly registry: string | undefined
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly resolver: (candidate: PackageCoordinate, options: NpmDependencyGraphOptions) => Promise<DependencyGraph>

  constructor(options: NpmCandidateGraphClientOptions = {}) {
    this.registry = options.registry
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error('npm candidate graph timeout must be between 1000 and 120000 milliseconds')
    }
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) {
      throw new Error('npm candidate graph concurrency must be between 1 and 8')
    }
    this.resolver = options.resolve ?? ((candidate, resolverOptions) => (
      resolveNpmDependencyGraph(parseNpmSpec(`npm:${candidate.name}@${candidate.version}`), resolverOptions)
    ))
  }

  async query(input: readonly PackageCoordinate[]): Promise<Map<string, CandidateDependencyGraphObservation>> {
    const unique = [...new Map(input.map(item => [packageKey(item), item])).values()]
    if (unique.length > MAX_CANDIDATE_GRAPHS) {
      throw new Error(`candidate dependency graph query exceeds the ${MAX_CANDIDATE_GRAPHS} package limit`)
    }

    const result = new Map<string, CandidateDependencyGraphObservation>()
    const queue = [...unique]
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const candidate = queue.shift()
        if (candidate === undefined) return
        const key = packageKey(candidate)
        try {
          const resolverOptions: NpmDependencyGraphOptions = {
            timeoutMs: this.timeoutMs,
            ...(this.registry === undefined ? {} : { registry: this.registry }),
          }
          const graph = await this.resolver(candidate, resolverOptions)
          const unresolved = graph.unresolved ?? []
          const requiredUnresolved = unresolved.filter(item => item.kind !== 'optional').length
          result.set(key, {
            candidate: { ...candidate },
            status: requiredUnresolved === 0 ? 'checked' : 'incomplete',
            graph,
          })
        } catch (error: unknown) {
          result.set(key, {
            candidate: { ...candidate },
            status: 'unavailable',
            error: safeError(error),
          })
        }
      }
    })
    await Promise.all(workers)
    return result
  }
}
