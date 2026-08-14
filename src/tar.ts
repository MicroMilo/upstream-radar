import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { Finding } from './types.js'

const TAR_BLOCK = 512
const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_MAX_UNPACKED_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PATH_BYTES = 4 * 1024
const MAX_PATH_SEGMENT_BYTES = 255
const MAX_REPORTED_FINDINGS = 100
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const SEVERITY_RANK: Record<Finding['severity'], number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }

export interface TarOptions {
  maxEntries?: number
  maxUnpackedBytes?: number
  maxFileBytes?: number
  maxCompressionRatio?: number
}

export interface TarEntry {
  path: string
  type: 'file' | 'directory' | 'symlink' | 'hardlink'
  mode: number
  size: number
  digest: string
  contents?: Buffer
  linkTarget?: string
}

export interface ParsedNpmTarball {
  entries: TarEntry[]
  findings: Finding[]
  compressedBytes: number
  unpackedBytes: number
  treeDigest: string
}

function finding(
  code: string,
  severity: Finding['severity'],
  summary: string,
  detail: string,
  evidence?: Finding['evidence'],
): Finding {
  const result: Finding = { code, severity, summary, detail }
  if (evidence !== undefined) result.evidence = evidence
  return result
}

function readString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return UTF8_DECODER.decode(slice.subarray(0, nul === -1 ? slice.length : nul))
}

