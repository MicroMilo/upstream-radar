#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareFindings, FINDING_WATCH_SCHEMA, normalizeFindings } from '../dist/src/finding-watch.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_SCHEMA = 'upstream-radar.finding-watch-state/v1alpha1'
const REPORT_SCHEMA = 'upstream-radar.finding-watch-report/v1alpha1'
const MAX_TARGETS = 50
const MAX_CONFIG_BYTES = 256 * 1024
const MAX_STATE_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_CONCURRENCY = 2
const ACCEPTED_SCAN_EXIT_CODES = new Set([0, 2])

function pathFromRoot(value) {
  return isAbsolute(value) ? value : resolve(ROOT, value)
}

function parseArgs(argv) {
  const values = {
    config: 'examples/dsh/finding-watch/targets.json',
    state: 'examples/dsh/finding-watch/state.json',
    report: 'examples/dsh/finding-watch/report.md',
    jsonReport: 'examples/dsh/finding-watch/report.json',
    concurrency: Number(process.env.FINDING_WATCH_CONCURRENCY ?? DEFAULT_CONCURRENCY),
    timeoutMs: Number(process.env.FINDING_WATCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    quiet: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--quiet') {
      values.quiet = true
      continue
    }
    const rawKey = argument.startsWith('--') ? argument.slice(2) : undefined
    const key = rawKey === 'json-report' ? 'jsonReport' : rawKey === 'timeout-ms' ? 'timeoutMs' : rawKey
    if (key === undefined || !(key in values) || key === 'quiet') throw new Error(`unknown argument: ${argument}`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${key}`)
    index += 1
    if (key === 'concurrency' || key === 'timeoutMs') values[key] = Number(next)
    else values[key] = next
  }
  values.concurrency = Math.max(1, Math.min(8, Number.isFinite(values.concurrency) ? Math.floor(values.concurrency) : DEFAULT_CONCURRENCY))
  values.timeoutMs = Math.max(5_000, Math.min(600_000, Number.isFinite(values.timeoutMs) ? Math.floor(values.timeoutMs) : DEFAULT_TIMEOUT_MS))
  return values
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function safeText(value, maxLength = 2_048) {
  const secrets = [process.env.GITHUB_TOKEN, process.env.NPM_TOKEN, process.env.ISSUE_LOCATOR_LLM_API_KEY].filter(item => typeof item === 'string' && item !== '')
  let text = String(value ?? '')
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]')
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`).slice(-maxLength)
}

async function readJson(path, maxBytes, missingValue) {
  try {
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`${relative(ROOT, path)} is larger than ${maxBytes} bytes`)
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return missingValue
    throw new Error(`cannot read ${relative(ROOT, path)}: ${safeText(error.message ?? error)}`)
  }
}

