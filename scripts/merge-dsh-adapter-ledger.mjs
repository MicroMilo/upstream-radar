#!/usr/bin/env node
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { emptyDshAdapterLedger, mergeDshAdapterLedger, parseDshAdapterExpectedCase, parseDshAdapterLedger } from '../dist/src/dsh-adapter.js'

const [ledgerPath, matrixPath, reportsPath, summaryPath] = process.argv.slice(2)
if (!ledgerPath || !matrixPath || !reportsPath || !summaryPath || process.argv.length !== 6) {
  throw new Error('usage: merge-dsh-adapter-ledger.mjs <adapter-ledger> <expected-matrix> <reports-directory> <summary-json>')
}
async function json(path, maximum = 64 * 1024 * 1024) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maximum) throw new Error('adapter evidence is not a bounded regular file')
    const bytes = await handle.readFile()
    if (bytes.length !== metadata.size) throw new Error('adapter evidence changed while reading')
    return { value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length }
  } finally { await handle.close() }
}
async function save(path, value) {
  const destination = resolve(path), temporary = `${destination}.${randomUUID()}.tmp`
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error('adapter output exceeds its byte bound')
  await mkdir(dirname(destination), { recursive: true })
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(temporary, destination)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
const matrix = (await json(matrixPath)).value
if (!Array.isArray(matrix.include) || matrix.include.length > 256) throw new Error('adapter matrix must contain at most 256 cases')
const expected = matrix.include.map(parseDshAdapterExpectedCase)
const ids = new Set(expected.map(cell => cell.id))
if (ids.size !== expected.length) throw new Error('duplicate expected adapter case')
let ledger
try { ledger = parseDshAdapterLedger((await json(ledgerPath)).value) }
catch (error) { if (error.code !== 'ENOENT') throw error; ledger = emptyDshAdapterLedger() }
const rejected = [], reports = new Map(), accepted = [], missing = [], transitions = []
const message = error => String(error instanceof Error ? error.message : error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)
const binding = ({ reasons, ...cell }) => cell
let visited = 0, totalBytes = 0
async function visit(path, depth = 0) {
  if (depth > 4) throw new Error('adapter report directory exceeds its depth bound')
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (++visited > 2048) throw new Error('adapter report directory exceeds its entry bound')
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) { rejected.push('linked adapter evidence was not followed'); continue }
    if (entry.isDirectory()) { await visit(child, depth + 1); continue }
    if (!entry.isFile() || entry.name !== 'report.json') continue
    try {
      const { value, bytes } = await json(child, Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - totalBytes))
      totalBytes += bytes
      // Adapter reports contain runtime observations, not scheduler identities.
      // The no-secret job writes this separate contract before starting its container.
      const cell = parseDshAdapterExpectedCase((await json(join(path, 'case.json'), 64 * 1024)).value)
      const scheduled = expected.find(item => item.id === cell.id)
      if (!scheduled || !isDeepStrictEqual(binding(cell), binding(scheduled))) throw new Error('adapter report contract differs from its scheduled case')
      reports.set(cell.id, [...reports.get(cell.id) ?? [], value])
    } catch (error) { rejected.push(message(error)) }
  }
}
await visit(resolve(reportsPath))
for (const cell of expected) {
  const matching = reports.get(cell.id) ?? []
  if (matching.length !== 1) {
    missing.push(cell.id)
    if (matching.length > 1) rejected.push(`duplicate reports for ${cell.id}`)
    continue
  }
  try {
    const merged = mergeDshAdapterLedger(ledger, cell, matching[0])
    ledger = merged.ledger; transitions.push(...merged.transitions); accepted.push(cell.id)
  } catch (error) { rejected.push(`${cell.id}: ${message(error)}`); missing.push(cell.id) }
}
const summary = { accepted, missing, rejected, transitions }
await save(ledgerPath, ledger)
await save(summaryPath, summary)
process.stdout.write(`${JSON.stringify(summary)}\n`)
if (process.env.GITHUB_OUTPUT !== undefined) await appendFile(process.env.GITHUB_OUTPUT,
  `accepted=${accepted.length}\nmissing=${missing.length}\nrejected=${rejected.length}\n`, 'utf8')
if (missing.length || rejected.length) process.exitCode = 1
