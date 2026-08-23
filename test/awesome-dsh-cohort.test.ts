import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { parseDshInstallTargets } from '../src/dsh-install-plan.js'
import { parseObserverConfigText } from '../src/upstream-observer.js'

interface CohortPlugin {
  id: string
  catalogUrl: string
  repository: string
  ref: string
  packagePath: string
  distribution: {
    kind: 'npm' | 'github' | 'repository-installer'
    name?: string
    selectedVersion?: string
  }
}

interface Cohort {
  schema: string
  source: { commit: string; entryCount: number }
  plugins: CohortPlugin[]
}

describe('awesome-dsh-plugin monitored cohort', () => {
  it('keeps catalog provenance, static targets and executable npm targets aligned', async () => {
    const cohort = JSON.parse(await readFile('examples/dsh/awesome-observer/cohort.json', 'utf8')) as Cohort
    const observer = parseObserverConfigText(await readFile('examples/upstream-observer/targets.yml', 'utf8'))
    const installTargets = parseDshInstallTargets(JSON.parse(
      await readFile('examples/dsh/install-observer/targets.json', 'utf8'),
    ) as unknown)

    assert.equal(cohort.schema, 'upstream-radar.awesome-dsh-cohort/v1alpha1')
    assert.match(cohort.source.commit, /^[0-9a-f]{40}$/)
    assert.ok(cohort.source.entryCount >= cohort.plugins.length)
    assert.equal(cohort.plugins.length, 8)
    assert.equal(new Set(cohort.plugins.map(plugin => plugin.id)).size, cohort.plugins.length)

    const importedIds = new Set(cohort.plugins.map(plugin => plugin.id))
    const importedObserverTargets = observer.targets.filter(target => importedIds.has(target.id))
    assert.equal(importedObserverTargets.length, cohort.plugins.length)

    for (const plugin of cohort.plugins) {
      assert.ok(plugin.catalogUrl.toLowerCase().startsWith(`https://github.com/${plugin.repository.toLowerCase()}`))
      const observed = importedObserverTargets.find(target => target.id === plugin.id)
      assert.ok(observed, `missing observer target for ${plugin.id}`)
      assert.equal(observed.repository, plugin.repository)
      assert.equal(observed.ref, plugin.ref)
      assert.equal(observed.packagePath, plugin.packagePath)
    }

    const npmPlugins = cohort.plugins.filter(plugin => plugin.distribution.kind === 'npm')
    const sourceOnlyPlugins = cohort.plugins.filter(plugin => plugin.distribution.kind !== 'npm')
    assert.equal(npmPlugins.length, 6)
    assert.deepEqual(sourceOnlyPlugins.map(plugin => plugin.id).sort(), ['aegis', 'dsh-browser'])
    assert.equal(
      cohort.plugins.find(plugin => plugin.id === 'dsh-browser')?.catalogUrl,
      'https://github.com/Lum1104/dsh-browser/tree/main/packages/browser/bridge-browser',
    )

    for (const plugin of npmPlugins) {
      assert.ok(plugin.distribution.name)
      assert.ok(plugin.distribution.selectedVersion)
      const executable = installTargets.plugins.find(target => target.observerTargetId === plugin.id)
      assert.ok(executable, `missing isolated install target for ${plugin.id}`)
      assert.equal(executable.spec, `${plugin.distribution.name}@${plugin.distribution.selectedVersion}`)
    }

    for (const plugin of sourceOnlyPlugins) {
      const observed = importedObserverTargets.find(target => target.id === plugin.id)
      assert.equal(observed?.observeNpm, false)
      assert.equal(installTargets.plugins.some(target => target.observerTargetId === plugin.id), false)
    }

    // The published OpenPencil artifact declares Node >=24.11. Running its
    // maintained cell on Node 22 only proves the engine gate, not DSH behavior.
    assert.deepEqual(
      installTargets.plugins.find(target => target.id === 'openpencil')?.runtimeProfiles,
      ['node24'],
    )
  })
})
