#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, mkdir, open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { emptyDshActiveTaskState, planDshActiveTasks } from '../dist/src/dsh-active-task-state.js'

const [targetsPath, observationsPath, observerReportPath, statePath] = process.argv.slice(2)
if ([targetsPath, observationsPath, observerReportPath, statePath].some(value => !value)) {
  throw new Error('usage: plan-dsh-active-tasks.mjs <install-targets.json> <observations.json> <observer-report.json> <task-state.json>')
}

async function readJson(path, maximum) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('active task planner input is not a bounded regular file')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

async function optionalState(path) {
  try { return await readJson(path, 2 * 1024 * 1024) }
  catch (error) { if (error.code === 'ENOENT') return emptyDshActiveTaskState(); throw error }
}

async function save(path, value) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() }
  finally { await file.close() }
  await rename(temporary, destination)
}

const [targets, observations, report, state] = await Promise.all([
  readJson(targetsPath, 2 * 1024 * 1024),
  readJson(observationsPath, 256 * 1024 * 1024),
  readJson(observerReportPath, 64 * 1024 * 1024),
  optionalState(statePath),
])
const plan = planDshActiveTasks(targets, observations, report, state)
await save(statePath, plan.state)
const matrix = JSON.stringify(plan.matrix)
if (Buffer.byteLength(matrix) > 64 * 1024) throw new Error('active task matrix exceeded its output bound')
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `run=${plan.matrix.include.length > 0}\nmatrix=${matrix}\n`, 'utf8')
}
process.stdout.write(`${JSON.stringify({ schema: 'upstream-radar.dsh-active-task-plan/v1alpha1',
  created: plan.created, deduplicated: plan.deduplicated, selected: plan.matrix.include.length,
  blocked: plan.blocked, matrix: plan.matrix }, null, 2)}\n`)
