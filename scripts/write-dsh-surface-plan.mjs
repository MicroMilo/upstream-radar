#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { buildDshSurfacePlan, emptyDshSurfaceLedger } from '../dist/src/dsh-surface.js'

const MAX_INPUT_BYTES = 64 * 1024 * 1024

async function readJson(path) {
  const contents = await readFile(resolve(path), 'utf8')
  if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) throw new Error(`${path} exceeds ${MAX_INPUT_BYTES} bytes`)
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

const [targetsPath, sourceLedgerPath, surfaceLedgerPath, agentPlansPath, surfaceAgentPlansPath] = process.argv.slice(2)
if (targetsPath === undefined || sourceLedgerPath === undefined || surfaceLedgerPath === undefined) {
  throw new Error('usage: write-dsh-surface-plan.mjs <surface-targets.json> <compatibility-ledger.json> <surface-ledger.json> [headless-agent-plans.json] [surface-agent-plans.json]')
}

const plan = buildDshSurfacePlan(
  await readJson(targetsPath),
  await readJson(sourceLedgerPath),
  await readOptionalLedger(surfaceLedgerPath),
  new Date(),
  ...(agentPlansPath === undefined ? [] : [
    await readJson(agentPlansPath),
    ...(surfaceAgentPlansPath === undefined ? [] : [await readJson(surfaceAgentPlansPath)]),
  ]),
)
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `run=${plan.run}`,
    `matrix=${JSON.stringify(plan.matrix)}`,
    `blocked=${JSON.stringify(plan.blocked)}`,
  ].join('\n') + '\n', 'utf8')
}
