import { gzipSync } from 'node:zlib'

const BLOCK = 512

export interface TestTarEntry {
  path: string
  contents?: Buffer | string
  type?: 'file' | 'directory' | 'symlink' | 'hardlink' | 'pax'
  linkTarget?: string
  mode?: number
  headerSize?: number
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value)
  if (encoded.length > length) throw new Error(`test tar field too long: ${value}`)
  encoded.copy(target, offset)
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`
  writeText(target, offset, length, encoded)
}

function headerFor(entry: TestTarEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK)
  writeText(header, 0, 100, entry.path)
  writeOctal(header, 100, 8, entry.mode ?? 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  const type = entry.type ?? 'file'
  header[156] = type === 'file' ? 0x30 : type === 'directory' ? 0x35 : type === 'symlink' ? 0x32 : type === 'hardlink' ? 0x31 : 0x78
  if (entry.linkTarget !== undefined) writeText(header, 157, 100, entry.linkTarget)
  writeText(header, 257, 6, 'ustar\0')
  writeText(header, 263, 2, '00')
  let checksum = 0
  for (const byte of header) checksum += byte
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

export function makeTarball(entries: readonly TestTarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const type = entry.type ?? 'file'
    const contents = type === 'file' || type === 'pax'
      ? Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents ?? '')
      : Buffer.alloc(0)
    parts.push(headerFor(entry, entry.headerSize ?? contents.length), contents)
    const padding = (BLOCK - (contents.length % BLOCK)) % BLOCK
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(parts))
}