async function writeIfChanged(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`
  return writeTextIfChanged(path, next)
}

async function writeTextIfChanged(path, next) {
  let previous
  try {
    previous = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (previous === next) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, next)
  return true
}

function parseJsonOutput(stdout, label) {
  const text = stdout.trim()
  if (text === '') throw new Error(`${label} returned no JSON`)
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // Fall through to the bounded error below.
      }
    }
    throw new Error(`${label} returned invalid JSON`)
  }
}

function runCli(args, timeoutMs) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [join(ROOT, 'dist/src/cli.js'), ...args], {
      cwd: ROOT,
      // Node's fetch does not use HTTP(S)_PROXY/SOCKS proxy variables unless
      // this opt-in is present. In a developer environment that can make a
      // reachable npm registry look like an unknown artifact.
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputOverflow = false
    let timedOut = false
    let timer
    const append = (current, chunk) => {
      const next = `${current}${String(chunk)}`
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        outputOverflow = true
        return next.slice(0, MAX_OUTPUT_BYTES)
      }
      return next
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolveRun({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut, outputOverflow })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolveRun({ code: code ?? 1, stdout, stderr, timedOut, outputOverflow })
    })
  })
}

function transientFailure(result) {
  if (result.timedOut) return true
  const text = `${result.stderr}\n${result.stdout}`
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|HTTP 5\d\d/i.test(text)
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

async function runCliWithRetry(args, timeoutMs, attempts = 3) {
  let result
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await runCli(args, timeoutMs)
    if (!transientFailure(result) || attempt === attempts) return result
    await delay(500 * attempt)
  }
  return result
}

function validateConfig(input) {
  if (!isRecord(input) || input.schema !== FINDING_WATCH_SCHEMA || !Array.isArray(input.targets)) {
    throw new Error(`config must use ${FINDING_WATCH_SCHEMA}`)
  }
  if (input.targets.length === 0 || input.targets.length > MAX_TARGETS) throw new Error(`config must contain 1-${MAX_TARGETS} targets`)
  const ids = new Set()
  return input.targets.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`target ${index + 1} is not an object`)
    const id = stringValue(raw.id)
    const repository = stringValue(raw.repository)
    const packageName = stringValue(raw.package)
    const watch = Array.isArray(raw.watch) ? raw.watch.filter(item => typeof item === 'string' && item !== '') : []
    if (id === undefined || repository === undefined || packageName === undefined || watch.length === 0) {
      throw new Error(`target ${index + 1} needs id, repository, package and watch`)
    }
    if (ids.has(id)) throw new Error(`duplicate target id: ${id}`)
    ids.add(id)
    return { id, repository, packageName, watch: [...new Set(watch)] }
  })
}

function validateState(input) {
  if (input === undefined) return { schema: STATE_SCHEMA, targets: {} }
  if (!isRecord(input) || input.schema !== STATE_SCHEMA || !isRecord(input.targets)) throw new Error(`state must use ${STATE_SCHEMA}`)
  return input
}

function reportTarget(report) {
  if (!isRecord(report) || !isRecord(report.target) || !Array.isArray(report.findings)) throw new Error('scan output has no target or findings array')
  const target = report.target
  const name = stringValue(target.name)
  const version = stringValue(target.version)
  if (name === undefined || version === undefined) throw new Error('scan output has no exact target name/version')
  return {
    name,
    version,
    digest: stringValue(target.artifactDigest),
    spec: stringValue(target.spec),
    findings: report.findings,
  }
}

function errorFromRun(label, result) {
  const suffix = result.timedOut ? `timed out after ${result.timeoutMs ?? 'the configured limit'}ms` : `exit ${result.code}`
  const output = result.stderr.trim() || result.stdout.trim().slice(-1_000)
  return safeText(`${label}: ${suffix}${output === '' ? '' : ` — ${output}`}`)
}

async function observeTarget(target, timeoutMs) {
  const sourceResult = await runCliWithRetry(['scan', `https://github.com/${target.repository}`, '--json'], timeoutMs)
  let source
  let sourceError
  if (!ACCEPTED_SCAN_EXIT_CODES.has(sourceResult.code) || sourceResult.timedOut || sourceResult.outputOverflow) {
    sourceError = errorFromRun(`${target.id} source scan`, { ...sourceResult, timeoutMs })
  } else {
    try {
      const parsed = reportTarget(parseJsonOutput(sourceResult.stdout, `${target.id} source scan`))
      source = {
        available: true,
        name: parsed.name,
        version: parsed.version,
        digest: parsed.digest,
        findings: normalizeFindings(parsed.findings, target.watch),
      }
    } catch (error) {
      sourceError = safeText(`${target.id} source scan: ${error.message ?? error}`)
    }
  }

  let artifact
  let artifactError
  if (source === undefined) {
    artifactError = 'not attempted because the source scan is unknown'
  } else {
    const spec = `npm:${target.packageName}@${source.version}`
    const artifactResult = await runCliWithRetry(['inspect', spec, '--deep', '--json'], timeoutMs)
    if (!ACCEPTED_SCAN_EXIT_CODES.has(artifactResult.code) || artifactResult.timedOut || artifactResult.outputOverflow) {
      artifactError = errorFromRun(`${target.id} artifact review`, { ...artifactResult, timeoutMs })
    } else {
      try {
        const parsed = reportTarget(parseJsonOutput(artifactResult.stdout, `${target.id} artifact review`))
        artifact = {
          available: true,
          spec: stringValue(parsed.spec) ?? spec,
          name: parsed.name,
          version: parsed.version,
          digest: parsed.digest,
          findings: normalizeFindings(parsed.findings, target.watch),
        }
      } catch (error) {
        artifactError = safeText(`${target.id} artifact review: ${error.message ?? error}`)
      }
    }
  }
  return {
    target,
    source: source ?? { available: false, error: sourceError ?? 'source scan is unknown' },
    artifact: artifact ?? { available: false, error: artifactError ?? 'artifact review is unknown' },
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = []
  let next = 0
  async function consume() {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume))
  return results
}

function compactSource(source) {
  if (!source?.available) return undefined
  return {
    name: source.name,
    version: source.version,
    ...(source.digest === undefined ? {} : { digest: source.digest }),
    findings: source.findings,
  }
}

function compactArtifact(artifact) {
  if (!artifact?.available) return undefined
  return {
    spec: artifact.spec,
    name: artifact.name,
    version: artifact.version,
    ...(artifact.digest === undefined ? {} : { digest: artifact.digest }),
    findings: artifact.findings,
  }
}

