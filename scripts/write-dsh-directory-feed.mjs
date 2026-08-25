#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  buildDshDirectoryCompatibilityFeed,
  renderDshDirectoryCompatibilityFeed,
} from '../dist/src/dsh-directory-feed.js'

const MAX_JSON_BYTES = 64 * 1024 * 1024

async function readJson(path) {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > MAX_JSON_BYTES) throw new Error(`${path} exceeds ${MAX_JSON_BYTES} bytes`)
  return JSON.parse(contents)
}

const [cohortPath, targetsPath, ledgerPath, jsonPath, markdownPath, observationsPath] = process.argv.slice(2)
if ([cohortPath, targetsPath, ledgerPath, jsonPath, markdownPath].some(value => value === undefined)) {
  throw new Error('usage: write-dsh-directory-feed.mjs <cohort.json> <targets.json> <ledger.json> <feed.json> <feed.md> [observations.json]')
}

const feed = buildDshDirectoryCompatibilityFeed({
  cohort: await readJson(cohortPath),
  installTargets: await readJson(targetsPath),
  ledger: await readJson(ledgerPath),
  ...(observationsPath === undefined ? {} : { observations: await readJson(observationsPath) }),
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
