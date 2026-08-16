import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRadarConfigFromDshProfile, createRadarConfigFromPnpmLock, discoverDshProfiles, refreshRadarConfigFromConfiguredProfile, refreshRadarConfigFromDshProfile, resolveDshProfileDirectory, writeDshPatch, writeRadarConfig } from '../src/init.js'

const graph = {
  schema: 'upstream-radar.dependency-graph/v1alpha1' as const,
  rootNodeId: 'node_modules/demo-plugin',
  nodes: [
    { id: 'node_modules/demo-plugin', name: 'demo-plugin', version: '1.2.3' },
    { id: 'node_modules/parser', name: 'parser', version: '2.9.0' },
  ],
  edges: [{ from: 'node_modules/demo-plugin', to: 'node_modules/parser', kind: 'runtime' as const }],
}

describe('DSH profile initialization', () => {
  it('discovers third-party bundles and writes a reviewable inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-init-'))
    const profile = join(root, 'profiles', 'web')
    try {
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'upstream-radar', 'demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.2.3',
        main: './dist/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))

      const calls: string[] = []
      const config = await createRadarConfigFromDshProfile({
        profileDirectory: profile,
        projectId: 'payments-api',
        projectName: 'Payments API',
        workspace: '/workspace/payments-api',
        channels: ['feishu:payments-security'],
        inspect: async (spec) => {
          calls.push(spec)
          return { evidence: { npm: { dependencyAudit: { graph } } } }
        },
      })

      assert.deepEqual(calls, ['npm:demo-plugin@1.2.3'])
      assert.equal(config.projects[0]?.project.name, 'Payments API')
      assert.equal(config.projects[0]?.plugins[0]?.package.name, 'demo-plugin')
      assert.equal(config.projects[0]?.plugins[0]?.graph.nodes.length, 2)

      const output = join(root, 'upstream-radar.config.json')
      await writeRadarConfig(config, { output })
      const saved = JSON.parse(await readFile(output, 'utf8')) as typeof config
      assert.equal(saved.projects[0]?.plugins[0]?.package.version, '1.2.3')
      await assert.rejects(writeRadarConfig(config, { output }), /already exists/)

      const patch = join(root, 'upstream-radar.dsh.yml')
      await writeDshPatch({
        output: patch,
        configFile: output,
        stateFile: `${output}.state.json`,
        profile: 'web',
      })
      const patchText = await readFile(patch, 'utf8')
      assert.match(patchText, /name: 'upstream-radar\/dsh'/)
      assert.ok(patchText.includes(`configFile: ${JSON.stringify(output)}`))
      assert.ok(patchText.includes(`stateFile: ${JSON.stringify(`${output}.state.json`)}`))
      assert.match(patchText, /runOnStart: true/)
      assert.match(patchText, /profile: "web"/)
      assert.match(patchText, /refreshProfile: true/)
      assert.doesNotMatch(patchText, /UPSTREAM_RADAR_CONFIG|!!js/)
      await writeDshPatch({
        output: patch,
        configFile: output,
        stateFile: `${output}.state.json`,
        profile: 'web',
        intervalSeconds: 300,
        runOnStart: false,
        force: true,
      })
      const customizedPatchText = await readFile(patch, 'utf8')
      assert.match(customizedPatchText, /intervalSeconds: 300/)
      assert.match(customizedPatchText, /runOnStart: false/)
      await writeDshPatch({
        output: patch,
        configFile: output,
        stateFile: `${output}.state.json`,
        profile: 'web',
        registry: 'https://registry.example.test/npm/',
        deepCandidates: false,
        force: true,
      })
      const registryPatchText = await readFile(patch, 'utf8')
      assert.match(registryPatchText, /registry: "https:\/\/registry\.example\.test\/npm\//)
      assert.match(registryPatchText, /deepCandidates: false/)
      await assert.rejects(writeDshPatch({
        output: patch,
        configFile: output,
        stateFile: `${output}.state.json`,
        profile: 'web',
      }), /already exists/)
      await assert.rejects(writeDshPatch({
        output,
        configFile: output,
        stateFile: `${output}.state.json`,
        profile: 'web',
      }), /different from the Radar config/)
      await assert.rejects(writeDshPatch({
        output: join(root, 'invalid.dsh.yml'),
        configFile: output,
        stateFile: `${output}.state.json`,
        profile: 'web',
        intervalSeconds: 299,
      }), /intervalSeconds must be between 300 and 86400/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps profile lookup inside DSH_HOME', () => {
    assert.equal(
      resolveDshProfileDirectory('web', '/tmp/dsh-home'),
      '/tmp/dsh-home/profiles/web',
    )
    assert.throws(
      () => resolveDshProfileDirectory('../outside', '/tmp/dsh-home'),
      /simple DSH profile name/,
    )
  })

  it('auto-discovery returns only profiles with third-party bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-discovery-'))
    try {
      await mkdir(join(root, 'profiles', 'headless'), { recursive: true })
      await writeFile(join(root, 'profiles', 'headless', 'package.json'), JSON.stringify({
        name: 'dsh-profile-headless',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'cordis'] } },
      }))
      await mkdir(join(root, 'profiles', 'web'), { recursive: true })
      await writeFile(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
      }))
      await mkdir(join(root, 'profiles', 'api'), { recursive: true })
      await writeFile(join(root, 'profiles', 'api', 'package.json'), JSON.stringify({
        name: 'dsh-profile-api',
        dsh: { profile: { bundles: ['api-plugin'] } },
      }))

      assert.deepEqual(await discoverDshProfiles(root), ['api', 'web'])
      await rm(join(root, 'profiles', 'api'), { recursive: true, force: true })
      assert.deepEqual(await discoverDshProfiles(root), ['web'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the installed profile tree by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-init-installed-'))
    const profile = join(root, 'profiles', 'web')
    try {
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.2.3',
        dependencies: { parser: '2.9.0' },
      }))
      await mkdir(join(profile, 'node_modules', 'parser'), { recursive: true })
      await writeFile(join(profile, 'node_modules', 'parser', 'package.json'), JSON.stringify({
        name: 'parser',
        version: '2.9.0',
      }))

      const config = await createRadarConfigFromDshProfile({ profileDirectory: profile })
      assert.equal(config.projects[0]?.project.workspace, '.')
      assert.equal(config.projects[0]?.plugins[0]?.graph.source, 'installed-node-modules')
      assert.equal(config.projects[0]?.plugins[0]?.graph.nodes.length, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates a static Radar inventory from a pnpm lockfile project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-init-pnpm-'))
    try {
      const lockfile = join(root, 'pnpm-lock.yaml')
      await writeFile(lockfile, `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      demo-plugin:
        specifier: 1.0.0
        version: 1.0.0

packages:
  'demo-plugin@1.0.0': {}
  'parser@2.9.0': {}

snapshots:
  'demo-plugin@1.0.0':
    dependencies:
      parser: 2.9.0
  'parser@2.9.0': {}
`)

      const config = await createRadarConfigFromPnpmLock({
        lockfile,
        root: { name: 'demo-plugin', version: '1.0.0' },
        projectName: 'Demo DSH plugin',
        channels: ['stdout'],
      })
      assert.equal(config.dshProfile, undefined)
      assert.equal(config.projects[0]?.project.name, 'Demo DSH plugin')
      assert.deepEqual(config.projects[0]?.project.channels, ['stdout'])
      assert.equal(config.projects[0]?.plugins[0]?.graph.source, 'pnpm-lock')
      assert.equal(config.projects[0]?.plugins[0]?.graph.nodes.length, 2)
      assert.equal(config.projects[0]?.plugins[0]?.graph.edges.length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refreshes a generated inventory from the current installed profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-refresh-'))
    const dshHome = join(root, 'dsh-home')
    const profile = join(dshHome, 'profiles', 'web')
    try {
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        dependencies: { parser: '1.0.0' },
      }))
      await mkdir(join(profile, 'node_modules', 'parser'), { recursive: true })
      await writeFile(join(profile, 'node_modules', 'parser', 'package.json'), JSON.stringify({
        name: 'parser',
        version: '1.0.0',
      }))

      const config = await createRadarConfigFromDshProfile({
        profileDirectory: profile,
        projectId: 'demo-project',
        projectName: 'Demo project',
        workspace: '/workspace/demo',
        channels: ['stdout'],
      })
      config.dshProfile = { name: 'web' }

      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '2.0.0',
        dependencies: { parser: '2.0.0' },
      }))
      await writeFile(join(profile, 'node_modules', 'parser', 'package.json'), JSON.stringify({
        name: 'parser',
        version: '2.0.0',
      }))

      const refreshed = await refreshRadarConfigFromDshProfile(config, 'web', dshHome)
      assert.equal(refreshed.projects[0]?.plugins[0]?.package.version, '2.0.0')
      assert.equal(refreshed.projects[0]?.plugins[0]?.graph.nodes.find(node => node.name === 'parser')?.version, '2.0.0')
      assert.deepEqual(refreshed.projects[0]?.project.channels, ['stdout'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses an explicitly discovered DSH process host plane during refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-refresh-host-'))
    const dshHome = join(root, 'dsh-home')
    const profile = join(dshHome, 'profiles', 'web')
    const hostNodeModules = join(root, 'dsh-runtime', 'node_modules')
    try {
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['demo-plugin'] } },
      }))
      await writeFile(join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0' },
      }))
      await mkdir(join(hostNodeModules, '@deepseek-ai', 'dsh-agent'), { recursive: true })
      await writeFile(join(hostNodeModules, '@deepseek-ai', 'dsh-agent', 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-agent',
        version: '0.1.4',
      }))

      const config = await createRadarConfigFromDshProfile({
        profileDirectory: profile,
        projectId: 'demo-project',
        projectName: 'Demo project',
        workspace: '/workspace/demo',
      })
      config.dshProfile = { name: 'web' }

      const refreshed = await refreshRadarConfigFromDshProfile(config, 'web', dshHome, {
        hostNodeModulesDirectory: hostNodeModules,
        hostRuntimeSource: 'dsh-process',
      })
      const graph = refreshed.projects[0]?.plugins[0]?.graph
      assert.deepEqual(graph?.hostRuntime, { source: 'dsh-process', resolvedNodes: 1 })
      assert.deepEqual(graph?.nodes.find(node => node.name === '@deepseek-ai/dsh-agent'), {
        id: 'dsh-host/node_modules/@deepseek-ai/dsh-agent',
        name: '@deepseek-ai/dsh-agent',
        version: '0.1.4',
        source: 'dsh-host',
      })
      assert.equal(graph?.unresolved, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps hand-written inventories static when no DSH profile metadata is present', async () => {
    const config = {
      schema: 'upstream-radar.radar-config/v1alpha1' as const,
      projects: [{
        schema: 'upstream-radar.inventory/v1alpha1' as const,
        project: { id: 'demo', name: 'Demo' },
        plugins: [],
      }],
    }
    assert.equal(await refreshRadarConfigFromConfiguredProfile(config, '/does-not-exist'), config)
  })

  it('does not follow a bundle path outside the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-init-'))
    const profile = join(root, 'profiles', 'web')
    try {
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['../../outside'] } },
      }))
      await assert.rejects(
        createRadarConfigFromDshProfile({ profileDirectory: profile }),
        /escapes the profile node_modules directory/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not read a symlinked bundle manifest outside the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-init-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'upstream-radar-init-outside-'))
    const profile = join(root, 'profiles', 'web')
    try {
      await mkdir(join(profile, 'node_modules'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['demo-plugin'] } },
      }))
      await writeFile(join(outside, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
      await symlink(outside, join(profile, 'node_modules', 'demo-plugin'), 'junction')
      await assert.rejects(
        createRadarConfigFromDshProfile({ profileDirectory: profile }),
        /manifest escapes the DSH profile/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
