#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildReverseDependencyIndex, parseReverseDependencyObservations } from '../dist/src/dependency-index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INPUT = resolve(ROOT, 'examples/dsh/first-batch/targets.json')
const OUTPUT = resolve(ROOT, 'examples/dsh/first-batch')
const REPORTS = join(OUTPUT, 'reports')
const argv = new Set(process.argv.slice(2))
const concurrency = Math.max(1, Number(process.env.UPSTREAM_RADAR_BATCH_CONCURRENCY ?? 4))

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

function run(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(ROOT, 'dist/src/cli.js'), ...args], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => resolveRun({ code: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', code => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return JSON: ${result.stderr.trim().slice(-800)}`)
  }
}

function targetCoordinate(report) {
  const name = report?.target?.name
  const version = report?.target?.version
  return typeof name === 'string' && typeof version === 'string' && name !== '' && version !== ''
    ? `${name}@${version}`
    : undefined
}

function graphSummary(report) {
  const graph = report?.evidence?.npm?.dependencyAudit?.graph
    ?? report?.evidence?.dependencyGraph
    ?? report?.evidence?.npm?.dependencyGraph
  if (!graph) return undefined
  return {
    source: graph.source,
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
    unresolved: Array.isArray(graph.unresolved) ? graph.unresolved.length : 0,
  }
}

