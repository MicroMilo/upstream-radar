#!/usr/bin/env node

import { appendFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  emptyDshCompatibilityLedger,
  mergeDshCompatibilityLedger,
  renderDshCompatibilityLedgerMerge,
} from '../dist/src/dsh-compatibility-ledger.js'
import {
  buildDshCompatibilityIR,
  buildDshCompatibilityReverseIndex,
} from '../dist/src/dsh-compatibility-ir.js'

const MAX_JSON_BYTES = 64 * 1024 * 1024
const MAX_REPORTS = 100

async function readJson(path) {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > MAX_JSON_BYTES) throw new Error(`${path} exceeds ${MAX_JSON_BYTES} bytes`)
  return JSON.parse(contents)
}

async function readOptionalLedger(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDshCompatibilityLedger()
    throw error
  }
}

async function collectReportPaths(root) {
  const result = []
  async function visit(path) {
    if (result.length >= MAX_REPORTS) throw new Error(`report directory contains more than ${MAX_REPORTS} report files`)
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && entry.name === 'report.json') result.push(child)
    }
  }
  await visit(root)
  return result.sort()
}

async function readReports(root) {
  const reports = []
  const rejected = []
  for (const path of await collectReportPaths(root)) {
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) throw new Error('not a bounded regular JSON file')
      reports.push(await readJson(path))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rejected.push(`${path}: ${message.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 512)}`)
    }
  }
  return { reports, rejected }
}

const [ledgerPath, matrixPath, reportsPath, markdownPath, irPath, reverseIndexPath] = process.argv.slice(2)
if (ledgerPath === undefined || matrixPath === undefined || reportsPath === undefined || markdownPath === undefined
  || irPath === undefined || reverseIndexPath === undefined) {
  throw new Error('usage: merge-dsh-compatibility-ledger.mjs <compatibility-ledger.json> <install-matrix.json> <reports-directory> <markdown-report.md> <compatibility-ir.json> <compatibility-reverse-index.json>')
}

const matrix = await readJson(matrixPath)
if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix) || !Array.isArray(matrix.include)) {
  throw new Error('install matrix must be an object with an include array')
}
const inputs = await readReports(resolve(reportsPath))
const merged = mergeDshCompatibilityLedger({
  ledger: await readOptionalLedger(ledgerPath),
  expected: matrix.include,
  reports: inputs.reports,
})
merged.rejectedReports.push(...inputs.rejected)
merged.rejectedReports.sort()

await mkdir(dirname(resolve(ledgerPath)), { recursive: true })
await mkdir(dirname(resolve(markdownPath)), { recursive: true })
await mkdir(dirname(resolve(irPath)), { recursive: true })
await mkdir(dirname(resolve(reverseIndexPath)), { recursive: true })
await writeFile(resolve(ledgerPath), `${JSON.stringify(merged.ledger, null, 2)}\n`, 'utf8')
await writeFile(resolve(markdownPath), renderDshCompatibilityLedgerMerge(merged), 'utf8')
const ir = buildDshCompatibilityIR(merged.ledger)
const reverseIndex = buildDshCompatibilityReverseIndex(ir)
await writeFile(resolve(irPath), `${JSON.stringify(ir, null, 2)}\n`, 'utf8')
await writeFile(resolve(reverseIndexPath), `${JSON.stringify(reverseIndex, null, 2)}\n`, 'utf8')

const actionable = merged.transitions.filter(item => (
  item.status !== 'compatible' && item.status !== 'persisting-incompatibility'
)).length
const summary = {
  accepted: merged.acceptedCaseIds.length,
  missing: merged.missingCaseIds.length,
  rejected: merged.rejectedReports.length,
  actionable,
  cells: ir.cells.length,
  relations: ir.relations.length,
  dependencies: reverseIndex.dependencies.length,
  transitions: merged.transitions,
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `accepted=${summary.accepted}`,
    `missing=${summary.missing}`,
    `rejected=${summary.rejected}`,
    `actionable=${summary.actionable}`,
    `cells=${summary.cells}`,
    `relations=${summary.relations}`,
    `dependencies=${summary.dependencies}`,
  ].join('\n') + '\n', 'utf8')
}

if (summary.missing > 0 || summary.rejected > 0) {
  console.error(`Compatibility reconciliation is incomplete: ${summary.missing} scheduled report(s) missing, ${summary.rejected} report(s) rejected.`)
  process.exitCode = 1
}
