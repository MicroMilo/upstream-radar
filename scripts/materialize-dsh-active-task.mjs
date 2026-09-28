#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  materializeDshActiveTaskInputs,
  planDshActiveTaskMaterialization,
} from '../dist/src/dsh-active-task-materialization.js'

const [statePath, taskId, inputFingerprint, targetsPath, observationsPath, exactObservationsPath, scopedTargetsPath] = process.argv.slice(2)
if ([statePath, taskId, inputFingerprint, targetsPath, observationsPath, exactObservationsPath, scopedTargetsPath]
  .some(value => value === undefined)) {
  throw new Error('usage: materialize-dsh-active-task.mjs <state.json> <task-id> <input-fingerprint> <targets.json> <current-observations.json> <exact-observations.json> <scoped-targets.json>')
}

const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024

async function readJson(path, maximum = MAX_JSON_BYTES) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error(`${path} is not a bounded regular file`)
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

async function boundedResponseText(response, maximum, label) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds its byte bound`)
  if (response.body === null) throw new Error(`${label} returned no body`)
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maximum) {
      await reader.cancel()
      throw new Error(`${label} exceeds its byte bound`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

async function fetchJson(url, label, headers = {}) {
  let failure
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'upstream-radar/active-task-materializer', ...headers },
        redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) {
        const error = new Error(`${label} returned HTTP ${response.status}`)
        if (response.status !== 429 && response.status < 500) throw error
        failure = error
      } else {
        const text = await boundedResponseText(response, MAX_MANIFEST_BYTES, label)
        return JSON.parse(text.replace(/^\uFEFF/, ''))
      }
    } catch (error) {
      failure = error
      if (error instanceof Error && /returned HTTP 4\d\d/.test(error.message)
        && !error.message.includes('HTTP 429')) throw error
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250))
  }
  throw new Error(`${label} failed after 3 attempts: ${failure instanceof Error ? failure.message : String(failure)}`)
}

async function registryManifest(coordinate, label) {
  const name = encodeURIComponent(coordinate.name)
  const version = encodeURIComponent(coordinate.version)
  return fetchJson(`https://registry.npmjs.org/${name}/${version}`, `${label} registry manifest`, {
    accept: 'application/vnd.npm.install-v1+json, application/json',
  })
}

async function sourceManifest(source, coordinate, label) {
  const path = source.packagePath.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const url = `https://raw.githubusercontent.com/${source.repository}/${coordinate.sourceCommit}/${path}`
  const headers = { accept: 'application/json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return fetchJson(url, `${label} source manifest`, headers)
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

const [state, targets, observations] = await Promise.all([
  readJson(statePath, 2 * 1024 * 1024), readJson(targetsPath), readJson(observationsPath),
])
const plan = planDshActiveTaskMaterialization(state, targets, observations, taskId, inputFingerprint)
const [pluginPublished, pluginSource, dshPublished, dshSource] = await Promise.all([
  registryManifest(plan.task.input.plugin, 'plugin'),
  sourceManifest(plan.pluginSource, plan.task.input.plugin, 'plugin'),
  registryManifest(plan.task.input.dsh, 'DSH'),
  sourceManifest(plan.dshSource, plan.task.input.dsh, 'DSH'),
])
const exact = materializeDshActiveTaskInputs(plan, {
  plugin: { sourceManifest: pluginSource, publishedManifest: pluginPublished },
  dsh: { sourceManifest: dshSource, publishedManifest: dshPublished },
})
await Promise.all([save(exactObservationsPath, exact.observations), save(scopedTargetsPath, exact.targets)])
process.stdout.write(`${JSON.stringify({ taskId: plan.task.id, inputFingerprint: plan.task.inputFingerprint,
  plugin: plan.task.input.plugin, dsh: plan.task.input.dsh, dshChannel: plan.task.dshChannel,
  exactInputMaterialized: true })}\n`)
