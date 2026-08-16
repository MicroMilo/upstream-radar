import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Set(process.argv.slice(2))

if (args.has('--help')) {
  console.log('Usage: node scripts/release-preflight.mjs [--json] [--published]')
  console.log('  --json       print a machine-readable report')
  console.log('  --published  also verify that this version is already available on npm')
  process.exit(0)
}

const unknownArgs = [...args].filter(arg => !['--json', '--published'].includes(arg))
if (unknownArgs.length > 0) {
  console.error(`Unknown option: ${unknownArgs.join(', ')}`)
  process.exit(1)
}

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const version = typeof packageJson.version === 'string' ? packageJson.version : ''
const checks = []

function pass(name, detail) {
  checks.push({ name, status: 'pass', detail })
}

function fail(name, detail) {
  checks.push({ name, status: 'fail', detail })
}

function isCrossSourceDemoReport(report) {
  const sources = report?.event?.advisory?.sources
  const conflicts = report?.event?.advisory?.conflicts
  const riskSignals = report?.event?.advisory?.riskSignals
  return report?.schema === 'upstream-radar.demo/v1alpha1'
    && report?.networkFree === true
    && Array.isArray(sources)
    && sources.includes('osv')
    && sources.includes('github-advisories')
    && Array.isArray(conflicts)
    && conflicts.some(conflict => conflict?.field === 'fixed-versions')
    && riskSignals?.cisaKev?.knownExploited === true
    && typeof riskSignals?.epss?.score === 'number'
    && riskSignals.epss.score >= 0 && riskSignals.epss.score <= 1
}

async function pathExists(relativePath) {
  try {
    await stat(resolve(root, relativePath))
    return true
  } catch {
    return false
  }
}

async function checkVersionFiles() {
  if (!version) {
    fail('package version', 'package.json does not contain a string version')
    return
  }

  const versionSource = await readFile(resolve(root, 'src/version.ts'), 'utf8')
  const versionMatch = versionSource.match(/TOOL_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
  if (versionMatch === version) {
    pass('version alignment', `package.json and src/version.ts both declare ${version}`)
  } else {
    fail('version alignment', `package.json declares ${version}, src/version.ts declares ${versionMatch ?? 'nothing'}`)
  }

  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8')
  if (changelog.includes(`## [${version}]`)) {
    pass('release notes', `CHANGELOG.md contains a ${version} release section`)
  } else {
    fail('release notes', `CHANGELOG.md is missing ## [${version}]`)
  }
}

async function checkCopyableReferences() {
  const files = [
    'README.md',
    'docs/README.zh-CN.md',
    'docs/showcase.md',
    'examples/github-actions/upstream-radar.yml',
    'examples/github-actions/upstream-radar-pnpm.yml',
    'examples/github-actions/upstream-radar-npm.yml',
    'examples/github-actions/consumer/upstream-radar.yml',
    'examples/github-actions/consumer/README.md',
    '.github/workflows/action-consumer-smoke.yml',
  ]
  const githubPattern = /MicroMilo\/upstream-radar@v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g
  const npmPattern = /upstream-radar@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g
  const mismatches = []

  for (const file of files) {
    const content = await readFile(resolve(root, file), 'utf8')
    const refs = [
      ...[...content.matchAll(githubPattern)].map(match => `v${match[1]}`),
      ...[...content.matchAll(npmPattern)].map(match => match[1]),
    ]
    if (refs.length === 0) {
      mismatches.push(`${file}: no release reference found`)
      continue
    }
    for (const reference of refs) {
      const expected = reference.startsWith('v') ? `v${version}` : version
      if (reference !== expected) mismatches.push(`${file}: ${reference} (expected ${expected})`)
    }
  }

  if (mismatches.length === 0) {
    pass('copyable references', `all ${files.length} docs/examples use ${version}`)
  } else {
    fail('copyable references', mismatches.join('; '))
  }

  // Keep this explicit: the regex above deliberately does not inspect historical changelog entries.
  const staleReleaseRefs = []
  const scanFiles = ['README.md', 'docs/README.zh-CN.md', 'docs/showcase.md', 'examples', '.github']
  for (const entry of scanFiles) {
    const absolute = resolve(root, entry)
    const stats = await stat(absolute)
    const candidates = stats.isDirectory()
      ? await collectMarkdownAndWorkflowFiles(absolute)
      : [absolute]
    for (const candidate of candidates) {
      const content = await readFile(candidate, 'utf8')
      const allRefs = [
        ...[...content.matchAll(githubPattern)].map(match => `v${match[1]}`),
        ...[...content.matchAll(npmPattern)].map(match => match[1]),
      ]
      for (const reference of allRefs) {
        const expected = reference.startsWith('v') ? `v${version}` : version
        if (reference !== expected) staleReleaseRefs.push(`${candidate.slice(root.length + 1)}: ${reference}`)
      }
    }
  }
  if (staleReleaseRefs.length === 0) {
    pass('repository adoption references', 'no stale release pin remains in README, docs, examples, or workflows')
  } else {
    fail('repository adoption references', staleReleaseRefs.join('; '))
  }
}

async function collectMarkdownAndWorkflowFiles(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      output.push(...await collectMarkdownAndWorkflowFiles(absolute))
    } else if (/\.(md|yml|yaml)$/u.test(entry.name)) {
      output.push(absolute)
    }
  }
  return output
}

