import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compactDshActiveProviderMessages,
  normalizeDshActiveCaseAction,
  type DshActiveProviderMessage,
} from '../src/dsh-active-provider-messages.js'

describe('active provider message protocol', () => {
  it('repairs only the unambiguous flattened recommendation wrapper', () => {
    assert.deepEqual(normalizeDshActiveCaseAction({ action: 'recommend', input: {
      status: 'recommended', nodeMajors: [22],
    } }), { action: 'recommend', input: { decision: { status: 'recommended', nodeMajors: [22] } } })
    const wrapped = { action: 'recommend', input: { decision: { status: 'recommended' } } }
    assert.equal(normalizeDshActiveCaseAction(wrapped), wrapped)
  })

  it('normalizes an omitted or scalar conclusion note without inventing the model statement', () => {
    const launchId = 'a'.repeat(32)
    assert.deepEqual(normalizeDshActiveCaseAction({ action: 'conclude', input: {
      launchId, statement: 'Node 22 Web 检查完成。',
    } }), { action: 'conclude', input: { launchId, statement: 'Node 22 Web 检查完成。', coverageNotes: [] } })
    assert.deepEqual(normalizeDshActiveCaseAction({ action: 'conclude', input: {
      launchId, statement: '外部账号未测试。', coverageNotes: '缺少外部账号。',
    } }), { action: 'conclude', input: {
      launchId, statement: '外部账号未测试。', coverageNotes: ['缺少外部账号。'],
    } })
  })

  it('compacts whole turns without leaving an orphan provider tool response', () => {
    const old = 'x'.repeat(80_000)
    const messages: DshActiveProviderMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'case_action', arguments: old } }] },
      { role: 'tool', tool_call_id: 'old-call', content: old },
      { role: 'user', content: 'current' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'new-call', type: 'function', function: { name: 'case_action', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'new-call', content: '{"ok":false}' },
    ]
    const compacted = compactDshActiveProviderMessages(messages, 4, 64 * 1024)
    assert.equal(compacted.turnStart, 2)
    assert.equal(compacted.messages.some(message => message.role === 'tool' && message.tool_call_id === 'old-call'), false)
    assert.equal(compacted.messages.some(message => message.role === 'tool' && message.tool_call_id === 'new-call'), true)
    const toolIndex = compacted.messages.findIndex(message => message.role === 'tool')
    assert.ok(toolIndex > 0)
    assert.equal(compacted.messages.slice(0, toolIndex).some(message => message.role === 'assistant'
      && message.tool_calls?.some(call => call.id === 'new-call')), true)
  })
})
