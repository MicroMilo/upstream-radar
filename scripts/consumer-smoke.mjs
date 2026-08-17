import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const published = process.argv.includes('--published') || process.env.UPSTREAM_RADAR_CONSUMER_VERSION !== undefined
const radarVersion = process.env.UPSTREAM_RADAR_CONSUMER_VERSION ?? packageJson.version
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const cliArgs = [
  'radar',
  'check',
  'examples/github-actions/consumer/upstream-radar.config.json',
  '--frozen',
  '--state',
  ':memory:',
  '--fail-on',
  'high',
  '--json',
]

let execution = 'local'
let runCommand = process.execPath
let args = [resolve(root, 'dist/src/cli.js'), ...cliArgs]
if (published) {
  execution = 'npm'
  runCommand = command
  args = ['dlx', `--package=upstream-radar@${radarVersion}`, 'upstream-radar', ...cliArgs]
} else {
  try {
    await access(args[0])
  } catch {
    throw new Error('local consumer smoke needs a built CLI; run `pnpm run build` or use `pnpm run try:consumer`')
  }
}

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(runCommand, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  const chunks = []
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
  child.on('error', reject)
  child.on('close', code => {
    const output = Buffer.concat(chunks).toString('utf8')
    if (code !== 0) {
      reject(new Error(`consumer check exited with code ${code}\n${output}`))
      return
    }
    try {
      resolveResult(JSON.parse(output))
    } catch (error) {
      reject(new Error(`consumer check did not return JSON: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
})

if (result.sourceErrors.length > 0) {
  throw new Error(`consumer check reported source errors: ${JSON.stringify(result.sourceErrors)}`)
}

console.log(JSON.stringify({
  execution,
  radarVersion,
  plugin: 'dsh-cloudflare-browser-run@0.1.1',
  packagesQueried: result.packagesQueried,
  releasePackagesQueried: result.releasePackagesQueried,
  events: result.events.length,
  activeVulnerabilities: Object.keys(result.state.activeVulnerabilities).length,
  policy: result.policy,
}, null, 2))
