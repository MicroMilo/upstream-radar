import { createHash } from 'node:crypto'
import {
  DEPENDENCY_GRAPH_SCHEMA,
  type DependencyEdge,
  type DependencyGraph,
  type DependencyKind,
  type DependencyNode,
} from './radar-types.js'

interface RootPackage {
  name: string
  version: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === undefined) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

function optionalPeerNames(value: unknown): Set<string> {
  const record = asRecord(value)
  if (record === undefined) return new Set()
  return new Set(Object.entries(record)
    .filter(([, item]) => asRecord(item)?.optional === true)
    .map(([name]) => name))
}

function packageNameFromPath(path: string): string | undefined {
  const marker = 'node_modules/'
  const offset = path.lastIndexOf(marker)
  if (offset < 0) return undefined
  const remainder = path.slice(offset + marker.length)
  const parts = remainder.split('/')
  if (parts[0]?.startsWith('@')) {
    return parts[0] !== undefined && parts[1] !== undefined ? `${parts[0]}/${parts[1]}` : undefined
  }
  return parts[0] === '' ? undefined : parts[0]
}

function candidateDependencyPaths(parentPath: string, dependencyName: string): string[] {
  const candidates: string[] = [`${parentPath}/node_modules/${dependencyName}`]
  let cursor = parentPath
  while (true) {
    const boundary = cursor.lastIndexOf('/node_modules/')
    if (boundary < 0) break
    cursor = cursor.slice(0, boundary)
    candidates.push(`${cursor}/node_modules/${dependencyName}`)
  }
  candidates.push(`node_modules/${dependencyName}`)
  return [...new Set(candidates)]
}

function dependencyEntries(item: Record<string, unknown>): Array<{ name: string; spec: string; kind: DependencyKind }> {
  const selected = new Map<string, { spec: string; kind: DependencyKind }>()
  const add = (value: unknown, kind: DependencyKind, selectKind?: (name: string) => DependencyKind): void => {
    for (const [name, spec] of Object.entries(asStringRecord(value))) {
      selected.set(name, { spec, kind: selectKind?.(name) ?? kind })
    }
  }
  add(item.devDependencies, 'development')
  add(item.dependencies, 'runtime')
  const optionalPeers = optionalPeerNames(item.peerDependenciesMeta)
  add(item.peerDependencies, 'peer', name => optionalPeers.has(name) ? 'optional' : 'peer')
  add(item.optionalDependencies, 'optional')
  return [...selected.entries()].map(([name, value]) => ({ name, ...value }))
}

export function dependencyGraphDigest(nodes: readonly DependencyNode[], edges: readonly DependencyEdge[]): string {
  const hash = createHash('sha256')
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(`node\0${node.id}\0${node.name}\0${node.version}\0${node.source ?? ''}\n`)
  }
  for (const edge of [...edges].sort((left, right) => (
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind)
  ))) {
    hash.update(`edge\0${edge.from}\0${edge.to}\0${edge.kind}\n`)
  }
  return `sha256:${hash.digest('hex')}`
}

