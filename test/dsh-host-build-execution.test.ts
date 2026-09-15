import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { collectDshHostBuildInventory, collectDshHostNativeLoadFailures } from '../src/dsh-host-builds.js'
import { createDshHostBuildApproval } from '../src/dsh-host-build-policy.js'
import { executeDshHostBuildApproval, parseDshHostBuildExecution } from '../src/dsh-host-build-execution.js'

const version = '0.1.3-alpha.2'
async function fixture(program: string, scripts?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'radar-host-rebuild-'))
  const cache = join(root, 'cache')
  const installation = join(cache, 'pnpm/dlx/key/instance')
  const pnpmCommand = join(root, 'operator-pnpm.mjs')
  const cleanup = () => rm(root, { recursive: true, force: true })
  try {
    const host = join(installation, `node_modules/.pnpm/@deepseek-ai+dsh@${version}/node_modules/@deepseek-ai/dsh`)
    const dependency = join(installation, 'node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext')
    await mkdir(host, { recursive: true }); await mkdir(dependency, { recursive: true })
    await writeFile(join(installation, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version }, ...(scripts ? { scripts } : {}) }))
    await writeFile(join(installation, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: ${version}
        version: ${version}
packages:
  '@deepseek-ai/dsh@${version}': {}
  fs-ext@2.1.1: {}
snapshots:
  '@deepseek-ai/dsh@${version}':
    dependencies:
      fs-ext: 2.1.1
  fs-ext@2.1.1: {}
`)
    await writeFile(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fs-ext', version: '2.1.1', scripts: { install: 'fixture native build' } }))
    await writeFile(join(installation, 'node_modules/.modules.yaml'), JSON.stringify({ packageManager: 'pnpm@11.7.0', virtualStoreDir: '.pnpm', pendingBuilds: ['fs-ext@2.1.1'] }))
    await writeFile(pnpmCommand, `#!${process.execPath}\n${program}`, { mode: 0o700 })
    const inventory = await collectDshHostBuildInventory(cache, version)
    assert.deepEqual(inventory.coverageGaps, [])
    const failures = collectDshHostNativeLoadFailures(inventory, cache,
      `Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- ${dependency}/fs-ext.js\n`)
    const context = { caseId: 'isolated-rebuild', plugin: 'test-plugin@1.0.0', artifactSha256: '6'.repeat(64),
      sourceFingerprint: `sha256:${'7'.repeat(64)}`, dshVersion: version, plane: 'web' as const, profile: 'web',
      runtime: { nodeMajor: Number(process.versions.node.split('.')[0]), nodeVersion: process.versions.node, platform: process.platform,
        architecture: process.arch, pnpmVersion: '11.7.0' }, profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } }
    const approval = createDshHostBuildApproval({ inventory, failures, context, packages: ['fs-ext@2.1.1'] })
    const options = { approval, context, cacheHome: cache, pnpmCommand, allowExecution: true, timeoutMs: 10_000,
      environment: { PATH: process.env.PATH, HOME: root, CI: 'true' } }
    return { root, cache, installation, inventory, options, cleanup }
  } catch (error) { await cleanup(); throw error }
}

it('executes only exact approved rebuild selectors in the pinned installation and verifies unchanged bindings afterwards', { skip: process.platform !== 'linux' }, async () => {
  const state = await fixture(`import {readFile} from 'node:fs/promises';
console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),
 policy:JSON.parse(await readFile('pnpm-workspace.yaml','utf8')),
 ignoreScripts:[process.env.NPM_CONFIG_IGNORE_SCRIPTS,process.env.npm_config_ignore_scripts,process.env.PNPM_CONFIG_IGNORE_SCRIPTS]}));`)
  try {
    const result = await executeDshHostBuildApproval(state.options)
    assert.equal(result.status, 'command-completed')
    assert.equal(result.bindingVerified, true)
    assert.deepEqual(result.command?.args, ['rebuild', 'fs-ext@2.1.1'])
    const observed = JSON.parse(result.command!.output)
    assert.equal(observed.cwd, state.installation)
    assert.deepEqual(observed.args, ['rebuild', 'fs-ext@2.1.1'])
    assert.deepEqual(observed.policy, { allowBuilds: { 'fs-ext@2.1.1': true } })
    assert.deepEqual(observed.ignoreScripts, ['false', 'false', 'false'])
    assert.deepEqual(JSON.parse(await readFile(join(state.installation, 'node_modules/.modules.yaml'), 'utf8')).pendingBuilds, ['fs-ext@2.1.1'])
    assert.equal(Reflect.get(result, 'buildSucceeded'), undefined, 'command completion is not proof of native module functionality')
    const binding = { inventory: state.inventory, context: state.options.context }
    assert.deepEqual(parseDshHostBuildExecution(JSON.parse(JSON.stringify(result)), binding), result)
    assert.throws(() => parseDshHostBuildExecution({ ...result, command: { ...result.command, output: 'changed' } }, binding), /output/)
    assert.throws(() => parseDshHostBuildExecution({ ...result, command: { ...result.command, args: ['rebuild', 'unapproved@1.0.0'] } }, binding), /selector/)
    assert.throws(() => parseDshHostBuildExecution({ ...result, bindingVerified: false }, binding), /binding/)
    assert.throws(() => parseDshHostBuildExecution(result, { ...binding, context: { ...binding.context, artifactSha256: '8'.repeat(64) } }), /context/)
  } finally { await state.cleanup() }
})