async function mapWithConcurrency(items, worker) {
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

const input = JSON.parse(await readFile(INPUT, 'utf8'))
if (!Array.isArray(input.targets) || input.targets.length !== 50) throw new Error('the first-batch target list must contain exactly 50 targets')
await mkdir(REPORTS, { recursive: true })

const sourceResults = await mapWithConcurrency(input.targets, async target => {
  const source = `https://github.com/${target.repository}`
  const result = await run(['scan', source, '--json'])
  const slug = safeSlug(target.id)
  if (result.stdout.trim() === '') {
    return { ...target, source, sourceStatus: 'error', sourceError: result.stderr.trim().slice(-2_048) }
  }
  try {
    const report = parseJsonOutput(result, `${target.id} source scan`)
    await writeFile(join(REPORTS, `${slug}.source.json`), `${JSON.stringify(report, null, 2)}\n`)
    return {
      ...target,
      source,
      sourceStatus: result.code === 0 || result.code === 2 ? 'scanned' : 'error',
      sourceVerdict: report.verdict,
      sourceCoordinate: targetCoordinate(report),
      sourceGraph: graphSummary(report),
      sourceError: result.code === 0 || result.code === 2 ? undefined : result.stderr.trim().slice(-2_048),
    }
  } catch (error) {
    return { ...target, source, sourceStatus: 'error', sourceError: String(error).slice(-2_048) }
  }
})

const publishedResults = await mapWithConcurrency(sourceResults, async item => {
  if (item.sourceCoordinate === undefined) return { ...item, artifactStatus: 'not-attempted' }
  const result = await run(['inspect', item.sourceCoordinate, '--deep', '--json'])
  if (result.stdout.trim() === '') return { ...item, artifactStatus: 'not-found', artifactError: result.stderr.trim().slice(-2_048) }
  try {
    const report = parseJsonOutput(result, `${item.id} artifact review`)
    const graph = graphSummary(report)
    const slug = safeSlug(item.id)
    await writeFile(join(REPORTS, `${slug}.artifact.json`), `${JSON.stringify(report, null, 2)}\n`)
    return {
      ...item,
      artifactStatus: graph === undefined ? 'reviewed-without-graph' : 'reviewed',
      artifactCoordinate: targetCoordinate(report),
      artifactVerdict: report.verdict,
      artifactGraph: graph,
      artifactError: result.code === 0 || result.code === 2 ? undefined : result.stderr.trim().slice(-2_048),
    }
  } catch (error) {
    return { ...item, artifactStatus: 'not-found', artifactError: String(error).slice(-2_048) }
  }
})

const observations = []
const usedReports = []
const skipped = []
for (const item of publishedResults) {
  const slug = safeSlug(item.id)
  const artifactPath = join(REPORTS, `${slug}.artifact.json`)
  const sourcePath = join(REPORTS, `${slug}.source.json`)
  let selectedPath
  if (item.artifactGraph !== undefined) selectedPath = artifactPath
  else if (item.sourceGraph !== undefined) selectedPath = sourcePath
  if (selectedPath === undefined) {
    skipped.push({ source: item.source, reason: 'no exact dependency graph was available from the source lockfile or same-version npm artifact' })
    continue
  }
  const report = JSON.parse(await readFile(selectedPath, 'utf8'))
  const parsed = parseReverseDependencyObservations(report, selectedPath)
  if (parsed.length === 0) {
    skipped.push({ source: selectedPath, reason: 'report did not contain a supported dependency graph observation' })
    continue
  }
  observations.push(...parsed)
  usedReports.push(selectedPath)
}

const index = buildReverseDependencyIndex(observations, {
  inputs: {
    files: usedReports.length,
    loadedFiles: usedReports.length,
    skipped,
  },
})
await writeFile(join(OUTPUT, 'reverse-dependency-index.json'), `${JSON.stringify(index, null, 2)}\n`)

const summary = {
  schema: 'upstream-radar.dsh-batch-result/v1alpha1',
  generatedAt: new Date().toISOString(),
  input: 'targets.json',
  targets: publishedResults,
  index: {
    observations: index.observations,
    plugins: index.plugins.length,
    dependencies: index.dependencies.length,
    completeObservations: index.coverage.completeObservations,
    incompleteObservations: index.coverage.incompleteObservations,
    unresolvedEdges: index.coverage.unresolvedEdges,
    skipped: index.inputs.skipped.length,
  },
}
await writeFile(join(OUTPUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const lines = [
  '# DSH first-batch real dependency graph',
  '',
  `Generated: ${summary.generatedAt}`,
  '',
  'This corpus is the first 50 entries selected from the awesome-dsh-plugin registry on 2026-08-17. Source scans never install dependencies or execute plugin code. When the source package name and version are available on npm, the exact published artifact is reviewed with lifecycle scripts disabled; its resolved graph is preferred for the reverse index.',
  '',
  '## Result',
  '',
  `- targets: ${input.targets.length}`,
  `- source scans: ${publishedResults.filter(item => item.sourceStatus === 'scanned').length}`,
  `- exact npm artifacts reviewed: ${publishedResults.filter(item => item.artifactStatus === 'reviewed' || item.artifactStatus === 'reviewed-without-graph').length}`,
  `- observations in reverse index: ${index.observations}`,
  `- plugins in reverse index: ${index.plugins.length}`,
  `- dependency coordinates in reverse index: ${index.dependencies.length}`,
  `- complete graphs: ${index.coverage.completeObservations}`,
  `- incomplete graphs: ${index.coverage.incompleteObservations}`,
  `- unresolved edges: ${index.coverage.unresolvedEdges}`,
  `- skipped from index: ${index.inputs.skipped.length}`,
  '',
  '## Per-target evidence',
  '',
  '| Plugin | Source graph | Exact npm graph | Index input |',
  '| --- | ---: | ---: | --- |',
]
for (const item of publishedResults) {
  const sourceGraph = item.sourceGraph === undefined ? '—' : `${item.sourceGraph.nodes} nodes / ${item.sourceGraph.edges} edges`
  const artifactGraph = item.artifactGraph === undefined ? '—' : `${item.artifactGraph.nodes} nodes / ${item.artifactGraph.edges} edges`
  const inputPath = usedReports.find(path => path.endsWith(`${safeSlug(item.id)}.artifact.json`))
    ?? usedReports.find(path => path.endsWith(`${safeSlug(item.id)}.source.json`))
  lines.push(`| [${item.id}](https://github.com/${item.repository}) | ${sourceGraph} | ${artifactGraph} | ${inputPath === undefined ? 'not indexed' : inputPath.replace(`${ROOT}/`, '')} |`)
}
lines.push('', '## Reproduce', '', '```bash', 'pnpm run refresh:dsh-batch', '```', '', 'The generated `reverse-dependency-index.json` is the input for the always-on observer. A missing graph is kept as a visible skipped target instead of being treated as a clean dependency result.', '')
await writeFile(join(OUTPUT, 'README.md'), `${lines.join('\n').trimEnd()}\n`)

if (!argv.has('--quiet')) {
  console.log(`DSH first batch: ${input.targets.length} targets`)
  console.log(`  source scans: ${publishedResults.filter(item => item.sourceStatus === 'scanned').length}`)
  console.log(`  exact npm artifacts: ${publishedResults.filter(item => item.artifactStatus === 'reviewed' || item.artifactStatus === 'reviewed-without-graph').length}`)
  console.log(`  reverse index: ${index.plugins.length} plugins, ${index.dependencies.length} dependencies, ${index.coverage.completeObservations} complete / ${index.coverage.incompleteObservations} incomplete`)
  console.log(`  skipped: ${index.inputs.skipped.length}`)
  console.log(`  report: ${join(OUTPUT, 'README.md')}`)
}