function identityChanged(previous, current, keys) {
  if (!previous || !current) return false
  return keys.some(key => previous[key] !== current[key])
}

function partResult(current, previous, watch, kind) {
  const currentAvailable = current.available === true
  const previousPart = previous?.[kind]
  const currentPart = currentAvailable ? (kind === 'source' ? compactSource(current) : compactArtifact(current)) : undefined
  const comparable = currentPart !== undefined && previousPart !== undefined
  let delta
  let identity = false
  if (comparable) {
    delta = compareFindings(previousPart.findings, currentPart.findings, watch)
    identity = kind === 'source'
      ? identityChanged(previousPart, currentPart, ['name', 'version', 'digest'])
      : identityChanged(previousPart, currentPart, ['spec', 'name', 'version', 'digest'])
  }
  const changed = comparable && (identity || delta.changed)
  return {
    status: !currentAvailable ? 'unknown' : !comparable ? 'baseline' : changed ? 'changed' : 'unchanged',
    ...(currentPart === undefined ? {} : currentPart),
    ...(delta === undefined ? {} : { transitions: delta.transitions }),
    ...(identity ? { identityChanged: true } : {}),
    ...(currentAvailable ? {} : { error: current.error ?? `${kind} observation is unknown` }),
    changed,
  }
}

function activeFindings(part) {
  return Array.isArray(part?.findings) ? part.findings : []
}

function stateEntry(observed, previous) {
  const target = observed.target
  const source = compactSource(observed.source) ?? previous?.source
  const artifact = compactArtifact(observed.artifact) ?? previous?.artifact
  return {
    id: target.id,
    repository: target.repository,
    package: target.packageName,
    watch: target.watch,
    ...(source === undefined ? {} : { source }),
    ...(artifact === undefined ? {} : { artifact }),
  }
}

function transitionCounts(targets) {
  const counts = { added: 0, resolved: 0, changed: 0, persisting: 0 }
  for (const target of targets) {
    for (const part of [target.source, target.artifact]) {
      for (const transition of part.transitions ?? []) counts[transition.status] += 1
    }
  }
  return counts
}

function markdownEvidence(value) {
  if (value === undefined) return ''
  const text = JSON.stringify(value)
  return text.length > 700 ? `${text.slice(0, 697)}...` : text
}

function groupedFindings(findings) {
  const groups = new Map()
  for (const finding of findings) {
    const group = groups.get(finding.code) ?? []
    group.push(finding)
    groups.set(finding.code, group)
  }
  return [...groups.values()].sort((left, right) => left[0].code.localeCompare(right[0].code))
}

function coordinate(part, artifact = false) {
  if (!part || part.status === 'unknown') return 'unknown'
  if (artifact) return part.spec ?? `${part.name ?? 'unknown'}@${part.version ?? 'unknown'}`
  return `${part.name ?? 'unknown'}@${part.version ?? 'unknown'}`
}

function renderMarkdown(result) {
  const lines = [
    '# DSH known finding watch',
    '',
    `Checked: ${result.checkedAt}`,
    '',
    'This report watches previously reported supply-chain findings on both the public source repository and the exact npm artifact. `unknown` means the check could not establish a current result; it is never treated as `resolved`.',
    '',
    '## Summary',
    '',
    `- targets: ${result.summary.targets}`,
    `- baseline: ${result.summary.baseline}`,
    `- changed: ${result.summary.changed}`,
    `- unchanged: ${result.summary.unchanged}`,
    `- unknown: ${result.summary.unknown}`,
    `- transitions: ${JSON.stringify(result.summary.transitions)}`,
    '',
    '## Current status',
    '',
    '| Plugin | Overall | Source | Exact npm artifact |',
    '| --- | --- | --- | --- |',
  ]
  for (const target of result.targets) {
    lines.push(`| [${target.id}](https://github.com/${target.repository}) | ${target.status} | ${target.source.status}: ${coordinate(target.source)} | ${target.artifact.status}: ${coordinate(target.artifact, true)} |`)
  }
  lines.push('', '## Details', '')
  for (const target of result.targets) {
    lines.push(`### ${target.id}`, '', `- repository: https://github.com/${target.repository}`, `- overall: **${target.status}**`, `- source: ${target.source.status} — ${coordinate(target.source)}`, `- exact npm artifact: ${target.artifact.status} — ${coordinate(target.artifact, true)}`)
    for (const [label, part] of [['source', target.source], ['artifact', target.artifact]]) {
      if (part.error) lines.push(`- ${label} error: ${part.error}`)
      if (part.identityChanged) lines.push(`- ${label} identity changed since the previous trusted observation`)
      const transitions = (part.transitions ?? []).filter(item => item.status !== 'persisting')
      for (const transition of transitions) lines.push(`- ${label} transition: \`${transition.code}\` **${transition.status}** (${transition.previousCount} → ${transition.currentCount})`)
      const findings = activeFindings(part)
      if (findings.length === 0 && part.status !== 'unknown') lines.push(`- ${label} active watched findings: none`)
      for (const group of groupedFindings(findings)) {
        const first = group[0]
        lines.push(`- ${label} active finding: \`${first.code}\` (${first.severity}) × ${group.length} — ${first.detail ?? first.summary}`)
        for (const finding of group.slice(0, 3)) {
          const evidence = markdownEvidence(finding.evidence)
          if (evidence !== '') lines.push(`  - evidence: \`${evidence}\``)
        }
        if (group.length > 3) lines.push(`  - ${group.length - 3} more evidence records are in the machine report`)
      }
    }
    lines.push('')
  }
  lines.push('## Interpretation', '', 'These are bounded static and exact-artifact observations. An install script, native binary, missing provenance record, or floating dependency is not automatically malicious; each item tells the plugin author what to review or fix. A source fix can land before the npm artifact is republished, so the two sides remain separate.', '')
  return `${lines.join('\n').trimEnd()}\n`
}

