import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createQuickstartReport, renderQuickstartReport } = await import('../dist/src/index.js')

const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-showcase-'))
const empty = join(scratch, 'empty')
const lockfile = join(scratch, 'lockfile')
const dsh = join(scratch, 'dsh')
const dshHome = join(dsh, 'dsh-home')
const profile = join(dshHome, 'profiles', 'web')
const ambiguous = join(scratch, 'ambiguous')

try {
  await mkdir(empty, { recursive: true })
  await mkdir(lockfile, { recursive: true })
  await writeFile(join(lockfile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
  }))
  await mkdir(ambiguous, { recursive: true })
  await writeFile(join(ambiguous, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await writeFile(join(ambiguous, 'package-lock.json'), '{}\n')

  const reports = [
    ['empty directory', await createQuickstartReport(empty, { dshHome: join(empty, 'no-dsh') })],
    ['pnpm lockfile', await createQuickstartReport(lockfile, { dshHome: join(lockfile, 'no-dsh') })],
    ['one DSH profile', await createQuickstartReport(dsh, { dshHome })],
    ['two lockfiles', await createQuickstartReport(ambiguous, { dshHome: join(ambiguous, 'no-dsh') })],
  ]

  assert.deepEqual(reports.map(([, report]) => report.mode), ['demo', 'pnpm-lock', 'dsh', 'choose-lockfile'])
  assert.equal(reports[2]?.[1].steps[1].effect, 'installs-and-starts')
  assert.equal(reports[3]?.[1].warnings.length, 1)

  console.log('Upstream Radar quickstart showcase')
  for (const [label, report] of reports) {
    console.log(`  ${label}: mode=${report.mode}, steps=${report.steps.length}, warnings=${report.warnings.length}`)
  }
  console.log('\nOne-profile path:')
  process.stdout.write(renderQuickstartReport(reports[2][1]))
  console.log('network = none; packages = none; DSH started = no')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
