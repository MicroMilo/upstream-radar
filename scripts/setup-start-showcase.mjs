import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLI = join(ROOT, 'dist/src/cli.js')

const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-setup-start-showcase-'))
const dshHome = join(scratch, 'dsh-home')
const profile = join(dshHome, 'profiles', 'showcase')
const project = join(scratch, 'project')
const bin = join(scratch, 'bin')
const log = join(scratch, 'dsh-commands.txt')

function runSetup() {
  return spawnSync(process.execPath, [
    CLI,
    'setup',
    '--output',
    'upstream-radar.config.json',
    '--start',
  ], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      UPSTREAM_RADAR_TEST_LOG: log,
    },
  })
}

try {
  await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-showcase',
    dsh: { profile: { bundles: ['upstream-radar', 'demo-plugin'] } },
  }))
  await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    main: './index.js',
  }))

  const fakeDshScript = join(bin, 'fake-dsh.mjs')
  await writeFile(fakeDshScript, [
    "import { appendFileSync } from 'node:fs'",
    "appendFileSync(process.env.UPSTREAM_RADAR_TEST_LOG, `${process.argv.slice(2).join(' ')}\\n`)",
  ].join('\n'))
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'dsh.cmd'), '@echo off\r\nnode "%~dp0fake-dsh.mjs" %*\r\n')
  } else {
    await writeFile(join(bin, 'dsh'), `#!/bin/sh\nexec "${process.execPath}" "${fakeDshScript}" "$@"\n`, { mode: 0o755 })
  }

  const result = runSetup()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const commands = (await readFile(log, 'utf8')).trim().split('\n')
  assert.equal(commands.length, 2)
  assert.match(commands[0] ?? '', /^plugin --profile showcase add upstream-radar@/)
  assert.equal(commands[1], '--profile showcase --patch upstream-radar.dsh.yml')
  assert.match(result.stdout, /Local wiring check:/)
  assert.match(result.stdout, /Starting DSH profile showcase/)

  console.log('Setup --start showcase')
  console.log('  doctor gate = passed')
  console.log(`  install call = ${commands[0]}`)
  console.log(`  start call = ${commands[1]}`)
  console.log('  network = none; plugin business code = not executed')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
