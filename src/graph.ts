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

const MAX_PNPM_LOCKFILE_BYTES = 16 * 1024 * 1024
const MAX_PNPM_LOCKFILE_LINES = 500_000
const MAX_PNPM_LOCKFILE_PACKAGES = 100_000
const MAX_PNPM_LOCKFILE_EDGES = 250_000

interface PnpmYamlLine {
  indent: number
  content: string
  line: number
}

interface PnpmEntry {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  optionalPeers: Set<string>
}

interface PnpmLocator {
  key: string
  name: string
  version: string
  suffix: string
}

interface PnpmPackageRecord extends PnpmLocator {
  id: string
  entry: PnpmEntry
}

const PNPM_DEPENDENCY_SECTIONS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])

function stripPnpmYamlComment(value: string): string {
  let quote: 'single' | 'double' | undefined
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === 'single') {
      if (character === "'" && value[index + 1] === "'") {
        index += 1
      } else if (character === "'") {
        quote = undefined
      }
      continue
    }
    if (quote === 'double') {
      if (character === '\\') index += 1
      else if (character === '"') quote = undefined
      continue
    }
    if (character === "'") quote = 'single'
    else if (character === '"') quote = 'double'
    else if (character === '#' && (index === 0 || /\s/.test(value[index - 1] ?? ''))) return value.slice(0, index).trimEnd()
  }
  return value.trimEnd()
}

function pnpmMappingColon(value: string): number {
  let quote: 'single' | 'double' | undefined
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === 'single') {
      if (character === "'" && value[index + 1] === "'") index += 1
      else if (character === "'") quote = undefined
      continue
    }
    if (quote === 'double') {
      if (character === '\\') index += 1
      else if (character === '"') quote = undefined
      continue
    }
    if (character === "'") quote = 'single'
    else if (character === '"') quote = 'double'
    else if (character === ':' && (index + 1 === value.length || /\s/.test(value[index + 1] ?? ''))) return index
  }
  return -1
}

function parsePnpmYamlScalar(value: string, line: number): string {
  const trimmed = stripPnpmYamlComment(value).trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'string') throw new Error('not a string')
      return parsed
    } catch {
      throw new Error(`pnpm lockfile has an invalid quoted scalar on line ${line}`)
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('&') || trimmed.startsWith('*')) {
    return trimmed
  }
  return trimmed
}

function parsePnpmMapping(line: PnpmYamlLine): { key: string; value: string } | undefined {
  const colon = pnpmMappingColon(line.content)
  if (colon < 0) return undefined
  const key = parsePnpmYamlScalar(line.content.slice(0, colon), line.line)
  if (key === '') throw new Error(`pnpm lockfile has an empty mapping key on line ${line.line}`)
  return { key, value: parsePnpmYamlScalar(line.content.slice(colon + 1), line.line) }
}

function preparePnpmYamlLines(text: string): PnpmYamlLine[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_PNPM_LOCKFILE_BYTES) {
    throw new Error(`pnpm lockfile exceeds the ${MAX_PNPM_LOCKFILE_BYTES} byte limit`)
  }
  const rawLines = text.split(/\r?\n/)
  if (rawLines.length > MAX_PNPM_LOCKFILE_LINES) {
    throw new Error(`pnpm lockfile exceeds the ${MAX_PNPM_LOCKFILE_LINES} line limit`)
  }
  const lines: PnpmYamlLine[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? ''
    if (raw.includes('\t')) throw new Error(`pnpm lockfile uses tabs on line ${index + 1}`)
    const content = stripPnpmYamlComment(raw).trimEnd()
    if (content.trim() === '' || content.trim() === '---' || content.trim() === '...') continue
    const indent = raw.length - raw.trimStart().length
    if (indent > 256) throw new Error(`pnpm lockfile indentation is too deep on line ${index + 1}`)
    lines.push({ indent, content: content.slice(indent), line: index + 1 })
  }
  return lines
}

function pnpmSectionRange(lines: readonly PnpmYamlLine[], section: string): { start: number; end: number } {
  const start = lines.findIndex(line => line.indent === 0 && parsePnpmMapping(line)?.key === section)
  if (start < 0) throw new Error(`pnpm lockfile does not contain a ${section} section`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.indent === 0) {
      end = index
      break
    }
  }
  return { start, end }
}

