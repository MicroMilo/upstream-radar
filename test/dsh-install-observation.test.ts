import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import {
  observeDshPluginInstall,
  parseDshInstallTrace,
  renderDshInstallObservation,
  type InstallObservationCommand,
  type InstallObservationCommandResult,
} from '../src/dsh-install-observation.js'
import { makeTarball } from './helpers/tar.js'

const TRACE = `420 execve("/usr/bin/node", ["node", "scripts/postinstall.js"], 0x7ffe) = 0
420 connect(18, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.10")}, 16) = 0
420 openat(AT_FDCWD, "/sandbox/dsh-home/profiles/headless/install.log", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 18
420 openat2(AT_FDCWD, "/sandbox/dsh-home/profiles/headless/read-only.json", {flags=O_RDONLY, resolve=RESOLVE_CACHED}, 24) = 19
420 mkdir("/sandbox/dsh-home/profiles/headless/generated", 0777) = 0
420 unlink("/sandbox/dsh-home/profiles/headless/temporary", 0) = -1 ENOENT (No such file or directory)
`

function passed(overrides: Partial<InstallObservationCommandResult> = {}): InstallObservationCommandResult {
  return {
    code: 0,
    timedOut: false,
    outputExceeded: false,
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

describe('DSH install observation', () => {
  it('turns bounded strace evidence into process, network and file-write events', () => {
    const observation = parseDshInstallTrace([TRACE], '/sandbox')

    assert.equal(observation.coverage.status, 'captured')
    assert.equal(observation.processes[0]?.executable, '/usr/bin/node')
    assert.deepEqual(observation.processes[0]?.arguments, ['node', 'scripts/postinstall.js'])
    assert.equal(observation.network[0]?.address, '203.0.113.10')
    assert.equal(observation.network[0]?.port, 443)
    assert.equal(observation.fileWrites[0]?.path, '$SANDBOX/dsh-home/profiles/headless/install.log')
    assert.equal(observation.fileWrites[0]?.operation, 'openat')
    assert.equal(observation.fileWrites.some(event => event.path.endsWith('/read-only.json')), false)
    assert.equal(observation.fileWrites.some(event => event.operation === 'unlink' && event.succeeded === false), true)
  })

  it('refuses execution unless the caller explicitly accepts third-party code', async () => {
    let calls = 0
    await assert.rejects(
      observeDshPluginInstall({
        packageSpec: 'example-plugin@1.0.0',
        dshVersion: '0.1.0-rc.8',
        allowExecution: false,
        isolationProvider: 'github-actions-hosted-runner',
        runner: async () => {
          calls += 1
          return passed()
        },
      }),
      /explicit execution consent/,
    )
    assert.equal(calls, 0)
  })

  it('does not fetch the artifact when the package-manager version is not exact', async () => {
    const phases: InstallObservationCommand['phase'][] = []
    const report = await observeDshPluginInstall({
      packageSpec: 'example-plugin@1.0.0',
      dshVersion: '0.1.0-rc.8',
      allowExecution: true,
      isolationProvider: 'other',
      runner: async command => {
        phases.push(command.phase)
        return passed({ stdout: 'unknown\n' })
      },
    })

    assert.equal(report.result, 'unknown')
    assert.equal(report.stages.runtime.status, 'failed')
    assert.deepEqual(phases, ['runtime'])
  })

  it('stops before DSH or plugin execution when the exact artifact excludes the isolated Node runtime', async () => {
    const phases: InstallObservationCommand['phase'][] = []
    const report = await observeDshPluginInstall({
      packageSpec: 'future-plugin@1.0.0',
      dshVersion: '0.1.1-rc.1',
      allowExecution: true,
      isolationProvider: 'github-actions-hosted-runner',
      runner: async command => {
        phases.push(command.phase)
        if (command.phase === 'runtime') return passed({ stdout: '11.7.0\n' })
        if (command.phase === 'artifact') {
          await writeFile(join(command.cwd, 'future-plugin-1.0.0.tgz'), makeTarball([
            { path: 'package/package.json', contents: JSON.stringify({
              name: 'future-plugin',
              version: '1.0.0',
              engines: { node: '>=999.0.0' },
              dsh: { bundle: { patch: 'cordis.patch.yml' } },
            }) },
            { path: 'package/cordis.patch.yml', contents: '[]\n' },
          ]))
          return passed({ stdout: JSON.stringify([{ filename: 'future-plugin-1.0.0.tgz' }]) })
        }
        throw new Error(`unexpected execution phase: ${command.phase}`)
      },
    })

    assert.equal(report.result, 'runtime-incompatible')
    assert.equal(report.artifact.nodeEngine, '>=999.0.0')
    assert.equal(report.stages.artifact.status, 'passed')
    assert.equal(report.stages.profile.status, 'skipped')
    assert.equal(report.stages.install.status, 'skipped')
    assert.equal(report.stages.load.status, 'skipped')
    assert.deepEqual(phases, ['runtime', 'artifact'])
    assert.match(report.reason, /declares Node >=999\.0\.0/)
    assert.match(renderDshInstallObservation(report), /RUNTIME-INCOMPATIBLE/)
  })

  it('observes one exact artifact through DSH install and load without inheriting host secrets', async () => {
    const calls: InstallObservationCommand[] = []
    let hostRuntimeEntry: string | undefined
    const runner = async (command: InstallObservationCommand): Promise<InstallObservationCommandResult> => {
      calls.push(command)
      assert.equal(command.env.GITHUB_TOKEN, undefined)
      assert.equal(command.env.ISSUE_LOCATOR_LLM_API_KEY, undefined)

      if (command.phase === 'runtime') return passed({ stdout: '11.7.0\n' })

      if (command.phase === 'artifact') {
        const artifactPath = join(command.cwd, 'example-plugin-1.0.0.tgz')
        await writeFile(artifactPath, makeTarball([
          { path: 'package/package.json', contents: JSON.stringify({
            name: 'example-plugin',
            version: '1.0.0',
            engines: { node: '>=18.0.0' },
            peerDependencies: { 'host-runtime': '^2.0.0' },
            scripts: { postinstall: 'node scripts/postinstall.js' },
            dsh: { bundle: { patch: './cordis.patch.yml' } },
          }) },
          { path: 'package/cordis.patch.yml', contents: '[]\n' },
        ]))
        return passed({ stdout: JSON.stringify([{ filename: 'example-plugin-1.0.0.tgz', integrity: 'sha512-demo' }]) })
      }

      if (command.phase === 'install') {
        assert.equal(command.env.NPM_CONFIG_IGNORE_SCRIPTS, 'false')
        assert.equal(command.args.at(-1), join(command.cwd, 'example-plugin-1.0.0.tgz'))
        const dshHome = command.env.DSH_HOME
        assert.equal(typeof dshHome, 'string')
        const profileDirectory = join(dshHome as string, 'profiles', 'headless')
        await mkdir(join(profileDirectory, 'node_modules', '.pnpm'), { recursive: true })
        await mkdir(join(profileDirectory, 'node_modules', 'example-plugin'), { recursive: true })
        await mkdir(join(profileDirectory, 'generated'), { recursive: true })
        await writeFile(join(profileDirectory, 'generated', 'install.txt'), 'created during install\n')
        await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
          dsh: { profile: { bundles: ['example-plugin'] } },
        }))
        await writeFile(join(profileDirectory, 'node_modules', 'example-plugin', 'package.json'), JSON.stringify({
          name: 'example-plugin',
          version: '1.0.0',
          peerDependencies: { 'host-runtime': '^2.0.0' },
        }))
        const cacheHome = command.env.XDG_CACHE_HOME
        assert.equal(typeof cacheHome, 'string')
        const dshRuntimeNodeModules = join(cacheHome as string, 'pnpm', 'dlx', 'fixture', 'node_modules')
        await mkdir(join(dshRuntimeNodeModules, '@deepseek-ai', 'dsh'), { recursive: true })
        await writeFile(join(dshRuntimeNodeModules, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh',
          version: '0.1.0-rc.8',
        }))
        await mkdir(join(dshRuntimeNodeModules, 'host-runtime'), { recursive: true })
        await writeFile(join(dshRuntimeNodeModules, 'host-runtime', 'package.json'), JSON.stringify({
          name: 'host-runtime',
          version: '2.1.0',
        }))
        hostRuntimeEntry = join(dshRuntimeNodeModules, 'host-runtime', 'index.js')
        await writeFile(hostRuntimeEntry, 'export {}\n')
        // DSH currently keeps the resolved profile graph in pnpm's virtual
        // store rather than beside the profile manifest.
        await writeFile(join(profileDirectory, 'node_modules', '.pnpm', 'lock.yaml'), `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      example-plugin:
        specifier: 1.0.0
        version: 1.0.0

packages:
  'example-plugin@1.0.0': {}

snapshots:
  'example-plugin@1.0.0':
    dependencies:
      missing-dependency: 1.0.0
`)
      }

      if (command.phase === 'load') {
        assert.equal(command.command, process.execPath)
        const probe = await readFile(command.args[0] as string, 'utf8')
        assert.match(probe, /await import\("example-plugin"\)/)
        assert.match(probe, /"--profile","headless","--help"/)
        assert.notEqual(hostRuntimeEntry, undefined)
        await writeFile(join(command.cwd, '.upstream-radar-peer-resolution.json'), JSON.stringify({
          schema: 'upstream-radar.profile-peer-resolution/v1alpha1',
          peers: [{ name: 'host-runtime', status: 'resolved', url: pathToFileURL(hostRuntimeEntry as string).href }],
        }))
      }

      if (command.tracePath !== undefined) {
        await writeFile(command.tracePath, TRACE.replaceAll('/sandbox', command.sandboxRoot))
      }
      return passed()
    }

    const report = await observeDshPluginInstall({
      packageSpec: 'example-plugin@1.0.0',
      dshVersion: '0.1.0-rc.8',
      caseId: 'example-node22',
      allowExecution: true,
      isolationProvider: 'github-actions-hosted-runner',
      hostEnvironment: {
        PATH: '/usr/bin:/bin',
        GITHUB_TOKEN: 'must-not-cross-boundary',
        ISSUE_LOCATOR_LLM_API_KEY: 'must-not-cross-boundary',
      },
      runner,
    })

    assert.equal(report.result, 'compatible')
    assert.equal(report.caseId, 'example-node22')
    assert.equal(report.artifact.name, 'example-plugin')
    assert.equal(report.artifact.version, '1.0.0')
    assert.equal(report.artifact.nodeEngine, '>=18.0.0')
    assert.match(report.artifact.sha256 ?? '', /^[0-9a-f]{64}$/)
    assert.deepEqual(report.artifact.lifecycleScripts, ['postinstall'])
    assert.equal(report.runtime.packageManager.version, '11.7.0')
    assert.match(report.resolution.profileLockfile?.sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.match(report.resolution.profileLockfile?.graphDigest ?? '', /^sha256:[a-f0-9]{64}$/)
    assert.equal(report.resolution.profileLockfile?.nodes, 2)
    assert.equal(report.resolution.profileLockfile?.edges, 1)
    assert.equal(report.resolution.profileLockfile?.unresolved, 1)
    assert.deepEqual(report.resolution.profileLockfile?.unresolvedDependencies, [{
      from: 'pnpm:example-plugin@1.0.0',
      name: 'missing-dependency',
      spec: '1.0.0',
      kind: 'runtime',
    }])
    assert.equal(report.resolution.runtimeGraphError, undefined)
    assert.match(report.resolution.runtimeGraph?.digest ?? '', /^sha256:[a-f0-9]{64}$/)
    assert.equal(report.resolution.runtimeGraph?.nodes, 3)
    assert.equal(report.resolution.runtimeGraph?.edges, 2)
    assert.equal(report.resolution.runtimeGraph?.unresolved, 0)
    assert.deepEqual(report.resolution.runtimeGraph?.pluginPeerContracts, {
      declared: 1,
      satisfied: 1,
      mismatched: 0,
      indeterminate: 0,
      missing: 0,
      relations: [{
        name: 'host-runtime',
        required: '^2.0.0',
        status: 'satisfied',
        resolvedVersion: '2.1.0',
      }],
    })
    assert.deepEqual(report.resolution.runtimeGraph?.hostRuntime, {
      source: 'dsh-process',
      resolvedNodes: 2,
      dshVersion: '0.1.0-rc.8',
    })
    assert.deepEqual(report.boundary.approvedDependencyBuilds, [])
    assert.equal(report.stages.registration.status, 'passed')
    assert.equal(report.observations.install.processes.length, 1)
    assert.equal(report.observations.install.fileWrites.length >= 1, true)
    assert.equal(report.filesystem.install.created.some(path => path.endsWith('/generated/install.txt')), true)
    assert.equal(calls.map(call => call.phase).join(','), 'runtime,artifact,profile,install,load')
    assert.match(calls.find(call => call.phase === 'load')?.args[0] ?? '', /\.upstream-radar-load-probe\.mjs$/)
    assert.match(renderDshInstallObservation(report), /COMPATIBLE/)
    assert.match(renderDshInstallObservation(report), /pnpm 11\.7\.0/)
    assert.match(renderDshInstallObservation(report), /Plugin Node requirement: >=18\.0\.0/)
    assert.match(renderDshInstallObservation(report), /Approved dependency builds: none/)
    assert.match(renderDshInstallObservation(report), /Lifecycle scripts declared: postinstall/)
  })

  it('does not call a successful load compatible when the DSH host violates a required plugin peer range', async () => {
    let hostRuntimeEntry: string | undefined
    const runner = async (command: InstallObservationCommand): Promise<InstallObservationCommandResult> => {
      if (command.phase === 'runtime') return passed({ stdout: '11.7.0\n' })
      if (command.phase === 'artifact') {
        await writeFile(join(command.cwd, 'mismatch-plugin-1.0.0.tgz'), makeTarball([
          { path: 'package/package.json', contents: JSON.stringify({
            name: 'mismatch-plugin',
            version: '1.0.0',
            peerDependencies: { 'host-runtime': '^3.0.0' },
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
          }) },
          { path: 'package/cordis.patch.yml', contents: '[]\n' },
        ]))
        return passed({ stdout: JSON.stringify([{ filename: 'mismatch-plugin-1.0.0.tgz' }]) })
      }
      if (command.phase === 'install') {
        const dshHome = command.env.DSH_HOME as string
        const profileDirectory = join(dshHome, 'profiles', 'headless')
        await mkdir(join(profileDirectory, 'node_modules', 'mismatch-plugin'), { recursive: true })
        await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
          dsh: { profile: { bundles: ['mismatch-plugin'] } },
        }))
        await writeFile(join(profileDirectory, 'node_modules', 'mismatch-plugin', 'package.json'), JSON.stringify({
          name: 'mismatch-plugin',
          version: '1.0.0',
          peerDependencies: { 'host-runtime': '^3.0.0' },
        }))
        const dshRuntimeNodeModules = join(command.env.XDG_CACHE_HOME as string, 'pnpm', 'dlx', 'fixture', 'node_modules')
        await mkdir(join(dshRuntimeNodeModules, '@deepseek-ai', 'dsh'), { recursive: true })
        await writeFile(join(dshRuntimeNodeModules, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh',
          version: '0.1.0-rc.8',
        }))
        await mkdir(join(dshRuntimeNodeModules, 'host-runtime'), { recursive: true })
        await writeFile(join(dshRuntimeNodeModules, 'host-runtime', 'package.json'), JSON.stringify({
          name: 'host-runtime',
          version: '2.1.0',
        }))
        hostRuntimeEntry = join(dshRuntimeNodeModules, 'host-runtime', 'index.js')
        await writeFile(hostRuntimeEntry, 'export {}\n')
      }
      if (command.phase === 'load') {
        assert.notEqual(hostRuntimeEntry, undefined)
        await writeFile(join(command.cwd, '.upstream-radar-peer-resolution.json'), JSON.stringify({
          schema: 'upstream-radar.profile-peer-resolution/v1alpha1',
          peers: [{ name: 'host-runtime', status: 'resolved', url: pathToFileURL(hostRuntimeEntry as string).href }],
        }))
      }
      if (command.tracePath !== undefined) await writeFile(command.tracePath, TRACE.replaceAll('/sandbox', command.sandboxRoot))
      return passed()
    }

    const report = await observeDshPluginInstall({
      packageSpec: 'mismatch-plugin@1.0.0',
      dshVersion: '0.1.0-rc.8',
      allowExecution: true,
      isolationProvider: 'other',
      runner,
    })

    assert.equal(report.stages.load.status, 'passed')
    assert.equal(report.result, 'peer-contract-incompatible')
    assert.match(report.reason, /host-runtime@2\.1\.0 does not satisfy \^3\.0\.0/)
    assert.deepEqual(report.resolution.runtimeGraph?.pluginPeerContracts, {
      declared: 1,
      satisfied: 0,
      mismatched: 1,
      indeterminate: 0,
      missing: 0,
      relations: [{
        name: 'host-runtime',
        required: '^3.0.0',
        status: 'mismatched',
        resolvedVersion: '2.1.0',
      }],
      issues: [{
        name: 'host-runtime',
        required: '^3.0.0',
        status: 'mismatched',
        resolvedVersion: '2.1.0',
      }],
    })
  })

  it('keeps an observed install failure distinct from missing trace evidence', async () => {
    const artifact = makeTarball([
      { path: 'package/package.json', contents: JSON.stringify({
        name: 'broken-plugin',
        version: '1.2.3',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }) },
      { path: 'package/cordis.patch.yml', contents: '[]\n' },
    ])
    const runner = async (command: InstallObservationCommand): Promise<InstallObservationCommandResult> => {
      if (command.phase === 'runtime') return passed({ stdout: '11.7.0\n' })
      if (command.phase === 'artifact') {
        await writeFile(join(command.cwd, 'broken-plugin-1.2.3.tgz'), artifact)
        return passed({ stdout: JSON.stringify([{ filename: 'broken-plugin-1.2.3.tgz' }]) })
      }
      if (command.phase === 'install') {
        if (command.tracePath !== undefined) await writeFile(command.tracePath, TRACE)
        return passed({ code: 1, stderr: 'dependency build failed' })
      }
      return passed()
    }

    const report = await observeDshPluginInstall({
      packageSpec: 'broken-plugin@1.2.3',
      dshVersion: '0.1.0-rc.8',
      allowExecution: true,
      isolationProvider: 'other',
      runner,
    })

    assert.equal(report.result, 'install-failed')
    assert.equal(report.stages.install.status, 'failed')
    assert.match(report.reason, /install command failed/)
  })

  it('passes only explicit validated dependency build approvals to pnpm', async () => {
    let installArgs: string[] = []
    const runner = async (command: InstallObservationCommand): Promise<InstallObservationCommandResult> => {
      if (command.phase === 'runtime') return passed({ stdout: '11.7.0\n' })
      if (command.phase === 'artifact') {
        await writeFile(join(command.cwd, 'approved-plugin-1.0.0.tgz'), makeTarball([
          { path: 'package/package.json', contents: JSON.stringify({
            name: 'approved-plugin',
            version: '1.0.0',
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
          }) },
          { path: 'package/cordis.patch.yml', contents: '[]\n' },
        ]))
        return passed({ stdout: JSON.stringify([{ filename: 'approved-plugin-1.0.0.tgz' }]) })
      }
      if (command.phase === 'install') {
        installArgs = command.args
        if (command.tracePath !== undefined) await writeFile(command.tracePath, TRACE)
        return passed({ code: 1, stderr: 'controlled stop after argument capture' })
      }
      return passed()
    }

    const report = await observeDshPluginInstall({
      packageSpec: 'approved-plugin@1.0.0',
      dshVersion: '0.1.1-rc.1',
      allowExecution: true,
      isolationProvider: 'other',
      allowedBuilds: ['protobufjs', 'protobufjs'],
      runner,
    })

    assert.equal(installArgs.includes('--allow-build=protobufjs'), true)
    assert.deepEqual(report.boundary.approvedDependencyBuilds, ['protobufjs'])
    await assert.rejects(observeDshPluginInstall({
      packageSpec: 'approved-plugin@1.0.0',
      dshVersion: '0.1.1-rc.1',
      allowExecution: true,
      isolationProvider: 'other',
      allowedBuilds: ['--config.dangerouslyAllowAllBuilds=true'],
      runner,
    }), /invalid approved dependency build/)
  })
})