/** Parse the exact package tree produced by npm package-lock v2/v3 without executing package code. */
export function parseNpmLockGraph(lockfile: unknown, rootPackage: RootPackage): DependencyGraph {
  const root = asRecord(lockfile)
  const rawPackages = asRecord(root?.packages)
  if (rawPackages === undefined) throw new Error('npm lockfile does not contain a packages map')
  if (Object.keys(rawPackages).length > 100_000) throw new Error('npm lockfile exceeds the 100000 package limit')

  const records = new Map<string, Record<string, unknown>>()
  const allNodes = new Map<string, DependencyNode>()
  for (const [path, rawItem] of Object.entries(rawPackages)) {
    if (path === '') continue
    const item = asRecord(rawItem)
    if (item === undefined) continue
    records.set(path, item)
    const version = typeof item.version === 'string' ? item.version : undefined
    const name = typeof item.name === 'string' ? item.name : packageNameFromPath(path)
    if (name === undefined || version === undefined) continue
    allNodes.set(path, { id: path, name, version })
  }

  const roots = [...allNodes.values()]
    .filter(node => node.name === rootPackage.name && node.version === rootPackage.version)
    .sort((left, right) => left.id.length - right.id.length || left.id.localeCompare(right.id))
  const rootNode = roots[0]
  if (rootNode === undefined) {
    throw new Error(`requested root package is not present in npm lockfile: ${rootPackage.name}@${rootPackage.version}`)
  }

  const allEdges: DependencyEdge[] = []
  const unresolved: NonNullable<DependencyGraph['unresolved']> = []
  for (const [parentPath, parentNode] of allNodes) {
    const item = records.get(parentPath)
    if (item === undefined) continue
    for (const dependency of dependencyEntries(item)) {
      const targetPath = candidateDependencyPaths(parentPath, dependency.name)
        .find(candidate => allNodes.has(candidate))
      if (targetPath === undefined) {
        unresolved.push({ from: parentNode.id, ...dependency })
        continue
      }
      allEdges.push({ from: parentNode.id, to: targetPath, kind: dependency.kind })
    }
  }

  const outgoing = new Map<string, DependencyEdge[]>()
  for (const edge of allEdges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }
  const reachable = new Set<string>([rootNode.id])
  const queue = [rootNode.id]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    for (const edge of outgoing.get(next) ?? []) {
      if (reachable.has(edge.to)) continue
      reachable.add(edge.to)
      queue.push(edge.to)
    }
  }

  const nodes = [...reachable]
    .map(id => allNodes.get(id))
    .filter((node): node is DependencyNode => node !== undefined)
    .sort((left, right) => left.id === rootNode.id ? -1 : right.id === rootNode.id ? 1 : left.id.localeCompare(right.id))
  const edges = allEdges
    .filter(edge => reachable.has(edge.from) && reachable.has(edge.to))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind))
  const reachableUnresolved = unresolved.filter(item => reachable.has(item.from))

  return {
    schema: DEPENDENCY_GRAPH_SCHEMA,
    rootNodeId: rootNode.id,
    nodes,
    edges,
    source: 'npm-lock',
    digest: dependencyGraphDigest(nodes, edges),
    ...(reachableUnresolved.length === 0 ? {} : { unresolved: reachableUnresolved }),
  }
}

/** Return bounded, cycle-safe root-to-node paths for an alert. */
export function findDependencyPaths(
  graph: DependencyGraph,
  targetNodeId: string,
  options: { maxPaths?: number; maxDepth?: number } = {},
): DependencyNode[][] {
  const maxPaths = options.maxPaths ?? 20
  const maxDepth = options.maxDepth ?? 64
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 1_000) throw new Error('maxPaths must be between 1 and 1000')
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) throw new Error('maxDepth must be between 1 and 1000')

  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  if (!nodes.has(graph.rootNodeId)) throw new Error('dependency graph root node is missing')
  if (!nodes.has(targetNodeId)) return []
  const outgoing = new Map<string, DependencyEdge[]>()
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error('dependency graph edge references a missing node')
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }
  for (const list of outgoing.values()) {
    list.sort((left, right) => {
      const leftNode = nodes.get(left.to)
      const rightNode = nodes.get(right.to)
      return `${leftNode?.name ?? ''}@${leftNode?.version ?? ''}:${left.to}`
        .localeCompare(`${rightNode?.name ?? ''}@${rightNode?.version ?? ''}:${right.to}`)
    })
  }

  const found: DependencyNode[][] = []
  const visit = (current: string, path: string[], seen: Set<string>): void => {
    if (found.length >= maxPaths || path.length > maxDepth) return
    if (current === targetNodeId) {
      const resolved = path.map(id => nodes.get(id)).filter((node): node is DependencyNode => node !== undefined)
      if (resolved.length === path.length) found.push(resolved)
      return
    }
    for (const edge of outgoing.get(current) ?? []) {
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      visit(edge.to, [...path, edge.to], seen)
      seen.delete(edge.to)
    }
  }
  visit(graph.rootNodeId, [graph.rootNodeId], new Set([graph.rootNodeId]))
  return found
}