const options = parseArgs(process.argv.slice(2))
const configPath = pathFromRoot(options.config)
const statePath = pathFromRoot(options.state)
const reportPath = pathFromRoot(options.report)
const jsonReportPath = options.jsonReport === undefined ? undefined : pathFromRoot(options.jsonReport)
const config = await readJson(configPath, MAX_CONFIG_BYTES)
const targets = validateConfig(config)
const previousState = validateState(await readJson(statePath, MAX_STATE_BYTES, undefined))
const observed = await mapWithConcurrency(targets, options.concurrency, target => observeTarget(target, options.timeoutMs))
const checkedAt = new Date().toISOString()
const reportTargets = []
const nextStateTargets = {}

for (const item of observed) {
  const previous = isRecord(previousState.targets[item.target.id]) ? previousState.targets[item.target.id] : undefined
  const source = partResult(item.source, previous, item.target.watch, 'source')
  const artifact = partResult(item.artifact, previous, item.target.watch, 'artifact')
  const hasUnknown = source.status === 'unknown' || artifact.status === 'unknown'
  const hasChange = source.changed || artifact.changed
  const hasPreviousComparableObservation = previous?.source !== undefined || previous?.artifact !== undefined
  const status = hasUnknown ? 'unknown' : hasChange ? 'changed' : hasPreviousComparableObservation ? 'unchanged' : 'baseline'
  const reportTargetValue = {
    id: item.target.id,
    repository: item.target.repository,
    package: item.target.packageName,
    watch: item.target.watch,
    status,
    source,
    artifact,
  }
  reportTargets.push(reportTargetValue)
  nextStateTargets[item.target.id] = stateEntry(item, previous)
}

const summary = {
  targets: reportTargets.length,
  baseline: reportTargets.filter(item => item.status === 'baseline').length,
  changed: reportTargets.filter(item => item.status === 'changed').length,
  unchanged: reportTargets.filter(item => item.status === 'unchanged').length,
  unknown: reportTargets.filter(item => item.status === 'unknown').length,
  transitions: transitionCounts(reportTargets),
}
const report = {
  schema: REPORT_SCHEMA,
  checkedAt,
  config: relative(ROOT, configPath),
  state: relative(ROOT, statePath),
  summary,
  targets: reportTargets,
}
const nextState = {
  schema: STATE_SCHEMA,
  targets: nextStateTargets,
}
const stateChanged = await writeIfChanged(statePath, nextState)
await writeTextIfChanged(reportPath, renderMarkdown(report))
if (jsonReportPath !== undefined) await writeIfChanged(jsonReportPath, report)

if (!options.quiet) {
  console.log(`DSH known finding watch: ${summary.targets} targets`)
  console.log(`  baseline=${summary.baseline} changed=${summary.changed} unchanged=${summary.unchanged} unknown=${summary.unknown}`)
  console.log(`  transitions=${JSON.stringify(summary.transitions)}`)
  console.log(`  state ${stateChanged ? 'updated' : 'unchanged'}: ${relative(ROOT, statePath)}`)
  console.log(`  report: ${relative(ROOT, reportPath)}`)
}
process.exitCode = summary.unknown > 0 ? 1 : 0
