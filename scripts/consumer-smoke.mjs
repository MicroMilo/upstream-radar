import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const args = [
  'dlx',
  `--package=upstream-radar@${packageJson.version}`,
  'upstream-radar',
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

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
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
  radarVersion: packageJson.version,
  plugin: 'dsh-cloudflare-browser-run@0.1.1',
  packagesQueried: result.packagesQueried,
  releasePackagesQueried: result.releasePackagesQueried,
  events: result.events.length,
  activeVulnerabilities: Object.keys(result.state.activeVulnerabilities).length,
  policy: result.policy,
}, null, 2))
