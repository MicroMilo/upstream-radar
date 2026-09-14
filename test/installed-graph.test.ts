import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { findDependencyPaths } from '../src/graph.js'
import { parseInstalledNodeModulesGraph, parseInstalledProfileGraph } from '../src/installed-graph.js'

async function writeManifest(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`)
}

describe('installed DSH dependency graph', () => {
  it('binds independent managed-profile manifests and all direct roots, even when they link the same application', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'upstream-radar-profile-forest-'))
    try {
      const application = join(workspace, 'application')
      await writeManifest(join(application, 'package.json'), { name: 'plugin', version: '1.0.0' })
      for (const version of ['1.0.0', '2.0.0']) {
        const profile = join(workspace, `profiles/sdk-${version}`)
        await writeManifest(join(profile, 'package.json'), { name: `sdk-${version}`, private: true,
          dependencies: { plugin: 'link:../../application', 'sdk-server': version } })
        await writeManifest(join(profile, 'node_modules/sdk-server/package.json'), { name: 'sdk-server', version })
        await symlink(application, join(profile, 'node_modules/plugin'), 'dir')
      }
      const one = await parseInstalledProfileGraph(join(workspace, 'profiles/sdk-1.0.0'), { workspaceDirectory: workspace })
      const two = await parseInstalledProfileGraph(join(workspace, 'profiles/sdk-2.0.0'), { workspaceDirectory: workspace })
      assert.equal(one.roots.length, 2)
      assert.deepEqual(one.gaps, [])
      assert.notEqual(one.manifest.sha256, two.manifest.sha256)
      assert.notEqual(one.digest, two.digest, 'the outer application graph alone cannot describe the managed SDK profile')
      assert.equal(one.roots.find(root => root.name === 'sdk-server')?.version, '1.0.0')
      assert.equal(two.roots.find(root => root.name === 'sdk-server')?.version, '2.0.0')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('keeps an SDK workspace boundary explicit while resolving its actual linked application', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'upstream-radar-sdk-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'upstream-radar-sdk-outside-'))
    try {
      const profile = join(workspace, 'profiles/sdk')
      const application = join(workspace, 'application')
      await writeManifest(join(application, 'package.json'), { name: 'plugin', version: '1.0.0', dependencies: { dep: '2.0.0' } })
      await writeManifest(join(workspace, 'node_modules/dep/package.json'), { name: 'dep', version: '2.0.0' })
      await mkdir(join(profile, 'node_modules'), { recursive: true })
      await symlink(application, join(profile, 'node_modules/plugin'), 'dir')
      await assert.rejects(parseInstalledNodeModulesGraph(profile, { name: 'plugin', version: '1.0.0' }), /escapes/)
      const graph = await parseInstalledNodeModulesGraph(profile, { name: 'plugin', version: '1.0.0' }, { workspaceDirectory: workspace })
      assert.equal(graph.unresolved, undefined)
      assert.equal(graph.rootNodeId, 'application')
      assert.equal(graph.nodes.find(node => node.name === 'dep')?.version, '2.0.0')
      await writeManifest(join(outside, 'package.json'), { name: 'escape', version: '1.0.0' })
      await symlink(outside, join(profile, 'node_modules/escape'), 'dir')
      await assert.rejects(parseInstalledNodeModulesGraph(profile, { name: 'escape', version: '1.0.0' }, { workspaceDirectory: workspace }), /escapes/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('resolves a pnpm profile dependency beside the real package, not beside its public alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-pnpm-'))
    try {
      const plugin = join(root, 'node_modules/.pnpm/plugin@1.0.0/node_modules/plugin')
      const dependency = join(root, 'node_modules/.pnpm/dep@2.0.0/node_modules/dep')
      await writeManifest(join(plugin, 'package.json'), { name: 'plugin', version: '1.0.0', dependencies: { dep: '2.0.0' } })
      await writeManifest(join(dependency, 'package.json'), { name: 'dep', version: '2.0.0' })
      await symlink(plugin, join(root, 'node_modules/plugin'), 'dir')
      await symlink(dependency, join(dirname(plugin), 'dep'), 'dir')
      const graph = await parseInstalledNodeModulesGraph(root, { name: 'plugin', version: '1.0.0' })
      assert.equal(graph.unresolved, undefined, 'pnpm virtual-store siblings are part of the actual resolution graph')
      assert.equal(graph.nodes.find(node => node.name === 'dep')?.version, '2.0.0')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('follows the profile node_modules tree and preserves duplicate versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    try {
      await writeManifest(join(root, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        dependencies: { framework: '2.4.7', logger: '4.0.2' },
      })
      await writeManifest(join(root, 'node_modules', 'framework', 'package.json'), {
        name: 'framework',
        version: '2.4.7',
        dependencies: { parser: '3.2.1', archive: '1.8.0' },
      })
      await writeManifest(join(root, 'node_modules', 'framework', 'node_modules', 'parser', 'package.json'), {
        name: 'parser',
        version: '3.2.1',
      })
      await writeManifest(join(root, 'node_modules', 'archive', 'package.json'), {
        name: 'archive',
        version: '1.8.0',
      })
      await writeManifest(join(root, 'node_modules', 'logger', 'package.json'), {
        name: 'logger',
        version: '4.0.2',
        dependencies: { parser: '2.9.0' },
      })
      await writeManifest(join(root, 'node_modules', 'parser', 'package.json'), {
        name: 'parser',
        version: '2.9.0',
      })

      const graph = await parseInstalledNodeModulesGraph(root, { name: 'plugin', version: '1.0.0' })
      assert.equal(graph.source, 'installed-node-modules')
      assert.equal(graph.nodes.length, 6)
      assert.equal(graph.edges.length, 5)
      const vulnerable = graph.nodes.find(node => node.name === 'parser' && node.version === '2.9.0')
      assert.ok(vulnerable)
      assert.deepEqual(
        findDependencyPaths(graph, vulnerable.id).map(path => path.map(node => `${node.name}@${node.version}`)),
        [['plugin@1.0.0', 'logger@4.0.2', 'parser@2.9.0']],
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an absent installed dependency explicit instead of inventing a version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    try {
      await writeManifest(join(root, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        dependencies: { missing: '1.0.0' },
      })
      const graph = await parseInstalledNodeModulesGraph(root, { name: 'plugin', version: '1.0.0' })
      assert.equal(graph.nodes.length, 1)
      assert.deepEqual(graph.unresolved, [{ from: 'node_modules/plugin', name: 'missing', kind: 'runtime', spec: '1.0.0' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not turn an explicitly optional peer into a required coverage gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    try {
      await writeManifest(join(root, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        peerDependencies: { 'optional-host': '^1.0.0', 'required-host': '^1.0.0' },
        peerDependenciesMeta: { 'optional-host': { optional: true } },
      })
      const graph = await parseInstalledNodeModulesGraph(root, { name: 'plugin', version: '1.0.0' })
      assert.deepEqual(graph.unresolved, [
        { from: 'node_modules/plugin', name: 'optional-host', kind: 'optional', spec: '^1.0.0' },
        { from: 'node_modules/plugin', name: 'required-host', kind: 'peer', spec: '^1.0.0' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('includes DSH host packages separately when a profile resolves a peer from the shared plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    const profile = join(root, 'profiles', 'web')
    const hostNodeModules = join(root, 'profiles', 'node_modules')
    try {
      await writeManifest(join(profile, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        peerDependencies: { 'host-runtime': '^2.0.0' },
      })
      await writeManifest(join(hostNodeModules, 'host-runtime', 'package.json'), {
        name: 'host-runtime',
        version: '2.1.0',
      })

      const graph = await parseInstalledNodeModulesGraph(profile, { name: 'plugin', version: '1.0.0' }, {
        hostNodeModulesDirectory: hostNodeModules,
        hostRuntimeSource: 'dsh-process',
      })
      assert.deepEqual(graph.hostRuntime, { source: 'dsh-process', resolvedNodes: 1 })
      const host = graph.nodes.find(node => node.name === 'host-runtime')
      assert.deepEqual(host, {
        id: 'dsh-host/node_modules/host-runtime',
        name: 'host-runtime',
        version: '2.1.0',
        source: 'dsh-host',
      })
      assert.deepEqual(graph.edges, [{
        from: 'node_modules/plugin',
        to: 'dsh-host/node_modules/host-runtime',
        kind: 'peer',
      }])
      assert.deepEqual(graph.rootPeerContracts, [{
        name: 'host-runtime',
        required: '^2.0.0',
        status: 'satisfied',
        resolvedVersion: '2.1.0',
      }])
      assert.equal(graph.unresolved, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a shared-host symlink that escapes the dependency plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    const profile = join(root, 'profiles', 'web')
    const hostNodeModules = join(root, 'profiles', 'node_modules')
    const outside = join(root, 'outside-host-package')
    try {
      await writeManifest(join(profile, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        peerDependencies: { 'host-runtime': '^2.0.0' },
      })
      await writeManifest(join(outside, 'package.json'), {
        name: 'host-runtime',
        version: '2.1.0',
      })
      await mkdir(hostNodeModules, { recursive: true })
      await symlink(outside, join(hostNodeModules, 'host-runtime'), 'dir')

      await assert.rejects(
        parseInstalledNodeModulesGraph(profile, { name: 'plugin', version: '1.0.0' }, { hostNodeModulesDirectory: hostNodeModules }),
        /escapes the shared dependency plane/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('walks the DSH executable and its transitive dependencies across the host boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    const profile = join(root, 'profiles', 'web')
    const runtimeRoot = join(root, 'dsh-runtime')
    const hostNodeModules = join(runtimeRoot, 'node_modules')
    try {
      await writeManifest(join(profile, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
      })
      await writeManifest(join(runtimeRoot, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.6',
        main: false,
        dependencies: { 'host-parser': '2.0.0' },
      })
      await writeManifest(join(hostNodeModules, 'host-parser', 'package.json'), {
        name: 'host-parser',
        version: '2.0.0',
      })

      const graph = await parseInstalledNodeModulesGraph(profile, { name: 'plugin', version: '1.0.0' }, {
        hostNodeModulesDirectory: hostNodeModules,
        hostRuntimeSource: 'dsh-process',
        hostRuntimePackage: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
        hostRuntimePackageDirectory: runtimeRoot,
      })
      assert.deepEqual(graph.hostRuntime, {
        source: 'dsh-process',
        resolvedNodes: 2,
        package: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
      })
      assert.deepEqual(graph.edges, [
        { from: 'dsh-host/runtime', to: 'dsh-host/node_modules/host-parser', kind: 'runtime' },
        { from: 'node_modules/plugin', to: 'dsh-host/runtime', kind: 'host-runtime' },
      ])
      const parser = graph.nodes.find(node => node.name === 'host-parser')
      assert.ok(parser)
      assert.deepEqual(findDependencyPaths(graph, parser.id).map(path => path.map(node => `${node.name}@${node.version}`)), [[
        'plugin@1.0.0',
        '@deepseek-ai/dsh@0.1.0-rc.6',
        'host-parser@2.0.0',
      ]])
      assert.equal(graph.unresolved, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('follows pnpm virtual-store links beside the exact DSH runtime package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    const profile = join(root, 'profiles', 'web')
    const hostNodeModules = join(root, 'dsh-cache', 'node_modules')
    const runtimeRoot = join(
      hostNodeModules,
      '.pnpm',
      '@deepseek-ai+dsh@0.1.0-rc.8',
      'node_modules',
      '@deepseek-ai',
      'dsh',
    )
    const cordisRoot = join(
      hostNodeModules,
      '.pnpm',
      '@deepseek-ai+cordis@4.0.2',
      'node_modules',
      '@deepseek-ai',
      'cordis',
    )
    try {
      await writeManifest(join(profile, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
      })
      await writeManifest(join(runtimeRoot, 'package.json'), {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.8',
        dependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      })
      await writeManifest(join(cordisRoot, 'package.json'), {
        name: '@deepseek-ai/cordis',
        version: '4.0.2',
      })
      await symlink(cordisRoot, join(dirname(runtimeRoot), 'cordis'), 'dir')

      const graph = await parseInstalledNodeModulesGraph(profile, { name: 'plugin', version: '1.0.0' }, {
        hostNodeModulesDirectory: hostNodeModules,
        hostRuntimeSource: 'dsh-process',
        hostRuntimePackage: { ecosystem: 'npm', name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' },
        hostRuntimePackageDirectory: runtimeRoot,
      })

      assert.equal(graph.unresolved, undefined)
      assert.equal(graph.nodes.length, 3)
      assert.deepEqual(graph.edges.map(edge => edge.kind), ['runtime', 'peer', 'host-runtime'])
      assert.equal(graph.nodes.find(node => node.name === '@deepseek-ai/cordis')?.version, '4.0.2')
      assert.deepEqual(graph.rootPeerContracts, [{
        name: '@deepseek-ai/cordis',
        required: '^4.0.0',
        status: 'satisfied',
        resolvedVersion: '4.0.2',
      }])
      assert.equal(graph.hostRuntime?.resolvedNodes, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps missing, mismatched, and indeterminate root peer contracts distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-installed-graph-'))
    try {
      await writeManifest(join(root, 'node_modules', 'plugin', 'package.json'), {
        name: 'plugin',
        version: '1.0.0',
        peerDependencies: {
          'host-mismatch': '^3.0.0',
          'host-unknown': 'git+https://example.invalid/host.git',
          'host-missing': '^1.0.0',
        },
      })
      await writeManifest(join(root, 'node_modules', 'host-mismatch', 'package.json'), {
        name: 'host-mismatch',
        version: '2.1.0',
      })
      await writeManifest(join(root, 'node_modules', 'host-unknown', 'package.json'), {
        name: 'host-unknown',
        version: '1.0.0',
      })

      const graph = await parseInstalledNodeModulesGraph(root, { name: 'plugin', version: '1.0.0' })
      assert.deepEqual(graph.rootPeerContracts, [
        { name: 'host-mismatch', required: '^3.0.0', status: 'mismatched', resolvedVersion: '2.1.0' },
        { name: 'host-missing', required: '^1.0.0', status: 'missing' },
        { name: 'host-unknown', required: 'git+https://example.invalid/host.git', status: 'indeterminate', resolvedVersion: '1.0.0' },
      ])
      assert.deepEqual(graph.unresolved, [{
        from: 'node_modules/plugin',
        name: 'host-missing',
        kind: 'peer',
        spec: '^1.0.0',
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
