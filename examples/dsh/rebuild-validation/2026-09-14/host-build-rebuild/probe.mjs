// This operator-owned diagnostic runs only inside a disposable container in the
// dedicated review VM. It starts stock DSH, with no target plugin installed.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, open, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseInstalledNodeModulesGraph } from '/radar/dist/src/installed-graph.js'
import { observationNetworkEnvironment } from '/radar/dist/src/dsh-observation-network.js'

const { mode, networkProxy } = JSON.parse(process.argv[1])
if (!['rebuild-fs-ext'].includes(mode)) throw new Error('Unknown diagnostic mode')
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
function command(args, env, timeout, cwd = root) {
  const child = spawn('pnpm', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
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
const prepare = command([...dlx, '--profile', 'web', '--help'], policy(true), 180_000)
await prepare.done
const report = { scope: 'stock-dsh-host-only-diagnostic', pluginInstalled: false,
  dshVersion: '0.1.3-alpha.2', mode, nodeVersion: process.version, prepare: prepare.report() }
const readChild = async (directory, name, maximum) => {
  const file = await open('/proc/self/fd/' + directory.fd + '/' + name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new Error('Metadata file exceeds regular-file bound');
    const bytes = await file.readFile();
    if (bytes.length !== metadata.size) throw new Error('Metadata changed while reading');
    return { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
};
const openDirectory = (parent, name) => open('/proc/self/fd/' + parent.fd + '/' + name,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
report.metadata = [];
let cache;
try {
  let directory = await open('/sandbox', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  for (const name of ['host-build-diagnostic', 'cache', 'pnpm', 'dlx']) {
    const next = await openDirectory(directory, name);
    await directory.close();
    directory = next;
  }
  cache = directory;
  for (const hashEntry of (await readdir('/proc/self/fd/' + cache.fd, { withFileTypes: true })).slice(0, 8)) {
    if (!hashEntry.isDirectory()) continue;
    const hashDirectory = await openDirectory(cache, hashEntry.name);
    try {
      for (const instance of (await readdir('/proc/self/fd/' + hashDirectory.fd, { withFileTypes: true })).slice(0, 8)) {
        if (!instance.isDirectory()) continue;
        const instanceDirectory = await openDirectory(hashDirectory, instance.name);
        try {
          const manifest = await readChild(instanceDirectory, 'package.json', 256 * 1024);
          const lock = await readChild(instanceDirectory, 'pnpm-lock.yaml', 8 * 1024 * 1024);
          const modulesDirectory = await openDirectory(instanceDirectory, 'node_modules');
          try {
            const modules = await readChild(modulesDirectory, '.modules.yaml', 4 * 1024 * 1024);
            const value = JSON.parse(modules.text);
            const graph = await parseInstalledNodeModulesGraph('/proc/self/fd/' + instanceDirectory.fd,
              { name: '@deepseek-ai/dsh', version: '0.1.3-alpha.2' });
            const rebuild = command(['rebuild', 'fs-ext@2.1.1'], policy(false), 180_000,
              `${root}/cache/pnpm/dlx/${hashEntry.name}/${instance.name}`);
            await rebuild.done;
            const afterLock = await readChild(instanceDirectory, 'pnpm-lock.yaml', 8 * 1024 * 1024);
            const afterModules = JSON.parse((await readChild(modulesDirectory, '.modules.yaml', 4 * 1024 * 1024)).text);
            const afterGraph = await parseInstalledNodeModulesGraph('/proc/self/fd/' + instanceDirectory.fd,
              { name: '@deepseek-ai/dsh', version: '0.1.3-alpha.2' });
            report.metadata.push({ rebuild: rebuild.report(), after: { lockfileSha256: afterLock.sha256,
                graphDigest: afterGraph.digest, pendingBuilds: afterModules.pendingBuilds,
                ignoredBuilds: afterModules.ignoredBuilds }, manifest: JSON.parse(manifest.text), manifestSha256: manifest.sha256,
              modulesSha256: modules.sha256, lockfileSha256: lock.sha256, lockfileExcerpt: lock.text.slice(0, 8192),
              packageManager: value.packageManager, ignoredBuilds: value.ignoredBuilds, pendingBuilds: value.pendingBuilds,
              allowBuilds: value.allowBuilds, graph: { digest: graph.digest, nodes: graph.nodes.length,
                unresolved: graph.unresolved, fsExt: graph.nodes.filter(node => node.name === 'fs-ext') } });
          } finally { await modulesDirectory.close(); }
        } finally { await instanceDirectory.close(); }
      }
    } finally { await hashDirectory.close(); }
  }
} catch (error) { report.metadataError = String(error); }
finally { await cache?.close(); }
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