function parsePnpmInlineDependencyMap(value: string, line: number): Record<string, string> {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {}
  const result: Record<string, string> = {}
  let start = 1
  let quote: 'single' | 'double' | undefined
  let depth = 0
  const parts: string[] = []
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index]
    if (quote === 'single') {
      if (character === "'" && trimmed[index + 1] === "'") index += 1
      else if (character === "'") quote = undefined
    } else if (quote === 'double') {
      if (character === '\\') index += 1
      else if (character === '"') quote = undefined
    } else if (character === "'") quote = 'single'
    else if (character === '"') quote = 'double'
    else if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(trimmed.slice(start, index))
      start = index + 1
    }
  }
  parts.push(trimmed.slice(start, -1))
  for (const part of parts) {
    const colon = pnpmMappingColon(part.trim())
    if (colon < 0) throw new Error(`pnpm lockfile has an invalid inline dependency map on line ${line}`)
    const key = parsePnpmYamlScalar(part.trim().slice(0, colon), line)
    const dependency = parsePnpmYamlScalar(part.trim().slice(colon + 1), line)
    if (key === '' || dependency === '') throw new Error(`pnpm lockfile has an invalid inline dependency map on line ${line}`)
    if (Object.hasOwn(result, key)) throw new Error(`pnpm lockfile repeats dependency ${key} on line ${line}`)
    result[key] = dependency
  }
  return result
}

function parsePnpmChildMap(
  lines: readonly PnpmYamlLine[],
  start: number,
  end: number,
  parentIndent: number,
  label: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = start; index < end; index += 1) {
    const line = lines[index]
    if (line === undefined || line.indent <= parentIndent) break
    if (line.indent !== parentIndent + 2) continue
    const mapping = parsePnpmMapping(line)
    if (mapping === undefined) continue
    if (mapping.value === '') continue
    if (Object.hasOwn(result, mapping.key)) throw new Error(`pnpm lockfile repeats ${label} ${mapping.key} on line ${line.line}`)
    result[mapping.key] = mapping.value
  }
  return result
}

function parsePnpmEntry(lines: readonly PnpmYamlLine[], start: number, end: number): PnpmEntry {
  const entry: PnpmEntry = {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    optionalPeers: new Set(),
  }
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    if (line === undefined || line.indent <= 2) break
    if (line.indent !== 4) continue
    const mapping = parsePnpmMapping(line)
    if (mapping === undefined) continue
    if (PNPM_DEPENDENCY_SECTIONS.has(mapping.key)) {
      const parsed = mapping.value.startsWith('{')
        ? parsePnpmInlineDependencyMap(mapping.value, line.line)
        : parsePnpmChildMap(lines, index + 1, end, line.indent, mapping.key)
      Object.assign(entry[mapping.key as keyof Pick<PnpmEntry, 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'>], parsed)
    } else if (mapping.key === 'peerDependenciesMeta' && mapping.value === '') {
      for (let child = index + 1; child < end; child += 1) {
        const childLine = lines[child]
        if (childLine === undefined || childLine.indent <= line.indent) break
        if (childLine.indent !== line.indent + 2) continue
        const childMapping = parsePnpmMapping(childLine)
        if (childMapping === undefined || childMapping.value !== '') continue
        for (let meta = child + 1; meta < end; meta += 1) {
          const metaLine = lines[meta]
          if (metaLine === undefined || metaLine.indent <= childLine.indent) break
          if (metaLine.indent !== childLine.indent + 2) continue
          const metaMapping = parsePnpmMapping(metaLine)
          if (metaMapping?.key === 'optional' && metaMapping.value === 'true') entry.optionalPeers.add(childMapping.key)
        }
      }
    }
  }
  return entry
}

function parsePnpmSectionEntries(lines: readonly PnpmYamlLine[], section: string): Map<string, PnpmEntry> {
  const range = pnpmSectionRange(lines, section)
  const result = new Map<string, PnpmEntry>()
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]
    if (line === undefined || line.indent !== 2) continue
    const mapping = parsePnpmMapping(line)
    if (mapping === undefined) continue
    if (mapping.value !== '' && mapping.value !== '{}') throw new Error(`pnpm lockfile ${section} entry ${mapping.key} must be a mapping on line ${line.line}`)
    let end = range.end
    for (let next = index + 1; next < range.end; next += 1) {
      if (lines[next]?.indent !== undefined && (lines[next]?.indent ?? 0) <= 2) {
        end = next
        break
      }
    }
    if (result.has(mapping.key)) throw new Error(`pnpm lockfile repeats ${section} entry ${mapping.key}`)
    result.set(mapping.key, parsePnpmEntry(lines, index, end))
    index = end - 1
  }
  return result
}

function pnpmTopLevelSectionExists(lines: readonly PnpmYamlLine[], section: string): boolean {
  return lines.some(line => line.indent === 0 && parsePnpmMapping(line)?.key === section)
}

