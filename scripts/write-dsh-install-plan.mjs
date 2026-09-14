#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { applyDshEnvironmentRecommendations } from '../dist/src/dsh-environment-recommendation.js'
import { buildDshInstallPlan } from '../dist/src/dsh-install-plan.js'
import { applyDshHeadlessAgentPlans } from '../dist/src/dsh-headless-agent-plan.js'
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

const [corpusPath, statePath, reportPath, ledgerPath, agentPlansPath, environmentRecommendationsPath] = process.argv.slice(2)
if (corpusPath === undefined || statePath === undefined || reportPath === undefined || ledgerPath === undefined) {
  throw new Error('usage: write-dsh-install-plan.mjs <targets.json> <observations.json> <observer-report.json> <compatibility-ledger.json> [agent-plans.json] [environment-recommendations.json]')
}

const ledger = await readOptionalJson(ledgerPath)
const state = await readJson(statePath)
const configuredCorpus = await readJson(corpusPath)
const environmentCorpus = environmentRecommendationsPath === undefined
  ? configuredCorpus
  : applyDshEnvironmentRecommendations(configuredCorpus, state, await readJson(environmentRecommendationsPath))
const corpus = agentPlansPath === undefined
  ? environmentCorpus
  : applyDshHeadlessAgentPlans(environmentCorpus, await readJson(agentPlansPath), ledger)
const plan = buildDshInstallPlan(
  corpus,
  state,
  await readJson(reportPath),
  ledger,
)
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)

if (process.env.GITHUB_STEP_SUMMARY !== undefined && plan.blocked.length > 0) {
  const inline = value => String(value).replace(/[\u0000-\u001f\u007f<>|`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_024)
  const lines = [
    '## DSH pre-execution coverage gaps',
    '',
    `- Blocked plugin targets: ${plan.blocked.length}`,
    ...plan.blocked.map(item => `- \`${inline(item.targetId)}\` (\`${inline(item.plugin)}\`): ${inline(item.reason)}`),
    '',
  ]
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), 'utf8')
}

if (process.env.GITHUB_OUTPUT !== undefined) {
  const outputs = [
    `run=${plan.run}`,
    `dsh_version=${plan.dshVersion ?? ''}`,
    `matrix=${JSON.stringify(plan.matrix)}`,
    `triggers=${JSON.stringify(plan.triggers)}`,
    `blocked=${JSON.stringify(plan.blocked)}`,
  ]
  await appendFile(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`, 'utf8')
}
