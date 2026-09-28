#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { compileDshActiveAgentPolicy } from '../dist/src/dsh-active-agent-policy.js'
import { parseObserverConfigText } from '../dist/src/upstream-observer.js'

const [policyPath, observerPath, installPath, outputObserverPath, outputInstallPath, receiptPath] = process.argv.slice(2)
if ([policyPath, observerPath, installPath, outputObserverPath, outputInstallPath, receiptPath].some(value => !value)) {
  throw new Error('usage: compile-dsh-active-policy.mjs <policy.json> <observer-targets.yml> <install-targets.json> <output-observer.json> <output-install.json> <receipt.json>')
}

async function read(path, maximum) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error(`${path} is not a bounded regular file`)
    return await file.readFile('utf8')
  } finally { await file.close() }
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

const [policyText, observerText, installText] = await Promise.all([
  read(policyPath, 256 * 1024), read(observerPath, 2 * 1024 * 1024), read(installPath, 2 * 1024 * 1024),
])
const policy = JSON.parse(policyText)
const observerTargets = parseObserverConfigText(observerText)
const installTargets = JSON.parse(installText)
const compiled = compileDshActiveAgentPolicy(policy, observerTargets, installTargets)
const configured = compiled.installTargets.plugins.filter(target => target.analysisPolicy !== undefined)
const receipt = {
  schema: 'upstream-radar.dsh-active-agent-policy-receipt/v1alpha1',
  fingerprint: compiled.fingerprint,
  dsh: compiled.policy.dsh,
  configuredPlugins: configured.map(target => ({ targetId: target.id, analysisPolicy: target.analysisPolicy })),
  agentInferredPlugins: compiled.installTargets.plugins.filter(target => target.analysisPolicy === undefined).map(target => target.id),
}
await Promise.all([
  save(outputObserverPath, compiled.observerTargets),
  save(outputInstallPath, compiled.installTargets),
  save(receiptPath, receipt),
])
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
