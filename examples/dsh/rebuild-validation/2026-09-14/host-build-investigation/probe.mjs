// This operator-owned diagnostic runs only inside a disposable container in the
// dedicated review VM. It starts stock DSH, with no target plugin installed.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { observationNetworkEnvironment } from '/radar/dist/src/dsh-observation-network.js'

const { mode, networkProxy } = JSON.parse(process.argv[1])
if (!['no-build', 'approved-fs-ext'].includes(mode)) throw new Error('Unknown diagnostic mode')
const root = '/sandbox/host-build-diagnostic'
const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: `${root}/home`,
  DSH_HOME: `${root}/dsh-home`, TMPDIR: `${root}/tmp`, XDG_CACHE_HOME: `${root}/cache`,
  XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, PNPM_HOME: `${root}/pnpm-home`,
  NPM_CONFIG_CACHE: `${root}/npm-cache`, NPM_CONFIG_USERCONFIG: `${root}/controlled.npmrc`,
  NPM_CONFIG_GLOBALCONFIG: `${root}/global.npmrc`, NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
  DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_MODE: 'DISABLED', CI: 'true', NO_COLOR: '1',
  ...observationNetworkEnvironment(networkProxy) }
await mkdir(root, { recursive: true })
for (const key of ['HOME', 'DSH_HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PNPM_HOME']) {
  await mkdir(environment[key], { recursive: true })
}
await writeFile(environment.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\naudit=false\nfund=false\n')
await writeFile(environment.NPM_CONFIG_GLOBALCONFIG, '')
const policy = ignored => ({ ...environment, NPM_CONFIG_IGNORE_SCRIPTS: String(ignored),
  npm_config_ignore_scripts: String(ignored), PNPM_CONFIG_IGNORE_SCRIPTS: String(ignored) })
const redact = text => text.replace(/([?&]token=)[^&\s]+/g, '$1[ephemeral-token-redacted]')
function command(args, env, timeout) {
  const child = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const chunks = []
  let captured = 0, exceeded = false, terminal, launchError
  const kill = signal => { try { process.kill(-child.pid, signal) } catch { child.kill(signal) } }
  const collect = data => { if (captured + data.length > 256 * 1024) { exceeded = true; kill('SIGKILL'); return }; chunks.push(data); captured += data.length }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.once('error', error => { launchError = error.message })
  const timer = setTimeout(() => kill('SIGKILL'), timeout)
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    terminal = { code, signal }; clearTimeout(timer); resolve(terminal)
  }))
  return { child, done, terminal: () => terminal, output: () => redact(Buffer.concat(chunks).toString('utf8')),
    report: () => ({ args, terminal, exceeded, launchError, output: redact(Buffer.concat(chunks).toString('utf8')) }),
    stop: async () => {
      if (terminal) return
      kill('SIGTERM')
      const force = setTimeout(() => kill('SIGKILL'), 5_000)
      await done
      clearTimeout(force)
    } }
}
const dlx = ['dlx', '--package=@deepseek-ai/dsh@0.1.3-alpha.2',
  ...(mode === 'approved-fs-ext' ? ['--allow-build=fs-ext'] : []), 'dsh']
const prepare = command([...dlx, '--profile', 'web', '--help'], policy(mode === 'no-build'), 180_000)
await prepare.done
const report = { scope: 'stock-dsh-host-only-diagnostic', pluginInstalled: false,
  dshVersion: '0.1.3-alpha.2', mode, nodeVersion: process.version, prepare: prepare.report() }
if (prepare.terminal()?.code === 0) {
  const host = command([...dlx, '--profile', 'web', '--host', '127.0.0.1', '--port', '19845'], policy(false), 65_000)
  const deadline = Date.now() + 45_000
  const statuses = []
  while (!host.terminal() && Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:19845/', { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
      if (statuses.at(-1)?.status !== response.status && statuses.length < 32) statuses.push({ status: response.status, observedAt: new Date().toISOString() })
      await response.body?.cancel()
    } catch { /* Connection refusal before startup or after a genuine exit. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const naturalTerminal = host.terminal()
  const aliveAtEndOfObservation = naturalTerminal === undefined
  await host.stop()
  report.host = { ...host.report(), naturalTerminal, aliveAtEndOfObservation, statuses,
    missingFsExtBinary: /Cannot find module ['"]\.\/build\/Release\/fs_ext\.node/.test(host.output()) }
}
console.log(JSON.stringify(report))
