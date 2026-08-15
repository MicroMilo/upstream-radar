import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRadarConfigFromDshProfile, resolveDshProfileDirectory, writeDshPatch, writeRadarConfig } from '../src/init.js'

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
})
