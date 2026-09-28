import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compileDshActiveAgentPolicy,
  parseDshActiveAgentPolicy,
} from '../src/dsh-active-agent-policy.js'

const observerTargets = {
  schema: 'upstream-radar.observer-targets/v1alpha1',
  targets: [
    { id: 'deepseek-harness', ecosystem: 'dsh', repository: 'deepseek-ai/deepseek-harness', ref: 'master',
      packageName: '@deepseek-ai/dsh', packageTag: 'next', packagePath: 'apps/cli/package.json',
      lockfile: 'pnpm-lock.yaml', lockfileType: 'pnpm' },
    { id: 'dsh-context', ecosystem: 'dsh', repository: 'bowenliang123/dsh-context', ref: 'main',
      packageName: 'dsh-context', packagePath: 'package.json', lockfile: 'pnpm-lock.yaml', lockfileType: 'pnpm' },
  ],
}

const installTargets = {
  schema: 'upstream-radar.dsh-install-targets/v1alpha1',
  refreshAfterHours: 168,
  environmentRecommendationsRequired: true,
  runtimeProfiles: [],
  plugins: [{ id: 'context', spec: 'dsh-context@0.25.3', observerTargetId: 'dsh-context', reason: 'fixture' }],
}

describe('unified active Agent policy', () => {
  it('keeps Agent inference as the default while selecting one DSH release channel', () => {
    const compiled = compileDshActiveAgentPolicy({
      schema: 'upstream-radar.dsh-active-agent-policy/v1alpha1',
      dsh: { channel: 'next' },
      defaults: {},
      plugins: [],
    }, observerTargets, installTargets)
    assert.equal(compiled.observerTargets.targets[0]?.packageTag, 'next')
    assert.equal(compiled.observerTargets.targets[0]?.packageVersion, undefined)
    assert.equal(compiled.installTargets.plugins[0]?.analysisPolicy, undefined)
  })

  it('compiles exact artifact selectors plus Node/profile overrides without replacing Agent review', () => {
    const compiled = compileDshActiveAgentPolicy({
      schema: 'upstream-radar.dsh-active-agent-policy/v1alpha1',
      dsh: { version: '0.1.7-rc.2', sourceRef: 'd'.repeat(40) },
      defaults: { nodeMajors: [22, 24] },
      plugins: [{ targetId: 'context', version: '0.59.0', sourceRef: 'c'.repeat(40),
        executionProfiles: ['web'] }],
    }, observerTargets, installTargets)
    const dsh = compiled.observerTargets.targets.find(target => target.id === 'deepseek-harness')
    const plugin = compiled.observerTargets.targets.find(target => target.id === 'dsh-context')
    assert.deepEqual({ ref: dsh?.ref, tag: dsh?.packageTag, version: dsh?.packageVersion }, {
      ref: 'd'.repeat(40), tag: undefined, version: '0.1.7-rc.2',
    })
    assert.deepEqual({ ref: plugin?.ref, version: plugin?.packageVersion }, {
      ref: 'c'.repeat(40), version: '0.59.0',
    })
    assert.deepEqual(compiled.installTargets.plugins[0]?.analysisPolicy, {
      fingerprint: compiled.installTargets.plugins[0]?.analysisPolicy?.fingerprint,
      pluginVersion: '0.59.0',
      nodeMajors: [22, 24],
      executionProfiles: ['web'],
    })
    assert.match(compiled.installTargets.plugins[0]?.analysisPolicy?.fingerprint ?? '', /^sha256:[a-f0-9]{64}$/)
  })

  it('rejects ambiguous selectors and exact versions without a matching source ref', () => {
    assert.throws(() => parseDshActiveAgentPolicy({
      schema: 'upstream-radar.dsh-active-agent-policy/v1alpha1',
      dsh: { channel: 'next', version: '0.1.7-rc.2', sourceRef: 'main' },
      plugins: [],
    }), /exactly one of channel or version/)
    assert.throws(() => parseDshActiveAgentPolicy({
      schema: 'upstream-radar.dsh-active-agent-policy/v1alpha1',
      dsh: { version: '0.1.7-rc.2' },
      plugins: [],
    }), /sourceRef/)
    assert.throws(() => parseDshActiveAgentPolicy({
      schema: 'upstream-radar.dsh-active-agent-policy/v1alpha1',
      dsh: { channel: 'next' },
      plugins: [{ targetId: 'context', version: '0.59.0' }],
    }), /sourceRef/)
  })
})
