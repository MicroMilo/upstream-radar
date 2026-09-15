// Operator-owned diagnostic, executed only inside the dedicated disposable VM.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { collectDshHostBuildInventory } from '/sandbox/current/dsh-host-builds.js'
import { observationNetworkEnvironment } from '/radar/dist/src/dsh-observation-network.js'

const { networkProxy } = JSON.parse(process.argv[1])
const root = '/sandbox/host-inventory'
const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: `${root}/home`,
  DSH_HOME: `${root}/dsh-home`, TMPDIR: `${root}/tmp`, XDG_CACHE_HOME: `${root}/cache`,
  XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, PNPM_HOME: `${root}/pnpm-home`,
  NPM_CONFIG_CACHE: `${root}/npm-cache`, NPM_CONFIG_USERCONFIG: `${root}/controlled.npmrc`,
  NPM_CONFIG_GLOBALCONFIG: `${root}/global.npmrc`, NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
  DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_MODE: 'DISABLED', CI: 'true', NO_COLOR: '1',
  ...observationNetworkEnvironment(networkProxy) }
for (const key of ['HOME', 'DSH_HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PNPM_HOME']) {
  await mkdir(environment[key], { recursive: true })
}
await writeFile(environment.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\naudit=false\nfund=false\n', { flag: 'wx' })
await writeFile(environment.NPM_CONFIG_GLOBALCONFIG, '', { flag: 'wx' })
const args = ['dlx', '--package=@deepseek-ai/dsh@0.1.3-alpha.2', 'dsh', '--profile', 'web', '--help']
const child = spawn('pnpm', args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const chunks = []
let captured = 0, exceeded = false, timedOut = false, launchError
const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
const capture = bytes => {
  if (captured + bytes.length > 256 * 1024) { exceeded = true; kill(); return }
  captured += bytes.length; chunks.push(bytes)
}
child.stdout.on('data', capture); child.stderr.on('data', capture)
child.once('error', error => { launchError = error.message })
const timer = setTimeout(() => { timedOut = true; kill() }, 180_000)
const terminal = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
clearTimeout(timer)
const inventory = await collectDshHostBuildInventory(environment.XDG_CACHE_HOME, '0.1.3-alpha.2')
console.log(JSON.stringify({ scope: 'stock-dsh-host-build-inventory', pluginInstalled: false, dependencyBuildsApproved: [],
  nodeVersion: process.version, prepare: { args, terminal, exceeded, timedOut, launchError,
    output: Buffer.concat(chunks).toString('utf8').replace(/([?&]token=)[^&\s]+/g, '$1[ephemeral-token-redacted]') }, inventory }))
process.exitCode = terminal.code === 0 && !exceeded && !timedOut && inventory.coverageGaps.length === 0 ? 0 : 1