function parsePnpmTopLevelDependencyMap(lines: readonly PnpmYamlLine[], section: string): Record<string, string> {
  if (!pnpmTopLevelSectionExists(lines, section)) return {}
  const range = pnpmSectionRange(lines, section)
  const result: Record<string, string> = {}
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]
    if (line === undefined || line.indent !== 2) continue
    const mapping = parsePnpmMapping(line)
    if (mapping === undefined || mapping.value === '') continue
    if (Object.hasOwn(result, mapping.key)) throw new Error(`pnpm lockfile repeats ${section} dependency ${mapping.key}`)
    result[mapping.key] = mapping.value
  }
  return result
}

function parsePnpmRootImporter(lines: readonly PnpmYamlLine[]): PnpmEntry | undefined {
  if (!pnpmTopLevelSectionExists(lines, 'importers')) return undefined
  const range = pnpmSectionRange(lines, 'importers')
  let start = -1
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]
    if (line?.indent === 2 && parsePnpmMapping(line)?.key === '.') {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  let end = range.end
  for (let index = start + 1; index < range.end; index += 1) {
    if (lines[index]?.indent !== undefined && (lines[index]?.indent ?? 0) <= 2) {
      end = index
      break
    }
  }
  const entry: PnpmEntry = {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    optionalPeers: new Set(),
  }
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    if (line === undefined || line.indent !== 4) continue
    const mapping = parsePnpmMapping(line)
    if (mapping === undefined || !PNPM_DEPENDENCY_SECTIONS.has(mapping.key)) continue
    const target = entry[mapping.key as keyof Pick<PnpmEntry, 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'>]
    if (mapping.value !== '') {
      Object.assign(target, parsePnpmInlineDependencyMap(mapping.value, line.line))
      continue
    }
    for (let child = index + 1; child < end; child += 1) {
      const childLine = lines[child]
      if (childLine === undefined || childLine.indent <= line.indent) break
      if (childLine.indent !== line.indent + 2) continue
      const childMapping = parsePnpmMapping(childLine)
      if (childMapping === undefined) continue
      let version = childMapping.value
      if (version === '') {
        for (let detail = child + 1; detail < end; detail += 1) {
          const detailLine = lines[detail]
          if (detailLine === undefined || detailLine.indent <= childLine.indent) break
          if (detailLine.indent !== childLine.indent + 2) continue
          const detailMapping = parsePnpmMapping(detailLine)
          if (detailMapping?.key === 'version') version = detailMapping.value
        }
      }
      if (version !== '') target[childMapping.key] = version
    }
  }
  return entry
}

function splitPnpmLocatorVersion(value: string): { version: string; suffix: string } | undefined {
  const markers = [value.indexOf('('), value.indexOf('_')].filter(index => index >= 0)
  const marker = markers.length === 0 ? -1 : Math.min(...markers)
  const version = marker < 0 ? value : value.slice(0, marker)
  if (version === '') return undefined
  return { version, suffix: marker < 0 ? '' : value.slice(marker) }
}

function parsePnpmLocator(value: string): PnpmLocator | undefined {
  let key = value.trim()
  if (key.startsWith('/')) key = key.slice(1)
  if (key === '' || key.startsWith('link:') || key.startsWith('file:') || key.startsWith('workspace:')) return undefined

  let name: string
  let versionWithSuffix: string
  const firstSlash = key.indexOf('/')
  const peerMarkers = [key.indexOf('('), key.indexOf('_')].filter(index => index >= 0)
  const firstPeerMarker = peerMarkers.length === 0 ? -1 : Math.min(...peerMarkers)
  if (key.startsWith('@')) {
    const secondSlash = firstSlash < 0 ? -1 : key.indexOf('/', firstSlash + 1)
    const atAfterName = firstSlash < 0 ? -1 : key.indexOf('@', firstSlash + 1)
    if (secondSlash > firstSlash && (atAfterName < 0 || secondSlash < atAfterName)) {
      name = key.slice(0, secondSlash)
      versionWithSuffix = key.slice(secondSlash + 1)
    } else if (atAfterName > firstSlash) {
      name = key.slice(0, atAfterName)
      versionWithSuffix = key.slice(atAfterName + 1)
    } else {
      return undefined
    }
  } else {
    const at = key.indexOf('@')
    if (firstSlash > 0 && (firstPeerMarker < 0 || firstSlash < firstPeerMarker) && (at < 0 || firstSlash < at || (firstPeerMarker >= 0 && at > firstPeerMarker))) {
      name = key.slice(0, firstSlash)
      versionWithSuffix = key.slice(firstSlash + 1)
    } else if (at > 0) {
      name = key.slice(0, at)
      versionWithSuffix = key.slice(at + 1)
    } else {
      return undefined
    }
  }
  const split = splitPnpmLocatorVersion(versionWithSuffix)
  if (split === undefined || name === '' || split.version === '') return undefined
  return { key, name, version: split.version, suffix: split.suffix }
}

