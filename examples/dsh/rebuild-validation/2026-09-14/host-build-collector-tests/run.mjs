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
const test = await readFile(join(project, 'dist/test/dsh-host-builds.test.js'), 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const module = source.replace("from './graph.js'", "from '/radar/dist/src/graph.js'")
assert.notEqual(module, source)
const key = sha(module + test + image.id)
const output = join(root, key)
await mkdir(output) // Preserve each execution, including failed tests.
const docker = async (args, timeout = 30_000) => execFile('docker', ['--context', config.dockerContext, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 })
assert.equal((await docker(['ps', '--quiet'])).stdout.trim(), '')
const program = `import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('/sandbox/current/src',{recursive:true});
await mkdir('/sandbox/current/test',{recursive:true});
await writeFile('/sandbox/current/package.json','{"type":"module"}');
await writeFile('/sandbox/current/src/dsh-host-builds.js',${JSON.stringify(module)});
await writeFile('/sandbox/current/test/dsh-host-builds.test.js',${JSON.stringify(test)});
await import('/sandbox/current/test/dsh-host-builds.test.js');`
const id = (await docker(['create', '--name', `radar-host-build-tests-${key.slice(0, 16)}`,
  '--label', `upstream-radar.task=${key}`, '--network', 'none', '--read-only', '--user', '10001:10001',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--memory', '1g', '--cpus', '1',
  '--tmpfs', '/sandbox:rw,nosuid,nodev,size=256m,mode=1777', '--env', 'TMPDIR=/sandbox',
  '--entrypoint', 'node', image.id, '--input-type=module', '-e', program])).stdout.trim()
await writeFile(join(output, 'handle.json'), JSON.stringify({ id, key, imageId: image.id, sourceSha256: sha(source),
  loadedModuleSha256: sha(module), testSha256: sha(test), scope: 'Linux fixture tests only; no plugin or DSH code execution' }, null, 2), { flag: 'wx' })
await docker(['start', id])
console.log(JSON.stringify({ stage: 'started', id, output }))
await docker(['wait', id], 120_000)
const container = JSON.parse((await docker(['inspect', id])).stdout)[0]
assert.equal(container.State.Running, false)
assert.equal(container.Config.User, '10001:10001')
assert.deepEqual(container.Mounts, [])
assert.equal(container.HostConfig.ReadonlyRootfs, true)
assert.equal(container.HostConfig.NetworkMode, 'none')
const logs = await docker(['logs', id])
await writeFile(join(output, 'stdout.log'), logs.stdout, { flag: 'wx' })
await writeFile(join(output, 'stderr.log'), logs.stderr, { flag: 'wx' })
await writeFile(join(output, 'result.json'), JSON.stringify({ id, imageId: image.id, state: container.State,
  sourceSha256: sha(source), loadedModuleSha256: sha(module), testSha256: sha(test),
  network: 'none', hostMounts: false, pluginExecuted: false }, null, 2), { flag: 'wx' })
console.log(logs.stdout)
if (logs.stderr) console.error(logs.stderr)
process.exitCode = container.State.ExitCode
