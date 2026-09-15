import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(callback)
const root = import.meta.dirname
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const config = await json(join(root, '../recovery-current-executor.json'))
const executor = await json(join(root, '../recovery-web-errors/batch/executor-evidence.json'))
assert.equal(config.dockerContext, 'colima-upstream-radar-review-20260913')
const image = executor.images.find(image => image.nodeMajor === 24 && image.pnpmVersion === '11.7.0')
assert.match(image.id, /^sha256:[a-f0-9]{64}$/)
const project = resolve(root, '../../../../..')
const source = await readFile(join(project, 'dist/src/dsh-host-builds.js'), 'utf8')
const probe = await readFile(join(root, 'probe.mjs'), 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const module = source.replace("from './graph.js'", "from '/radar/dist/src/graph.js'")
assert.notEqual(module, source)
// Only this current collector is injected; pin the graph dependency to the
// unchanged source used to build the immutable executor image.
assert.equal((await execFile('git', ['diff', '1814536', '--', 'src/graph.ts'], { cwd: project })).stdout, '')
const key = sha(module + probe + image.id)
const output = join(root, key)
const docker = async (args, timeout = 30_000) => execFile('docker', ['--context', config.dockerContext, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 })
assert.equal((await docker(['ps', '--quiet'])).stdout.trim(), '')
await mkdir(output) // Each attempt is preserved; never overwrite or restart it.
const bootstrap = `import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('/sandbox/current',{recursive:true});
await writeFile('/sandbox/current/package.json','{"type":"module"}');
await writeFile('/sandbox/current/dsh-host-builds.js',${JSON.stringify(module)});
await writeFile('/sandbox/current/probe.mjs',${JSON.stringify(probe)});
await import('/sandbox/current/probe.mjs');`
const id = (await docker(['create', '--name', `radar-host-inventory-${key.slice(0, 16)}`,
  '--label', `upstream-radar.task=${key}`, '--read-only', '--user', '10001:10001',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '256', '--memory', '3g', '--cpus', '1.5',
  '--tmpfs', '/sandbox:rw,exec,nosuid,nodev,size=3g,mode=1777', '--env', 'TMPDIR=/sandbox',
  '--entrypoint', 'node', image.id, '--input-type=module', '-e', bootstrap, JSON.stringify({ networkProxy: config.networkProxy })])).stdout.trim()
const identity = { id, key, imageId: image.id, sourceSha256: sha(source), loadedModuleSha256: sha(module), probeSha256: sha(probe) }
await writeFile(join(output, 'handle.json'), JSON.stringify(identity, null, 2), { flag: 'wx' })
await docker(['start', id])
console.log(JSON.stringify({ stage: 'started', id, output }))
await docker(['wait', id], 240_000)
const container = JSON.parse((await docker(['inspect', id])).stdout)[0]
assert.equal(container.State.Running, false)
assert.equal(container.Config.User, '10001:10001')
assert.deepEqual(container.Mounts, [])
assert.equal(container.HostConfig.ReadonlyRootfs, true)
const logs = await docker(['logs', id])
await writeFile(join(output, 'stdout.log'), logs.stdout, { flag: 'wx' })
await writeFile(join(output, 'stderr.log'), logs.stderr, { flag: 'wx' })
await writeFile(join(output, 'result.json'), JSON.stringify({ ...identity, state: container.State, hostMounts: false }, null, 2), { flag: 'wx' })
if (logs.stderr) console.error(logs.stderr)
const report = JSON.parse(logs.stdout.trim())
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ id, prepare: report.prepare.terminal, coverageGaps: report.inventory.coverageGaps,
  packages: report.inventory.packages.map(item => item.spec), installation: report.inventory.installation }))
process.exitCode = container.State.ExitCode
