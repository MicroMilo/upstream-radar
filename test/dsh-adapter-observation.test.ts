import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { observeDshAuthorAdapter } from '../src/dsh-adapter-observation.js'
import { emptyDshAdapterLedger, mergeDshAdapterLedger, parseDshAdapterExpectedCase, type DshAdapterExpectedCase } from '../src/dsh-adapter.js'
import { makeTarball } from './helpers/tar.js'

it('requires the adapter service and exact linked plugin roots, and retains independent SDK and ACP graphs', async () => {
  const manifest = { name: 'dsh-feishu-bot', version: '0.19.16', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  const bytes = makeTarball([
    { path: 'package/package.json', contents: JSON.stringify(manifest) }, { path: 'package/cordis.patch.yml', contents: '[]\n' },
  ])
  async function observe(adapter: 'sdk' | 'acp', includeService: boolean, gapKind?: 'optional' | 'runtime') {
    return observeDshAuthorAdapter({ packageSpec: 'dsh-feishu-bot@0.19.16', dshVersion: '0.1.5-rc.2', adapter,
      expectedArtifactSha256: createHash('sha256').update(bytes).digest('hex'), allowExecution: true,
      runner: async command => {
        const application = join(command.env.DSH_HOME!, 'profiles')
        const writePackage = async (directory: string, name: string, version: string) => {
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version,
            ...(gapKind ? { [gapKind === 'optional' ? 'optionalDependencies' : 'dependencies']: { 'fixture-unavailable': '1.0.0' } } : {}) }))
        }
        if (command.phase === 'artifact') await writeFile(join(command.cwd, 'plugin.tgz'), bytes)
        if (command.phase === 'install') {
          for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', 'dsh-feishu-bot']) {
            await writePackage(join(application, 'node_modules', name), name, name === 'dsh-feishu-bot' ? '0.19.16' : '0.1.5-rc.2')
          }
        }
        if (command.phase === 'load') {
          const managed = join(application, `dsh-lark-${adapter}`)
          const service = adapter === 'sdk' ? '@deepseek-ai/dsh-sdk-jsonrpc-server' : '@deepseek-ai/dsh-acp'
          const linkedPackage = await realpath(join(application, 'node_modules', 'dsh-feishu-bot'))
          await mkdir(join(managed, 'node_modules'), { recursive: true })
          await symlink(linkedPackage, join(managed, 'node_modules', 'dsh-feishu-bot'))
          if (includeService) await writePackage(join(managed, 'node_modules', service), service, '0.1.0-rc.8')
          await writeFile(join(managed, 'package.json'), JSON.stringify({ name: 'managed-adapter-profile', private: true,
            dependencies: { 'dsh-feishu-bot': `link:${linkedPackage}`,
              ...(includeService ? { [service]: '0.1.0-rc.8' } : {}) },
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
          }))
        }
        return { code: 0, timedOut: false, outputExceeded: false, stderr: '',
          stdout: command.phase === 'runtime' ? '11.7.0' : command.phase === 'artifact' ? 'plugin.tgz'
            : command.phase === 'load' ? `adapter: ${adapter}\ndsh: ok (fixture-service@0.1.0-rc.8)\n` : '' }
      } })
  }
  assert.equal((await observe('sdk', false)).result, 'unknown', 'a package link alone is not an SDK runtime profile')
  assert.equal((await observe('sdk', true, 'runtime')).result, 'unknown', 'required unresolved dependencies still prevent a compatibility result')
  for (const adapter of ['sdk', 'acp'] as const) {
    const report = await observe(adapter, true, 'optional')
    assert.equal(report.result, 'initialize-compatible', JSON.stringify({ stages: report.stages, reason: report.reason,
      gaps: report.coverageGaps, profileGaps: report.profileGraph?.gaps, applicationGaps: report.applicationGraph?.gaps }))
    assert.equal(report.profile, `dsh-lark-${adapter}`)
    assert.notEqual(report.profileGraph?.digest, report.applicationGraph?.digest)
    assert.equal(report.profileGraph?.roots.find(root => root.name === 'dsh-feishu-bot')?.versionStatus, 'linked')
    assert.equal(report.profileGraph?.roots.length, 3)
    assert.ok(report.profileGraph?.roots.some(root => root.name.endsWith(adapter === 'sdk' ? 'sdk-jsonrpc-server' : 'dsh-acp') && root.version === '0.1.0-rc.8'))
    const cell: DshAdapterExpectedCase = { id: `feishu-node22-${adapter}`, targetId: 'feishu', plugin: report.plugin,
      dshVersion: report.dshVersion, nodeMajor: 22, adapter, profile: report.profile, recipe: report.recipe,
      platform: 'linux', architecture: 'arm64', profileEnvironment: report.profileEnvironment,
      expectedArtifactSha256: report.artifact!.sha256, sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      contractFingerprint: `sha256:${'b'.repeat(64)}`, versionRole: 'target', allowedBuilds: '', reasons: ['fixture'] }
    assert.doesNotThrow(() => parseDshAdapterExpectedCase({ ...cell, id: `feishu-node20-${adapter}`, nodeMajor: 20,
      profileEnvironment: { pnpmVersion: '10.33.0', overrides: {} } }), 'Node 20 adapter cases retain their own explicit runtime; this is not a compatibility pass')
    const isolated = { ...report, runtime: { nodeVersion: '22.23.2', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' } }
    const accepted = mergeDshAdapterLedger(emptyDshAdapterLedger(), cell, isolated)
    assert.equal(accepted.ledger.entries[0]?.report.result, 'initialize-compatible')
    assert.equal(mergeDshAdapterLedger(accepted.ledger, cell, isolated).transitions.length, 0)
    assert.throws(() => mergeDshAdapterLedger(emptyDshAdapterLedger(), cell, { ...isolated,
      artifact: { ...isolated.artifact, sha256: 'c'.repeat(64) } }), /artifact/)
    assert.throws(() => mergeDshAdapterLedger(emptyDshAdapterLedger(), cell, { ...isolated,
      stages: { ...isolated.stages, profileGraph: 'failed' } }), /independent|evidence/)
    assert.throws(() => mergeDshAdapterLedger(emptyDshAdapterLedger(), cell, { ...isolated,
      profileEnvironment: undefined }), /environment/)
    const incomplete = structuredClone(isolated)
    incomplete.profileGraph!.roots.pop()
    assert.throws(() => mergeDshAdapterLedger(emptyDshAdapterLedger(), cell, incomplete), /graph|digest/)
  }
})

