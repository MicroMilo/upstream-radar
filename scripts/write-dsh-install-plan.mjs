#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { buildDshInstallPlan } from '../dist/src/dsh-install-plan.js'
import { emptyDshCompatibilityLedger } from '../dist/src/dsh-compatibility-ledger.js'

const MAX_INPUT_BYTES = 256 * 1024 * 1024

async function readJson(path) {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) throw new Error(`${path} exceeds ${MAX_INPUT_BYTES} bytes`)
  return JSON.parse(contents)
}

async function readOptionalJson(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDshCompatibilityLedger()
    throw error
  }
}

const [corpusPath, statePath, reportPath, ledgerPath] = process.argv.slice(2)
if (corpusPath === undefined || statePath === undefined || reportPath === undefined || ledgerPath === undefined) {
  throw new Error('usage: write-dsh-install-plan.mjs <targets.json> <observations.json> <observer-report.json> <compatibility-ledger.json>')
}

const plan = buildDshInstallPlan(
  await readJson(corpusPath),
  await readJson(statePath),
  await readJson(reportPath),
  await readOptionalJson(ledgerPath),
)
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)

if (process.env.GITHUB_OUTPUT !== undefined) {
  const outputs = [
    `run=${plan.run}`,
    `dsh_version=${plan.dshVersion ?? ''}`,
    `matrix=${JSON.stringify(plan.matrix)}`,
    `triggers=${JSON.stringify(plan.triggers)}`,
  ]
  await appendFile(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`, 'utf8')
}
