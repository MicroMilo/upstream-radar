#!/usr/bin/env node

import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  buildDshDirectoryCompatibilityFeed,
  renderDshDirectoryCompatibilityFeed,
} from '../dist/src/dsh-directory-feed.js'

const MAX_JSON_BYTES = 64 * 1024 * 1024

async function readJson(path) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) throw new Error('feed input is not a bounded regular file')
    const contents = await handle.readFile()
    if (contents.length !== metadata.size) throw new Error('feed input changed while reading')
    return JSON.parse(contents.toString('utf8'))
  } finally { await handle.close() }
}

const [
  cohortPath,
  targetsPath,
  ledgerPath,
  jsonPath,
  markdownPath,
  observationsPath,
  surfaceLedgerPath,
  environmentRecommendationsPath,
  adapterLedgerPath,
  buildPlansPath,
] = process.argv.slice(2)
if ([cohortPath, targetsPath, ledgerPath, jsonPath, markdownPath].some(value => value === undefined) || process.argv.length > 12) {
  throw new Error('usage: write-dsh-directory-feed.mjs <cohort.json> <targets.json> <ledger.json> <feed.json> <feed.md> [observations.json] [surface-ledger.json] [environment-recommendations.json] [adapter-ledger.json] [build-plans.json]')
}

let adapterLedger
if (adapterLedgerPath !== undefined) {
  try { adapterLedger = await readJson(adapterLedgerPath) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

const feed = buildDshDirectoryCompatibilityFeed({
  cohort: await readJson(cohortPath),
  installTargets: await readJson(targetsPath),
  ledger: await readJson(ledgerPath),
  ...(observationsPath === undefined ? {} : { observations: await readJson(observationsPath) }),
  ...(surfaceLedgerPath === undefined ? {} : { surfaceLedger: await readJson(surfaceLedgerPath) }),
  ...(environmentRecommendationsPath === undefined
    ? {}
    : { environmentRecommendations: await readJson(environmentRecommendationsPath) }),
  ...(adapterLedger === undefined ? {} : { adapterLedger }),
  ...(buildPlansPath === undefined ? {} : { buildPlans: await readJson(buildPlansPath) }),
  generatedAt: new Date().toISOString(),
})

await mkdir(dirname(resolve(jsonPath)), { recursive: true })
await mkdir(dirname(resolve(markdownPath)), { recursive: true })
await writeFile(resolve(jsonPath), `${JSON.stringify(feed, null, 2)}\n`, 'utf8')
await writeFile(resolve(markdownPath), renderDshDirectoryCompatibilityFeed(feed), 'utf8')

process.stdout.write(`${JSON.stringify({
  feed: resolve(jsonPath),
  total: feed.summary.total,
  observedCompatible: feed.summary['observed-compatible'],
  observedIncompatible: feed.summary['observed-incompatible'],
  needsReview: feed.summary['needs-review'],
  updatePending: feed.summary['update-pending'],
  notObserved: feed.summary['not-observed'],
}, null, 2)}\n`)