it('does not turn a green author CLI doctor into SDK compatibility without its independent managed-profile graph', async () => {
  const bytes = makeTarball([
    { path: 'package/package.json', contents: JSON.stringify({ name: 'dsh-feishu-bot', version: '0.19.16', dsh: { bundle: { patch: './cordis.patch.yml' } } }) },
    { path: 'package/cordis.patch.yml', contents: '[]\n' },
  ])
  const report = await observeDshAuthorAdapter({ packageSpec: 'dsh-feishu-bot@0.19.16', dshVersion: '0.1.5-rc.2', adapter: 'sdk',
    expectedArtifactSha256: createHash('sha256').update(bytes).digest('hex'),
    profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} }, allowExecution: true,
    hostEnvironment: { PATH: process.env.PATH, GITHUB_TOKEN: 'never-forward-this', OPENAI_API_KEY: 'never-forward-this' },
    runner: async command => {
      assert.equal(command.env.GITHUB_TOKEN, undefined)
      assert.equal(command.env.OPENAI_API_KEY, undefined)
      assert.equal(command.env.DSH_LARK_UPGRADE_CHECK, '0')
      assert.equal(command.env.npm_config_ignore_scripts, 'true')
      assert.equal(command.env.PNPM_CONFIG_FROZEN_LOCKFILE, 'false', 'author-managed profiles must be allowed to create their own lockfile in CI')
      if (command.phase === 'artifact') await writeFile(join(command.cwd, 'plugin.tgz'), bytes)
      return { code: 0, timedOut: false, outputExceeded: false,
        stdout: command.phase === 'runtime' ? '11.7.0' : command.phase === 'artifact' ? 'plugin.tgz' : command.phase === 'load' ? 'adapter: sdk\ndsh: ok (sdk-server@0.1.0-rc.8)\n' : '', stderr: '' }
    } })
  assert.equal(report.stages.initialize, 'passed')
  assert.equal(report.stages.profileGraph, 'failed')
  assert.equal(report.result, 'unknown')
  assert.ok(report.coverageGaps.some(gap => /managed.profile/i.test(gap)))
})