function pnpmDependencyEntries(entry: PnpmEntry): Array<{ name: string; spec: string; kind: DependencyKind }> {
  const selected = new Map<string, { spec: string; kind: DependencyKind }>()
  const add = (value: Record<string, string>, kind: DependencyKind, selectKind?: (name: string) => DependencyKind): void => {
    for (const [name, spec] of Object.entries(value)) selected.set(name, { spec, kind: selectKind?.(name) ?? kind })
  }
  add(entry.devDependencies, 'development')
  add(entry.dependencies, 'runtime')
  add(entry.peerDependencies, 'peer', name => entry.optionalPeers.has(name) ? 'optional' : 'peer')
  add(entry.optionalDependencies, 'optional')
  return [...selected.entries()].map(([name, value]) => ({ name, ...value }))
}

function normalizedPnpmSuffix(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('_')) return trimmed.slice(1)
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return trimmed.slice(1, -1)
  return trimmed
}

function pnpmDependencyReference(spec: string, dependencyName: string): { version: string; suffix: string } | undefined {
  const trimmed = spec.trim()
  const firstPeerMarker = [trimmed.indexOf('('), trimmed.indexOf('_')].filter(index => index >= 0)
  const firstAt = trimmed.indexOf('@')
  const firstMarker = firstPeerMarker.length === 0 ? -1 : Math.min(...firstPeerMarker)
  const canBeFullLocator = trimmed.startsWith('/')
    || (firstAt >= 0 && (firstMarker < 0 || firstAt < firstMarker))
  if (canBeFullLocator) {
    const full = parsePnpmLocator(trimmed)
    if (full === undefined || full.name !== dependencyName) return undefined
    return { version: full.version, suffix: full.suffix }
  }
  const split = splitPnpmLocatorVersion(trimmed)
  return split
}

function pnpmRecordCoordinateKey(name: string, version: string): string {
  return `${name}\0${version}`
}

