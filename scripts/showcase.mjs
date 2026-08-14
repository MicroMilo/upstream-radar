import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  inspectNpmPackage,
  renderTextReport,
  scanDirectory,
} from '../dist/src/index.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const offline = process.argv.includes('--offline')
const writeReports = process.argv.includes('--write-reports')
const reportsDirectory = join(repository, 'examples/reports')

function heading(number, title, explanation) {
  process.stdout.write(`\n${'='.repeat(78)}\n`)
  process.stdout.write(`${number}. ${title}\n`)
  process.stdout.write(`${explanation}\n`)
  process.stdout.write(`${'='.repeat(78)}\n\n`)
}

async function present(slug, report) {
  const text = renderTextReport(report)
  process.stdout.write(text)
  if (!writeReports) return
  await mkdir(reportsDirectory, { recursive: true })
  await writeFile(join(reportsDirectory, `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(reportsDirectory, `${slug}.txt`), text)
}

if (!offline) {
  heading(
    1,
    'Real DSH plugin from npm',
    'Verify exact bytes, npm signature, SLSA provenance, resolved graph and advisories.',
  )
  const real = await inspectNpmPackage('npm:dsh-cloudflare-browser-run@0.1.1', { deep: true, timeoutMs: 60_000 })
  await present('dsh-cloudflare-browser-run-0.1.1', real)
}

heading(
  offline ? 1 : 2,
  'Clean local plugin, incomplete evidence',
  'No static risk is found, but missing provenance and detonation prevent automatic admission.',
)
await present('clean-dsh-plugin', await scanDirectory(join(repository, 'examples/fixtures/clean-dsh-plugin')))

heading(
  offline ? 2 : 3,
  'Install-time script requires review',
  'The scanner reports the script as evidence; it never executes the target code.',
)
await present('review-install-script', await scanDirectory(join(repository, 'examples/fixtures/review-install-script')))

heading(
  offline ? 3 : 4,
  'Remote shell pipeline is blocked',
  'A postinstall command that pipes remote bytes to a shell produces a deterministic block.',
)
await present('block-remote-shell', await scanDirectory(join(repository, 'examples/fixtures/block-remote-shell')))
