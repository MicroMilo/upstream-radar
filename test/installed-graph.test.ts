import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { findDependencyPaths } from '../src/graph.js'
import { parseInstalledNodeModulesGraph } from '../src/installed-graph.js'

async function writeManifest(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`)
}

describe('installed DSH dependency graph', () => {
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
      assert.equal(graph.unresolved, undefined)
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
})