/** Parse pnpm lockfile v6/v9 package snapshots without installing or executing package code. */
export function parsePnpmLockGraph(text: string, rootPackage: RootPackage): DependencyGraph {
  const lines = preparePnpmYamlLines(text)
  const packageEntries = parsePnpmSectionEntries(lines, 'packages')
  const snapshotEntries = lines.some(line => line.indent === 0 && parsePnpmMapping(line)?.key === 'snapshots')
    ? parsePnpmSectionEntries(lines, 'snapshots')
    : new Map<string, PnpmEntry>()
  if (packageEntries.size > MAX_PNPM_LOCKFILE_PACKAGES || snapshotEntries.size > MAX_PNPM_LOCKFILE_PACKAGES) {
    throw new Error(`pnpm lockfile exceeds the ${MAX_PNPM_LOCKFILE_PACKAGES} package limit`)
  }

  const records = new Map<string, PnpmPackageRecord>()
  const addRecords = (entries: Map<string, PnpmEntry>): void => {
    for (const [rawKey, entry] of entries) {
      const locator = parsePnpmLocator(rawKey)
      if (locator === undefined) continue
      const existing = records.get(locator.key)
      if (existing === undefined) {
        records.set(locator.key, { ...locator, id: `pnpm:${locator.key}`, entry })
      } else {
        existing.entry = {
          dependencies: { ...existing.entry.dependencies, ...entry.dependencies },
          devDependencies: { ...existing.entry.devDependencies, ...entry.devDependencies },
          optionalDependencies: { ...existing.entry.optionalDependencies, ...entry.optionalDependencies },
          peerDependencies: { ...existing.entry.peerDependencies, ...entry.peerDependencies },
          optionalPeers: new Set([...existing.entry.optionalPeers, ...entry.optionalPeers]),
        }
      }
    }
  }
  addRecords(packageEntries)
  addRecords(snapshotEntries)
  if (records.size > MAX_PNPM_LOCKFILE_PACKAGES) {
    throw new Error(`pnpm lockfile exceeds the ${MAX_PNPM_LOCKFILE_PACKAGES} package limit`)
  }

  const roots = [...records.values()]
    .filter(record => record.name === rootPackage.name && record.version === rootPackage.version)
    .sort((left, right) => left.suffix.length - right.suffix.length || left.key.localeCompare(right.key))
  const root = roots[0] ?? (() => {
    const importer = parsePnpmRootImporter(lines)
    const legacyImporter: PnpmEntry = {
      dependencies: parsePnpmTopLevelDependencyMap(lines, 'dependencies'),
      devDependencies: parsePnpmTopLevelDependencyMap(lines, 'devDependencies'),
      optionalDependencies: parsePnpmTopLevelDependencyMap(lines, 'optionalDependencies'),
      peerDependencies: {},
      optionalPeers: new Set(),
    }
    const hasImporterDependencies = importer !== undefined && pnpmDependencyEntries(importer).length > 0
    const hasLegacyDependencies = pnpmDependencyEntries(legacyImporter).length > 0
    if (!hasImporterDependencies && !hasLegacyDependencies) return undefined
    const synthetic: PnpmPackageRecord = {
      key: `workspace-root:${rootPackage.name}@${rootPackage.version}`,
      name: rootPackage.name,
      version: rootPackage.version,
      suffix: '',
      id: `pnpm:workspace-root:${rootPackage.name}@${rootPackage.version}`,
      entry: hasImporterDependencies ? importer! : legacyImporter,
    }
    records.set(synthetic.key, synthetic)
    return synthetic
  })()
  if (root === undefined) {
    throw new Error(`requested root package is not present in pnpm lockfile: ${rootPackage.name}@${rootPackage.version}`)
  }

  const byCoordinate = new Map<string, PnpmPackageRecord[]>()
  for (const record of records.values()) {
    const key = pnpmRecordCoordinateKey(record.name, record.version)
    const list = byCoordinate.get(key) ?? []
    list.push(record)
    byCoordinate.set(key, list)
  }
  const resolveDependency = (name: string, spec: string): PnpmPackageRecord | undefined => {
    const reference = pnpmDependencyReference(spec, name)
    if (reference === undefined) return undefined
    const candidates = byCoordinate.get(pnpmRecordCoordinateKey(name, reference.version)) ?? []
    if (candidates.length === 0) return undefined
    const wantedSuffix = normalizedPnpmSuffix(reference.suffix)
    if (wantedSuffix !== '') {
      const exact = candidates.find(candidate => normalizedPnpmSuffix(candidate.suffix) === wantedSuffix)
      if (exact !== undefined) return exact
    }
    const base = candidates.find(candidate => candidate.suffix === '')
    if (base !== undefined) return base
    return candidates.length === 1 ? candidates[0] : undefined
  }

  const nodesById = new Map<string, DependencyNode>()
  const edges: DependencyEdge[] = []
  const unresolved: NonNullable<DependencyGraph['unresolved']> = []
  const queue = [root]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || visited.has(current.id)) continue
    visited.add(current.id)
    nodesById.set(current.id, { id: current.id, name: current.name, version: current.version })
    for (const dependency of pnpmDependencyEntries(current.entry)) {
      const target = resolveDependency(dependency.name, dependency.spec)
      if (target === undefined) {
        unresolved.push({ from: current.id, ...dependency })
        if (unresolved.length > MAX_PNPM_LOCKFILE_EDGES) throw new Error(`pnpm dependency graph exceeds the ${MAX_PNPM_LOCKFILE_EDGES} edge limit`)
        continue
      }
      if (edges.length >= MAX_PNPM_LOCKFILE_EDGES) throw new Error(`pnpm dependency graph exceeds the ${MAX_PNPM_LOCKFILE_EDGES} edge limit`)
      edges.push({ from: current.id, to: target.id, kind: dependency.kind })
      if (!visited.has(target.id)) queue.push(target)
    }
  }

  const nodes = [...nodesById.values()]
    .sort((left, right) => left.id === root.id ? -1 : right.id === root.id ? 1 : left.id.localeCompare(right.id))
  const sortedEdges = edges.sort((left, right) => (
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind)
  ))
  const sortedUnresolved = unresolved.sort((left, right) => (
    left.from.localeCompare(right.from) || left.name.localeCompare(right.name) || left.spec.localeCompare(right.spec)
  ))
  return {
    schema: DEPENDENCY_GRAPH_SCHEMA,
    rootNodeId: root.id,
    nodes,
    edges: sortedEdges,
    source: 'pnpm-lock',
    digest: dependencyGraphDigest(nodes, sortedEdges),
    ...(sortedUnresolved.length === 0 ? {} : { unresolved: sortedUnresolved }),
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
