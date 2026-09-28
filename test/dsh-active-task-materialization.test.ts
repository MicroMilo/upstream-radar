import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { materializeDshActiveTaskInputs, planDshActiveTaskMaterialization } from '../src/dsh-active-task-materialization.js'
import { emptyDshActiveTaskState, planDshActiveTasks } from '../src/dsh-active-task-state.js'

const commit = (character: string) => character.repeat(40)
const targets = {
  schema: 'upstream-radar.dsh-install-targets/v1alpha1', refreshAfterHours: 168,
  environmentRecommendationsRequired: true, runtimeProfiles: [],
  plugins: [{ id: 'context', spec: 'dsh-context@0.56.2', observerTargetId: 'dsh-context', reason: 'test' }],
}
const observations = {
  schema: 'upstream-radar.observation-state/v1alpha1', pendingTasks: [],
  targets: {
    'deepseek-harness': { source: { repository: 'deepseek-ai/deepseek-harness', ref: 'master',
      commit: commit('f'), packagePath: 'apps/cli/package.json', lockfile: 'pnpm-lock.yaml' },
      package: { name: '@deepseek-ai/dsh', version: '0.1.8', distTag: 'next', integrity: 'sha512-new-dsh' } },
    'dsh-context': { source: { repository: 'bowenliang123/dsh-context', ref: 'main',
      commit: commit('e'), packagePath: 'package.json', lockfile: 'pnpm-lock.yaml' },
      package: { name: 'dsh-context', version: '0.59.0', distTag: 'latest', integrity: 'sha512-new-plugin' } },
  },
}
const taskObservations = structuredClone(observations)
taskObservations.targets['deepseek-harness'].source.commit = commit('d')
taskObservations.targets['deepseek-harness'].package.version = '0.1.7-rc.2'
taskObservations.targets['deepseek-harness'].package.integrity = 'sha512-old-dsh'
taskObservations.targets['dsh-context'].source.commit = commit('c')
taskObservations.targets['dsh-context'].package.version = '0.57.0'
taskObservations.targets['dsh-context'].package.integrity = 'sha512-old-plugin'
const report = { changes: [{ targetId: 'deepseek-harness', meaningful: true,
  source: { beforeCommit: commit('a'), afterCommit: commit('d') },
  previous: { manifest: { version: '0.1.6' } }, current: { manifest: { version: '0.1.7-rc.2' } } }] }

describe('active task exact-input materialization', () => {
  it('rehydrates the persisted versions and commits instead of the newer live observation', () => {
    const dispatch = planDshActiveTasks(targets, taskObservations, report, emptyDshActiveTaskState(),
      new Date('2026-09-28T08:00:00.000Z'))
    const entry = dispatch.matrix.include[0]!
    const plan = planDshActiveTaskMaterialization(dispatch.state, targets, observations,
      entry.taskId, entry.inputFingerprint)
    const output = materializeDshActiveTaskInputs(plan, {
      plugin: { sourceManifest: { name: 'dsh-context', version: '0.57.0', engines: { node: '>=22' } },
        publishedManifest: { name: 'dsh-context', version: '0.57.0',
          dist: { integrity: 'sha512-old-plugin', tarball: 'https://registry.npmjs.org/dsh-context/-/dsh-context-0.57.0.tgz' } } },
      dsh: { sourceManifest: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' },
        publishedManifest: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2',
          dist: { integrity: 'sha512-old-dsh', tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz' } } },
    }, new Date('2026-09-28T09:00:00.000Z'))
    const exact = output.observations as typeof observations
    assert.equal(exact.targets['deepseek-harness'].source.commit, commit('d'))
    assert.equal(exact.targets['deepseek-harness'].package.version, '0.1.7-rc.2')
    assert.equal(exact.targets['dsh-context'].source.commit, commit('c'))
    assert.equal(exact.targets['dsh-context'].package.version, '0.57.0')
    assert.equal(output.targets.plugins.length, 1)
    assert.equal(output.targets.plugins[0]?.spec, 'dsh-context@0.57.0')
  })

  it('rejects registry bytes that do not match the persisted integrity', () => {
    const dispatch = planDshActiveTasks(targets, taskObservations, report, emptyDshActiveTaskState(),
      new Date('2026-09-28T08:00:00.000Z'))
    const entry = dispatch.matrix.include[0]!
    const plan = planDshActiveTaskMaterialization(dispatch.state, targets, observations,
      entry.taskId, entry.inputFingerprint)
    assert.throws(() => materializeDshActiveTaskInputs(plan, {
      plugin: { sourceManifest: { name: 'dsh-context', version: '0.57.0' },
        publishedManifest: { name: 'dsh-context', version: '0.57.0',
          dist: { integrity: 'sha512-wrong', tarball: 'https://registry.npmjs.org/dsh-context/-/dsh-context-0.57.0.tgz' } } },
      dsh: { sourceManifest: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' },
        publishedManifest: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2',
          dist: { integrity: 'sha512-old-dsh', tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz' } } },
    }), /does not match/)
  })

  it('rehydrates the persisted Node/profile policy instead of mutable global configuration', () => {
    const configured = structuredClone(targets)
    const expectedPolicy = {
      fingerprint: `sha256:${'a'.repeat(64)}`,
      pluginVersion: '0.57.0',
      nodeMajors: [22, 24],
      executionProfiles: ['web'],
    }
    Object.assign(configured.plugins[0]!, { analysisPolicy: expectedPolicy })
    const dispatch = planDshActiveTasks(configured, taskObservations, { changes: [] },
      emptyDshActiveTaskState(), new Date('2026-09-28T08:00:00.000Z'))
    const entry = dispatch.matrix.include[0]!
    const plan = planDshActiveTaskMaterialization(dispatch.state, targets, observations,
      entry.taskId, entry.inputFingerprint)
    const output = materializeDshActiveTaskInputs(plan, {
      plugin: { sourceManifest: { name: 'dsh-context', version: '0.57.0' },
        publishedManifest: { name: 'dsh-context', version: '0.57.0',
          dist: { integrity: 'sha512-old-plugin', tarball: 'https://registry.npmjs.org/dsh-context/-/dsh-context-0.57.0.tgz' } } },
      dsh: { sourceManifest: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' },
        publishedManifest: { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2',
          dist: { integrity: 'sha512-old-dsh', tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz' } } },
    })
    assert.deepEqual(output.targets.plugins[0]?.analysisPolicy, expectedPolicy)
    const exact = output.observations as typeof observations & { targets: { 'dsh-context': { package: { versionSelector?: string } } } }
    assert.equal(exact.targets['dsh-context'].package.versionSelector, '0.57.0')
  })
})
