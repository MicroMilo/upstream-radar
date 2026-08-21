import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDshInstallPlan, parseDshInstallTargets } from '../src/dsh-install-plan.js'

const corpus = {
  schema: 'upstream-radar.dsh-install-targets/v1alpha1',
  plugins: [
    { id: 'feishu', spec: 'dsh-feishu-bot@0.16.0', observerTargetId: 'dsh-feishu-bot', allowedBuilds: ['protobufjs'], reason: 'messaging plugin' },
    { id: 'browser', spec: 'dsh-browser@1.2.3', reason: 'browser plugin' },
  ],
}

function state(dshVersion = '0.1.0-rc.8', feishuVersion = '0.16.1'): unknown {
  return {
    targets: {
      'deepseek-harness': { package: { name: '@deepseek-ai/dsh', version: dshVersion } },
      'dsh-feishu-bot': { package: { name: 'dsh-feishu-bot', version: feishuVersion } },
    },
  }
}

describe('DSH install observation plan', () => {
  it('tests the whole maintained corpus when the official DSH coordinate changes', () => {
    const plan = buildDshInstallPlan(corpus, state(), {
      changes: [{
        targetId: 'deepseek-harness',
        meaningful: true,
        previous: { package: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' } },
        current: { package: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.9' } },
      }],
    })

    assert.equal(plan.run, true)
    assert.equal(plan.dshVersion, '0.1.0-rc.9')
    assert.deepEqual(plan.matrix.include.map(item => item.plugin), ['dsh-browser@1.2.3', 'dsh-feishu-bot@0.16.1'])
    assert.deepEqual(plan.matrix.include.map(item => item.allowedBuilds), ['', 'protobufjs'])
    assert.deepEqual(plan.triggers, ['deepseek-harness'])
  })

  it('tests only the changed mapped plugin against the last observed DSH release', () => {
    const plan = buildDshInstallPlan(corpus, state(), {
      changes: [{
        targetId: 'dsh-feishu-bot',
        meaningful: true,
        previous: { package: { name: 'dsh-feishu-bot', version: '0.16.0' } },
        current: { package: { name: 'dsh-feishu-bot', version: '0.17.0' } },
      }],
    })

    assert.equal(plan.run, true)
    assert.equal(plan.dshVersion, '0.1.0-rc.8')
    assert.deepEqual(plan.matrix.include, [{ id: 'feishu', plugin: 'dsh-feishu-bot@0.17.0', allowedBuilds: 'protobufjs' }])
    assert.deepEqual(plan.triggers, ['dsh-feishu-bot'])
  })

  it('stays quiet when no meaningful DSH or maintained-plugin coordinate changed', () => {
    const plan = buildDshInstallPlan(corpus, state(), { changes: [] })
    assert.equal(plan.run, false)
    assert.equal(plan.dshVersion, '0.1.0-rc.8')
    assert.deepEqual(plan.matrix.include, [])
    assert.match(plan.reason, /no maintained install target changed/)
  })

  it('refuses ranges and duplicate ids in the maintained corpus', () => {
    assert.throws(() => parseDshInstallTargets({
      schema: 'upstream-radar.dsh-install-targets/v1alpha1',
      plugins: [
        { id: 'duplicate', spec: 'one@^1.0.0', reason: 'bad range' },
        { id: 'duplicate', spec: 'two@1.0.0', reason: 'duplicate id' },
      ],
    }), /exact|duplicate/)
  })
})