function readOctal(buffer: Buffer, start: number, length: number, field: string): number {
  const slice = buffer.subarray(start, start + length)
  if ((slice[0] ?? 0) >= 0x80) throw new Error(`unsupported base-256 tar ${field}`)
  const value = slice.toString('ascii').replace(/\0.*$/s, '').trim()
  if (value === '') return 0
  if (!/^[0-7]+$/.test(value)) throw new Error(`invalid octal tar ${field}`)
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe tar ${field}`)
  return parsed
}

function verifyHeaderChecksum(header: Buffer): void {
  const expected = readOctal(header, 148, 8, 'checksum')
  let actual = 0
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
  }
  if (actual !== expected) throw new Error(`tar header checksum mismatch: expected ${expected}, got ${actual}`)
}

function parsePax(contents: Buffer): Record<string, string> {
  const values: Record<string, string> = {}
  let offset = 0
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset)
    if (space === -1) throw new Error('invalid PAX record length')
    const lengthText = contents.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('invalid PAX record length')
    const length = Number.parseInt(lengthText, 10)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > contents.length || length <= space - offset + 2) {
      throw new Error('PAX record exceeds archive bounds')
    }
    const record = UTF8_DECODER.decode(contents.subarray(space + 1, end - 1))
    const equals = record.indexOf('=')
    if (equals <= 0) throw new Error('invalid PAX key/value record')
    values[record.slice(0, equals)] = record.slice(equals + 1)
    offset = end
  }
  return values
}

function pathIssue(rawPath: string): string | undefined {
  if (rawPath.includes('\0')) return 'contains a NUL byte'
  if (/[\u0001-\u001f\u007f-\u009f]/.test(rawPath)) return 'contains a control character'
  if (Buffer.byteLength(rawPath) > MAX_PATH_BYTES) return 'exceeds the path length budget'
  if (rawPath.includes('\\')) return 'contains a backslash'
  if (rawPath.includes('//')) return 'contains an empty path segment'
  if (/[<>:"|?*]/.test(rawPath)) return 'contains a platform-reserved path character'
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) return 'is absolute'
  const segments = rawPath.split('/')
  if (segments.some(segment => Buffer.byteLength(segment) > MAX_PATH_SEGMENT_BYTES)) return 'contains an oversized path segment'
  if (segments.some(segment => segment === '..')) return 'contains a parent traversal segment'
  if (segments.some(segment => segment.endsWith(' ') || segment.endsWith('.'))) return 'has a platform-ambiguous trailing character'
  if (segments.some(segment => WINDOWS_RESERVED.test(segment))) return 'contains a Windows reserved path segment'
  return undefined
}

function normalizeNpmPath(rawPath: string, expectedRoot?: string): { path?: string; root?: string; issue?: string } {
  const issue = pathIssue(rawPath)
  if (issue !== undefined) return { issue }
  const segments = rawPath.split('/').filter(segment => segment !== '' && segment !== '.')
  const root = segments[0]
  if (root === undefined) return { issue: 'has no top-level archive directory' }
  if (expectedRoot !== undefined && root !== expectedRoot) {
    return { issue: `uses top-level directory ${root} instead of ${expectedRoot}` }
  }
  return { path: segments.slice(1).join('/'), root }
}

function linkEscapesPackage(entryPath: string, rawTarget: string): boolean {
  if (Buffer.byteLength(rawTarget) > MAX_PATH_BYTES) return true
  if (rawTarget.includes('\0') || rawTarget.includes('\\') || rawTarget.startsWith('/') || /^[A-Za-z]:/.test(rawTarget)) return true
  const base = entryPath.split('/').slice(0, -1)
  const stack = [...base]
  for (const segment of rawTarget.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment.endsWith(' ') || segment.endsWith('.') || WINDOWS_RESERVED.test(segment)) return true
    if (segment === '..') {
      if (stack.length === 0) return true
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return false
}

function treeDigest(entries: readonly TarEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.type)
    hash.update('\0')
    hash.update(entry.digest)
    hash.update('\0')
    hash.update(String(entry.mode & 0o777))
    hash.update('\n')
  }
  return `sha256:${hash.digest('hex')}`
}

function inspectPathTopology(entries: readonly TarEntry[], addFinding: (finding: Finding) => void): void {
  const byPortablePath = new Map(entries.map(entry => [entry.path.normalize('NFC').toLowerCase(), entry]))
  const reported = new Set<string>()
  for (const entry of entries) {
    const segments = entry.path.normalize('NFC').toLowerCase().split('/')
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = byPortablePath.get(segments.slice(0, length).join('/'))
      if (ancestor === undefined || ancestor.type === 'directory') continue
      const key = `${ancestor.path}\0${entry.path}`
      if (reported.has(key)) continue
      reported.add(key)
      addFinding(finding(
        'archive-path-topology-conflict',
        'critical',
        `Archive path is nested below a non-directory: ${entry.path}`,
        'File/link and child-path conflicts materialize inconsistently and can redirect writes across package managers.',
        { path: entry.path, ancestor: ancestor.path, ancestorType: ancestor.type },
      ))
    }
  }
}

export function parseNpmTarball(compressed: Buffer, options: TarOptions = {}): ParsedNpmTarball {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxUnpackedBytes = options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxCompressionRatio = options.maxCompressionRatio ?? 200
  if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new Error('npm artifact is not a gzip-compressed tarball')
  }

  let archive: Buffer
  try {
    archive = gunzipSync(compressed, { maxOutputLength: maxUnpackedBytes + TAR_BLOCK * 4 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`unable to decompress npm artifact within budget: ${message}`)
  }

  const findings: Finding[] = []
  let omittedFindings = 0
  const addFinding = (candidate: Finding): void => {
    if (findings.length < MAX_REPORTED_FINDINGS) {
      findings.push(candidate)
      return
    }
    omittedFindings += 1
    let lowestIndex = 0
    for (let index = 1; index < findings.length; index += 1) {
      if (SEVERITY_RANK[findings[index]?.severity ?? 'info'] < SEVERITY_RANK[findings[lowestIndex]?.severity ?? 'info']) {
        lowestIndex = index
      }
    }
    if (SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[findings[lowestIndex]?.severity ?? 'info']) {
      findings[lowestIndex] = candidate
    }
  }
  if (archive.length > compressed.length * maxCompressionRatio + 1024 * 1024) {
    addFinding(finding(
      'archive-suspicious-compression-ratio',
      'critical',
      'Archive expansion ratio exceeds policy',
      'The compressed artifact expands far beyond its download size and may be intended to exhaust scanner resources.',
      { compressedBytes: compressed.length, unpackedBytes: archive.length, maxCompressionRatio },
    ))
  }

  const entries: TarEntry[] = []
  const exactPaths = new Set<string>()
  const portablePaths = new Map<string, string>()
  let offset = 0
  let pendingPax: Record<string, string> = {}
  let globalPax: Record<string, string> = {}
  let pendingLongName: string | undefined
  let pendingLongLink: string | undefined
  let archiveRoot: string | undefined
  let headerCount = 0
  let budgetBytes = 0
  let fileBytes = 0

  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK)
    if (header.every(byte => byte === 0)) break
    headerCount += 1
    if (headerCount > maxEntries) throw new Error(`tar entry count exceeds ${maxEntries}`)
    verifyHeaderChecksum(header)

    const headerSize = readOctal(header, 124, 12, 'size')
    if (headerSize > maxFileBytes) throw new Error('tar entry exceeds per-entry budget')
    budgetBytes += headerSize
    if (budgetBytes > maxUnpackedBytes) throw new Error(`tar contents exceed ${maxUnpackedBytes} bytes`)
    const contentStart = offset + TAR_BLOCK
    const contentEnd = contentStart + headerSize
    if (contentEnd > archive.length) throw new Error('tar entry exceeds archive bounds')
    const paddedSize = Math.ceil(headerSize / TAR_BLOCK) * TAR_BLOCK
    const nextOffset = contentStart + paddedSize
    if (nextOffset > archive.length) throw new Error('tar padding exceeds archive bounds')

    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const contents = archive.subarray(contentStart, contentEnd)
    const headerName = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const combinedHeaderName = prefix === '' ? headerName : `${prefix}/${headerName}`

    if (typeFlag === 'x' || typeFlag === 'g') {
      const parsed = parsePax(contents)
      if (parsed.size !== undefined) throw new Error('unsupported PAX size override')
      if (typeFlag === 'g') globalPax = { ...globalPax, ...parsed }
      else pendingPax = parsed
      offset = nextOffset
      continue
    }
    if (typeFlag === 'L' || typeFlag === 'K') {
      const value = UTF8_DECODER.decode(contents).replace(/\0.*$/s, '').replace(/\n$/, '')
      if (typeFlag === 'L') pendingLongName = value
      else pendingLongLink = value
      offset = nextOffset
      continue
    }

    const pax = { ...globalPax, ...pendingPax }
    const rawPath = pax.path ?? pendingLongName ?? combinedHeaderName
    const rawLink = pax.linkpath ?? pendingLongLink ?? readString(header, 157, 100)
    pendingPax = {}
    pendingLongName = undefined
    pendingLongLink = undefined

    const normalized = normalizeNpmPath(rawPath, archiveRoot)
    if (normalized.path === undefined) {
      addFinding(finding(
        'archive-unsafe-path',
        'critical',
        `Unsafe archive path: ${rawPath.slice(0, 1_024)}`,
        `The entry ${normalized.issue ?? 'cannot be normalized safely'}.`,
        { path: rawPath.slice(0, 1_024) },
      ))
      offset = nextOffset
      continue
    }
    archiveRoot ??= normalized.root
    const entryPath = normalized.path
    if (entryPath === '') {
      if (typeFlag !== '5') {
        addFinding(finding(
          'archive-invalid-root-entry',
          'critical',
          'Archive package root is not a directory',
          'Only a directory entry may represent the top-level archive root.',
          { path: rawPath.slice(0, 1_024), typeFlag },
        ))
      }
      offset = nextOffset
      continue
    }

    const portableKey = entryPath.normalize('NFC').toLowerCase()
    const existingPortable = portablePaths.get(portableKey)
    if (exactPaths.has(entryPath) || (existingPortable !== undefined && existingPortable !== entryPath)) {
      addFinding(finding(
        'archive-path-collision',
        'critical',
        `Archive path collides with another entry: ${entryPath}`,
        'Duplicate or case/Unicode-colliding paths can materialize differently across filesystems.',
        { path: entryPath, collidesWith: existingPortable ?? entryPath },
      ))
      offset = nextOffset
      continue
    }
    exactPaths.add(entryPath)
    portablePaths.set(portableKey, entryPath)

    const mode = readOctal(header, 100, 8, 'mode')
    const regularFile = typeFlag === '\0' || typeFlag === '0' || typeFlag === '7'
    if (regularFile) {
      fileBytes += headerSize
      const digest = createHash('sha256').update(contents).digest('hex')
      entries.push({ path: entryPath, type: 'file', mode, size: headerSize, digest, contents: Buffer.from(contents) })
    } else if (typeFlag === '5') {
      const digest = createHash('sha256').update('directory').digest('hex')
      entries.push({ path: entryPath, type: 'directory', mode, size: 0, digest })
    } else if (typeFlag === '2' || typeFlag === '1') {
      const escapes = linkEscapesPackage(entryPath, rawLink)
      const linkType = typeFlag === '2' ? 'symlink' : 'hardlink'
      addFinding(finding(
        escapes ? 'archive-link-escapes-package' : 'archive-link-present',
        escapes ? 'critical' : 'medium',
        escapes ? `Archive ${linkType} escapes the package root` : `Archive contains a ${linkType}`,
        escapes
          ? 'Materializing this link could access or overwrite content outside the reviewed package.'
          : 'Links require review because materialization differs across package managers and platforms.',
        { path: entryPath, target: rawLink.slice(0, 1_024), linkType },
      ))
      const digest = createHash('sha256').update(`${linkType}:${rawLink}`).digest('hex')
      entries.push({ path: entryPath, type: linkType, mode, size: 0, digest, linkTarget: rawLink.slice(0, MAX_PATH_BYTES) })
    } else {
      addFinding(finding(
        'archive-special-entry',
        'critical',
        `Archive contains unsupported entry type ${JSON.stringify(typeFlag)}`,
        'Device, FIFO and unknown tar entry types are not safe to materialize during plugin review.',
        { path: entryPath, typeFlag },
      ))
    }

    offset = nextOffset
  }

  inspectPathTopology(entries, addFinding)
  if (omittedFindings > 0) {
    findings.push(finding(
      'archive-findings-truncated',
      'high',
      'Additional archive findings were omitted',
      'The report retained the highest-severity archive findings within its output budget.',
      { omittedFindings, retainedFindings: findings.length },
    ))
  }

  return {
    entries,
    findings,
    compressedBytes: compressed.length,
    unpackedBytes: fileBytes,
    treeDigest: treeDigest(entries),
  }
}