it('rejects stale, symlinked or independently configured installations before launching a rebuild', { skip: process.platform !== 'linux' }, async () => {
  for (const scenario of ['changed-lock', 'linked-cache', 'existing-policy', 'root-script', 'no-consent'] as const) {
    const state = await fixture('throw new Error("This command must never be launched")', scenario === 'root-script' ? { rebuild: 'target-controlled override' } : undefined)
    try {
      if (scenario === 'changed-lock') await writeFile(join(state.installation, 'pnpm-lock.yaml'), `${await readFile(join(state.installation, 'pnpm-lock.yaml'), 'utf8')}\n`)
      if (scenario === 'linked-cache') { await rename(state.cache, `${state.cache}-moved`); await symlink(`${state.cache}-moved`, state.cache) }
      if (scenario === 'existing-policy') await writeFile(join(state.installation, 'pnpm-workspace.yaml'), 'operator-owned preexisting policy')
      const result = await executeDshHostBuildApproval({ ...state.options, allowExecution: scenario !== 'no-consent' })
      assert.equal(result.status, 'not-executed', scenario)
      assert.equal(result.command, undefined, scenario)
      assert.equal(result.bindingVerified, false)
      if (scenario === 'existing-policy') assert.equal(await readFile(join(state.installation, 'pnpm-workspace.yaml'), 'utf8'), 'operator-owned preexisting policy')
      else await assert.rejects(readFile(join(state.installation, 'pnpm-workspace.yaml')), { code: 'ENOENT' })
    } finally { await state.cleanup() }
  }
})

it('does not treat exit zero as a verified command when the build changed its graph or permission', { skip: process.platform !== 'linux' }, async () => {
  for (const program of [
    "import {appendFile} from 'node:fs/promises'; await appendFile('pnpm-lock.yaml','\\n# graph binding changed\\n');",
    "import {writeFile} from 'node:fs/promises'; await writeFile('pnpm-workspace.yaml',JSON.stringify({dangerouslyAllowAllBuilds:true}));",
  ]) {
    const state = await fixture(program)
    try {
      const result = await executeDshHostBuildApproval(state.options)
      assert.equal(result.command?.code, 0)
      assert.equal(result.status, 'failed')
      assert.equal(result.bindingVerified, false)
      assert.match(result.reason, /changed/)
    } finally { await state.cleanup() }
  }
})

it('bounds a rebuild process by output and time without reporting a completed build', { skip: process.platform !== 'linux' }, async () => {
  for (const kind of ['output', 'time'] as const) {
    const state = await fixture(`${kind === 'output' ? "process.stdout.write('x'.repeat(1024*1024));" : ''} setInterval(()=>{},1000);`)
    try {
      const result = await executeDshHostBuildApproval({ ...state.options, timeoutMs: kind === 'time' ? 100 : 5_000 })
      assert.equal(result.status, 'failed')
      assert.equal(result.bindingVerified, false)
      assert.equal(kind === 'output' ? result.command?.outputExceeded : result.command?.timedOut, true)
      assert.ok(Buffer.byteLength(result.command!.output) <= 256 * 1024)
    } finally { await state.cleanup() }
  }
})

it('keeps non-UTF8 command output within the serialized evidence byte bound', { skip: process.platform !== 'linux' }, async () => {
  const state = await fixture('process.stdout.write(Buffer.alloc(100*1024,255));')
  try {
    const result = await executeDshHostBuildApproval(state.options)
    assert.equal(result.status, 'failed')
    assert.equal(result.command?.outputExceeded, true)
    assert.ok(Buffer.byteLength(result.command!.output) <= 256 * 1024)
    assert.deepEqual(parseDshHostBuildExecution(result, { inventory: state.inventory, context: state.options.context }), result)
  } finally { await state.cleanup() }
})
