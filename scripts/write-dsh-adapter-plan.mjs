#!/usr/bin/env node
import { constants } from 'node:fs'
import { appendFile, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyDshEnvironmentRecommendations } from '../dist/src/dsh-environment-recommendation.js'
import { applyDshHeadlessAgentPlans } from '../dist/src/dsh-headless-agent-plan.js'
import { buildDshInstallPlan, currentDshCompatibilitySources } from '../dist/src/dsh-install-plan.js'
import { emptyDshCompatibilityLedger, parseDshCompatibilityLedger } from '../dist/src/dsh-compatibility-ledger.js'
import { buildDshAdapterPlan, emptyDshAdapterLedger, parseDshAdapterLedger } from '../dist/src/dsh-adapter.js'

const [targetsPath, observationsPath, recommendationsPath, sourcesPath, ledgerPath, buildPlansPath] = process.argv.slice(2)
if (!targetsPath || !observationsPath || !recommendationsPath || !sourcesPath || !ledgerPath || process.argv.length > 8) {
  throw new Error('usage: write-dsh-adapter-plan.mjs <install-targets> <observations> <recommendations> <native-ledger> <adapter-ledger> [build-plans]')
}
async function json(path, absent) {
  let handle
  try {
    handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024) throw new Error('adapter planning input is not a bounded regular file')
    const bytes = await handle.readFile()
    if (bytes.length !== metadata.size) throw new Error('adapter planning input changed while reading')
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) { if (error.code === 'ENOENT' && absent !== undefined) return absent; throw error }
  finally { await handle?.close() }
}
const observations = await json(observationsPath)
const targets = applyDshEnvironmentRecommendations(await json(targetsPath), observations, await json(recommendationsPath))
const sources = parseDshCompatibilityLedger(await json(sourcesPath, emptyDshCompatibilityLedger()))
const effective = buildPlansPath === undefined ? targets : applyDshHeadlessAgentPlans(targets, await json(buildPlansPath), sources)
const now = new Date()
const desired = buildDshInstallPlan(effective, observations, { changes: [] }, emptyDshCompatibilityLedger(), now)
const current = currentDshCompatibilitySources(sources, desired.matrix.include, targets.refreshAfterHours, now)
const plan = buildDshAdapterPlan(targets, { ...current, entries: current.entries.filter(entry => entry.dshVersion === desired.dshVersion) },
  parseDshAdapterLedger(await json(ledgerPath, emptyDshAdapterLedger())), now)
if (plan.matrix.include.length > 256) throw new Error('adapter plan exceeds the 256-job workflow bound; narrow the configured cohort')
const result = { run: plan.matrix.include.length > 0, ...plan }
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (process.env.GITHUB_OUTPUT !== undefined) await appendFile(process.env.GITHUB_OUTPUT,
  `run=${result.run}\nmatrix=${JSON.stringify(plan.matrix)}\nblocked=${JSON.stringify(plan.blocked)}\n`, 'utf8')