async function checkPackContents() {
  const configuredFiles = Array.isArray(packageJson.files) ? packageJson.files : []
  const missingConfigured = []
  for (const entry of configuredFiles) {
    if (typeof entry !== 'string' || !(await pathExists(entry))) missingConfigured.push(String(entry))
  }
  if (missingConfigured.length > 0) {
    fail('package file roots', `package.json files entries are missing: ${missingConfigured.join(', ')}`)
    return
  }
  pass('package file roots', `${configuredFiles.length} configured package roots exist`)

  const pack = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (pack.status !== 0) {
    fail('npm pack', (pack.stderr || pack.stdout || 'npm pack failed').trim())
    return
  }

  let metadata
  try {
    metadata = JSON.parse(pack.stdout)
  } catch (error) {
    fail('npm pack', `could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const packedFiles = new Set((metadata[0]?.files ?? []).map(file => file.path))
  const requiredFiles = [
    'dist/src/cli.js',
    'dist/src/index.js',
    'dist/src/dsh-plugin.js',
    'schemas/analysis-result.schema.json',
    'schemas/dsh-load-matrix.schema.json',
    'schemas/quickstart.schema.json',
    'schemas/webhook.schema.json',
    'cordis.patch.yml',
    'README.md',
    'docs/README.zh-CN.md',
    'LICENSE',
  ]
  const missingPacked = requiredFiles.filter(file => !packedFiles.has(file))
  if (missingPacked.length > 0) {
    fail('npm pack contents', `required files are not in the tarball: ${missingPacked.join(', ')}`)
  } else {
    pass('npm pack contents', `${packedFiles.size} files included; required CLI, DSH, schema, and docs files are present`)
  }
}

async function checkPackedArtifact() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'upstream-radar-release-'))
  try {
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temporaryRoot, '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (pack.status !== 0) {
      fail('packed artifact smoke', (pack.stderr || pack.stdout || 'npm pack failed').trim())
      return
    }

    let metadata
    try {
      metadata = JSON.parse(pack.stdout)
    } catch (error) {
      fail('packed artifact smoke', `could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const filename = metadata[0]?.filename
    if (typeof filename !== 'string') {
      fail('packed artifact smoke', 'npm pack did not report an artifact filename')
      return
    }

    const installRoot = join(temporaryRoot, 'install')
    await mkdir(installRoot)
    const install = spawnSync('npm', [
      'install',
      '--prefix',
      installRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--offline',
      join(temporaryRoot, filename),
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (install.status !== 0) {
      fail('packed artifact smoke', (install.stderr || install.stdout || 'npm install failed').trim())
      return
    }

    const cli = join(installRoot, 'node_modules', 'upstream-radar', 'dist', 'src', 'cli.js')
    const help = spawnSync(process.execPath, [cli, '--help'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (help.status !== 0 || !help.stdout.includes('radar history')) {
      fail('packed artifact smoke', (help.stderr || help.stdout || 'installed CLI did not start').trim())
      return
    }

    const benchmark = spawnSync(process.execPath, [cli, 'benchmark', 'compatibility', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (benchmark.status !== 0) {
      fail('packed artifact smoke', (benchmark.stderr || benchmark.stdout || 'installed CLI benchmark failed').trim())
      return
    }
    const report = JSON.parse(benchmark.stdout)
    if (report.mode !== 'offline-rules' || report.summary?.failed !== 0) {
      fail('packed artifact smoke', 'installed CLI returned an unexpected compatibility benchmark result')
      return
    }

    const demo = spawnSync(process.execPath, [cli, 'demo', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (demo.status !== 0) {
      fail('packed artifact smoke', (demo.stderr || demo.stdout || 'installed CLI demo failed').trim())
      return
    }
    let demoReport
    try {
      demoReport = JSON.parse(demo.stdout)
    } catch (error) {
      fail('packed artifact smoke', `installed CLI returned invalid demo JSON: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!isCrossSourceDemoReport(demoReport)) {
      fail('packed artifact smoke', 'installed CLI demo did not contain the cross-source advisory evidence showcase')
      return
    }
    pass('packed artifact smoke', 'a fresh offline install started the packaged CLI, passed its benchmark, and preserved the cross-source demo')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function checkPublishedVersion() {
  if (!args.has('--published')) return false
  const result = spawnSync('npm', ['view', `upstream-radar@${version}`, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) {
    fail('npm published version', (result.stderr || result.stdout || 'npm view failed').trim())
    return false
  }
  const published = String(JSON.parse(result.stdout))
  if (published === version) {
    pass('npm published version', `upstream-radar@${version} is available from npm`)
    return true
  } else {
    fail('npm published version', `npm returned ${published}; expected ${version}`)
    return false
  }
}

async function checkPublishedArtifact(isAvailable) {
  if (!isAvailable) return
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'upstream-radar-published-'))
  try {
    const pack = spawnSync('npm', [
      'pack',
      `upstream-radar@${version}`,
      '--ignore-scripts',
      '--pack-destination',
      temporaryRoot,
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (pack.status !== 0) {
      fail('published artifact smoke', (pack.stderr || pack.stdout || 'npm pack failed').trim())
      return
    }

    let metadata
    try {
      metadata = JSON.parse(pack.stdout)
    } catch (error) {
      fail('published artifact smoke', `could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const filename = metadata[0]?.filename
    if (typeof filename !== 'string') {
      fail('published artifact smoke', 'npm pack did not report an artifact filename')
      return
    }

    const installRoot = join(temporaryRoot, 'install')
    await mkdir(installRoot)
    const install = spawnSync('npm', [
      'install',
      '--prefix',
      installRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temporaryRoot, filename),
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (install.status !== 0) {
      fail('published artifact smoke', (install.stderr || install.stdout || 'npm install failed').trim())
      return
    }

    const cli = join(installRoot, 'node_modules', 'upstream-radar', 'dist', 'src', 'cli.js')
    const help = spawnSync(process.execPath, [cli, '--help'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (help.status !== 0 || !help.stdout.includes('radar history')) {
      fail('published artifact smoke', (help.stderr || help.stdout || 'published CLI did not start').trim())
      return
    }

    const demo = spawnSync(process.execPath, [cli, 'demo', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    if (demo.status !== 0) {
      fail('published artifact smoke', (demo.stderr || demo.stdout || 'published CLI demo failed').trim())
      return
    }
    let report
    try {
      report = JSON.parse(demo.stdout)
    } catch (error) {
      fail('published artifact smoke', `published CLI returned invalid demo JSON: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!isCrossSourceDemoReport(report)) {
      fail('published artifact smoke', 'published CLI returned an unexpected or incomplete cross-source demo report')
      return
    }
    pass('published artifact smoke', `upstream-radar@${version} installed from npm with scripts disabled and passed help plus the cross-source demo`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await checkVersionFiles()
await checkCopyableReferences()
await checkPackContents()
await checkPackedArtifact()
const publishedAvailable = await checkPublishedVersion()
await checkPublishedArtifact(publishedAvailable)

const failed = checks.filter(check => check.status === 'fail')
const report = {
  schema: 'upstream-radar.release-preflight/v1alpha1',
  version,
  publishedCheck: args.has('--published'),
  passed: failed.length === 0,
  checks,
}

if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`Upstream Radar release preflight — ${version}`)
  for (const check of checks) console.log(`${check.status === 'pass' ? '✓' : '✗'} ${check.name}: ${check.detail}`)
  console.log(failed.length === 0 ? '\nRelease preflight passed.' : `\nRelease preflight failed (${failed.length} check${failed.length === 1 ? '' : 's'}).`)
}

process.exitCode = failed.length === 0 ? 0 : 1
