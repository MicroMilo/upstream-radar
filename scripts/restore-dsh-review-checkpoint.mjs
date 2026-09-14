#!/usr/bin/env node
import { execFile as callback } from 'node:child_process'
import { lstat, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(callback)
const [repository, branch, output] = process.argv.slice(2)
if (process.argv.length !== 5 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  || typeof branch !== 'string' || branch.length === 0 || branch.length > 256 || /[\u0000-\u001f\u007f]/.test(branch)
  || !output) throw new Error('restore requires a repository, branch and new output directory')
const maximumRuns = 100
const deadline = Date.now() + 180_000
async function gh(args) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('review checkpoint search exceeded its time bound')
  return (await execFile('gh', args, { timeout: Math.min(remaining, args[1] === 'download' ? 120_000 : 30_000), maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout
}
const runs = JSON.parse(await gh(['run', 'list', '--repo', repository, '--workflow', 'dsh-rebuild-validation.yml',
  '--branch', branch, '--status', 'completed', '--limit', String(maximumRuns), '--json', 'databaseId']))
if (!Array.isArray(runs) || runs.length > maximumRuns || runs.some(run => !Number.isSafeInteger(run.databaseId) || run.databaseId <= 0)) throw new Error('invalid bounded completed-run inventory')
let selected
const skipped = []
for (const run of runs) {
  const inventory = JSON.parse(await gh(['api', `repos/${repository}/actions/runs/${run.databaseId}/artifacts?per_page=100`]))
  if (!Array.isArray(inventory.artifacts) || inventory.artifacts.length > 100 || inventory.total_count !== inventory.artifacts.length) throw new Error('artifact inventory is incomplete; refusing to discard a possible checkpoint')
  const matches = inventory.artifacts.filter(artifact => artifact.name === 'dsh-rebuild-review')
  if (matches.length > 1 || matches.some(artifact => typeof artifact.expired !== 'boolean')) throw new Error('ambiguous review checkpoint inventory')
  if (matches[0]?.expired === false) { selected = run.databaseId; break }
  skipped.push(run.databaseId)
}
if (selected === undefined) {
  if (runs.length === maximumRuns) throw new Error('no review checkpoint was found within the bounded history; earlier state is unknown')
  console.log(JSON.stringify({ restored: false, skipped, reason: 'No retained review checkpoint exists in the completed workflow history.' }))
} else {
  const destination = resolve(output)
  try { await lstat(destination); throw new Error('checkpoint output already exists; refusing to overwrite it') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = await mkdtemp(join(dirname(destination), '.dsh-review-restore-'))
  let moved = false
  try {
    // A transport or extraction failure is not evidence that the artifact is
    // absent. Do not silently fall back to older state after selecting it.
    await gh(['run', 'download', String(selected), '--repo', repository, '--name', 'dsh-rebuild-review', '--dir', temporary])
    await rename(temporary, destination)
    moved = true
  } finally { if (!moved) await rm(temporary, { recursive: true, force: true }) }
  console.log(JSON.stringify({ restored: true, runId: selected, skipped, note: 'Current evidence fingerprints still determine review reuse.' }))
}
