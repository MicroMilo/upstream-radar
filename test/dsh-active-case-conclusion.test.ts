import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createDshActiveCaseConclusionReceipt,
  validateDshActiveCaseConclusionVersions } from '../src/dsh-active-case-conclusion.js'

it('records a model-authored attribution only for the exact completed launch and evidence digest', () => {
  const launchId = 'a'.repeat(32), evidenceDigest = `sha256:${'b'.repeat(64)}`
  const receipt = createDshActiveCaseConclusionReceipt('feishu-bot', launchId, evidenceDigest, {
    launchId, statement: '依赖构建门槛已恢复；加载仍需要真人飞书账号。',
    coverageNotes: ['默认 SDK 登录未完成，不能宣称兼容通过。'],
  })
  assert.equal(receipt.targetId, 'feishu-bot')
  assert.equal(receipt.activeLaunchId, launchId)
  assert.equal(receipt.evidenceDigest, evidenceDigest)
  assert.equal(receipt.modelAuthored, true)
  assert.throws(() => createDshActiveCaseConclusionReceipt('feishu-bot', launchId, evidenceDigest, {
    launchId: 'c'.repeat(32), statement: 'old launch', coverageNotes: [],
  }), /launch/)
  assert.throws(() => createDshActiveCaseConclusionReceipt('feishu-bot', launchId, evidenceDigest, {
    launchId, statement: 'https://open.feishu.cn/page/launcher?user_code=T48U-MMPT', coverageNotes: [],
  }), /login|URL|code/)
})

it('rejects a model DSH version attribution not present in the exact inspected ledgers', () => {
  assert.throws(() => validateDshActiveCaseConclusionVersions(
    '目标渠道 DSH 0.1.6-alpha.1（Node 20）：原生失败；作者基线 DSH 0.1.5-rc.2（Node 22）：Web 兼容。',
    ['0.1.5-rc.2']), /DSH version|version attribution/)
  assert.doesNotThrow(() => validateDshActiveCaseConclusionVersions(
    '同一 DSH 0.1.5-rc.2 下，Node 20 失败、Node 22 Web 兼容。插件制品是 0.1.9。',
    ['0.1.5-rc.2']))
  assert.doesNotThrow(() => validateDshActiveCaseConclusionVersions(
    '作者 DSH 0.1.0-rc.8 SDK 通过；目标 DSH 0.1.6-alpha.1 SDK 初始化失败。',
    ['0.1.0-rc.8', '0.1.6-alpha.1']))
})
