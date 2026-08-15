import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_VERSION = '0.1.0-rc.6'
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', rejectRun)
    child.on('close', code => resolveRun({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

async function packFixture(name, destination) {
  await mkdir(destination, { recursive: true })
  const result = await run(PNPM, ['pack', '--pack-destination', destination], {
    cwd: join(ROOT, 'examples/fixtures', name),
  })
  if (result.code !== 0) throw new Error(`could not pack ${name}:\n${result.stdout}\n${result.stderr}`)
  const files = (await readdir(destination)).filter(file => file.endsWith('.tgz'))
  if (files.length !== 1 || files[0] === undefined) throw new Error(`expected one tarball for ${name}`)
  return join(destination, files[0])
}

async function probe(tarball) {
  const result = await run(process.execPath, [
    join(ROOT, 'dist/src/cli.js'),
    'probe',
    'dsh-load',
    tarball,
    '--dsh-version',
    DSH_VERSION,
    '--json',
  ])
  if (result.stdout.trim() === '') throw new Error(`probe returned no JSON:\n${result.stderr}`)
  return {
    exitCode: result.code,
    report: JSON.parse(result.stdout),
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-probe-showcase-'))
try {
  const cases = [
    ['probe-compatible-dsh-plugin', 'compatible'],
    ['probe-incompatible-dsh-plugin', 'incompatible'],
    ['probe-unknown-dsh-plugin', 'unknown'],
  ]
  const results = []
  for (const [fixture, expected] of cases) {
    const tarball = await packFixture(fixture, join(scratch, 'tarballs', fixture))
    const result = await probe(tarball)
    if (result.report.result !== expected) {
      throw new Error(`${fixture} expected ${expected}, got ${result.report.result}`)
    }
    results.push({
      fixture,
      result: result.report.result,
      exitCode: result.exitCode,
      reason: result.report.reason,
      stages: Object.fromEntries(Object.entries(result.report.stages).map(([stage, value]) => [stage, value.status])),
    })
  }
  console.log(JSON.stringify({
    dshVersion: DSH_VERSION,
    scope: 'bundle-load-only',
    results,
  }, null, 2))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
