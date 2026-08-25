#!/usr/bin/env node

import { appendFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  buildDshSurfaceIR,
  emptyDshSurfaceLedger,
  mergeDshSurfaceLedger,
  renderDshSurfaceLedgerMerge,
} from '../dist/src/dsh-surface.js'

const MAX_JSON_BYTES = 64 * 1024 * 1024
const MAX_REPORTS = 32

async function readJson(path) {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > MAX_JSON_BYTES) throw new Error(`${path} exceeds ${MAX_JSON_BYTES} bytes`)
  return JSON.parse(contents)
}

async function readOptionalLedger(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDshSurfaceLedger()
    throw error
  }
}

async function collectReportPaths(root) {
  const result = []
  async function visit(path) {
    if (result.length >= MAX_REPORTS) throw new Error(`surface report directory contains more than ${MAX_REPORTS} report files`)
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
      rejected.push(`${path}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512))
    }
  }
  return { reports, rejected }
}

const [ledgerPath, matrixPath, reportsPath, markdownPath, irPath] = process.argv.slice(2)
if (ledgerPath === undefined || matrixPath === undefined || reportsPath === undefined || markdownPath === undefined || irPath === undefined) {
  throw new Error('usage: merge-dsh-surface-ledger.mjs <surface-ledger.json> <surface-matrix.json> <reports-directory> <markdown-report.md> <surface-ir.json>')
}

const matrix = await readJson(matrixPath)
if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix) || !Array.isArray(matrix.include)) {
  throw new Error('surface matrix must be an object with an include array')
}
const inputs = await readReports(resolve(reportsPath))
const merged = mergeDshSurfaceLedger({
  ledger: await readOptionalLedger(ledgerPath),
  expected: matrix.include,
  reports: inputs.reports,
})
merged.rejectedReports.push(...inputs.rejected)
merged.rejectedReports.sort()

await Promise.all([
  mkdir(dirname(resolve(ledgerPath)), { recursive: true }),
  mkdir(dirname(resolve(markdownPath)), { recursive: true }),
  mkdir(dirname(resolve(irPath)), { recursive: true }),
])
await writeFile(resolve(ledgerPath), `${JSON.stringify(merged.ledger, null, 2)}\n`, 'utf8')
await writeFile(resolve(markdownPath), renderDshSurfaceLedgerMerge(merged), 'utf8')
const ir = buildDshSurfaceIR(merged.ledger)
await writeFile(resolve(irPath), `${JSON.stringify(ir, null, 2)}\n`, 'utf8')

const summary = {
  accepted: merged.acceptedCaseIds.length,
  missing: merged.missingCaseIds.length,
  rejected: merged.rejectedReports.length,
  actionable: merged.transitions.filter(item => item.status === 'new-incompatibility' || item.status === 'changed-incompatibility').length,
  cells: ir.cells.length,
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
  ].join('\n') + '\n', 'utf8')
}

if (summary.missing > 0 || summary.rejected > 0) {
  console.error(`Surface reconciliation is incomplete: ${summary.missing} scheduled report(s) missing, ${summary.rejected} report(s) rejected.`)
  process.exitCode = 1
}

