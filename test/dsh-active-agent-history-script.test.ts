import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'

it('keeps successive receipts for one launch in separate exact history slots', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-history.mjs', import.meta.url))
  const { dshActiveAgentHistoryArchiveName } = await import(script)
  const launchId = '329426dce968482a8121a90635f56c32'
  const oldInput = `sha256:${'a'.repeat(64)}`
  const newInput = `sha256:${'b'.repeat(64)}`
  const firstReceipt = `sha256:${'c'.repeat(64)}`
  const correctedReceipt = `sha256:${'d'.repeat(64)}`
  const first = dshActiveAgentHistoryArchiveName(launchId, oldInput, firstReceipt)
  const corrected = dshActiveAgentHistoryArchiveName(launchId, oldInput, correctedReceipt)
  const newReview = dshActiveAgentHistoryArchiveName(launchId, newInput, correctedReceipt)
  assert.equal(first, `${launchId}.${'a'.repeat(64)}.${'c'.repeat(64)}`)
  assert.notEqual(corrected, first)
  assert.notEqual(newReview, corrected)
  assert.throws(() => dshActiveAgentHistoryArchiveName('../escape', oldInput, firstReceipt))
  assert.throws(() => dshActiveAgentHistoryArchiveName(launchId, 'unbound', firstReceipt))
})

it('archives old local Agent turns before a resumed run can reuse their filenames', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-history.mjs', import.meta.url))
  const { archiveDshActiveAgentTurnReceipts } = await import(script)
  const root = await mkdtemp(join(tmpdir(), 'radar-agent-history-'))
  const batch = join(root, 'batch'), archive = join(root, 'archive')
  try {
    await Promise.all([mkdir(batch), mkdir(archive)])
    await writeFile(join(batch, 'agent-host-turn-1.json'), '{"original":true}')
    await writeFile(join(batch, 'agent-host-resume-turn-2.json'), '{"resume":true}')
    await writeFile(join(batch, 'summary.json'), '{}')
    assert.equal(await archiveDshActiveAgentTurnReceipts(batch, archive), 2)
    assert.deepEqual((await readdir(archive)).sort(), ['agent-host-resume-turn-2.json', 'agent-host-turn-1.json'])
    assert.deepEqual(await readdir(batch), ['summary.json'])
    assert.equal(await readFile(join(archive, 'agent-host-resume-turn-2.json'), 'utf8'), '{"resume":true}')
    await writeFile(join(batch, 'agent-host-resume-turn-4.json'), '{"later":true}')
    await symlink('summary.json', join(batch, 'agent-host-resume-turn-3.json'))
    await assert.rejects(() => archiveDshActiveAgentTurnReceipts(batch, archive), /regular.*turn receipt/)
    assert.deepEqual((await readdir(batch)).sort(),
      ['agent-host-resume-turn-3.json', 'agent-host-resume-turn-4.json', 'summary.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('recovers the exact prelaunch model session from a bounded regular turn receipt', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-history.mjs', import.meta.url))
  const { recoverDshActiveAgentPrelaunchSession } = await import(script)
  const root = await mkdtemp(join(tmpdir(), 'radar-agent-prelaunch-'))
  const sessionId = '11111111-1111-4111-8111-111111111111'
  try {
    await writeFile(join(root, 'agent-host-turn-1.json'), JSON.stringify({ targetId: 'openpencil',
      sessionId, turnNumber: 1, observedAt: new Date().toISOString() }))
    assert.deepEqual(await recoverDshActiveAgentPrelaunchSession(root, 'openpencil'),
      { sessionId, turnNumber: 1, receiptName: 'agent-host-turn-1.json' })
    await writeFile(join(root, 'agent-host-turn-2.json'), JSON.stringify({ targetId: 'other-plugin',
      sessionId, turnNumber: 2, observedAt: new Date().toISOString() }))
    await assert.rejects(() => recoverDshActiveAgentPrelaunchSession(root, 'openpencil'), /exact.*target|target.*exact/)
    await rm(join(root, 'agent-host-turn-2.json'))
    await symlink('agent-host-turn-1.json', join(root, 'agent-host-turn-3.json'))
    await assert.rejects(() => recoverDshActiveAgentPrelaunchSession(root, 'openpencil'), /regular.*receipt/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('resumes a closed exact Agent session to re-execute after the collector identity changes', async () => {
  const script = await readFile(new URL('../../scripts/run-dsh-active-agent-host.mjs', import.meta.url), 'utf8')
  assert.match(script, /--resume-after-executor-identity-change/)
  assert.match(script, /resumeAfterExecutorIdentityChange && input\.turnNumber === 1/)
  assert.match(script, /旧执行器身份.*重新 launch.*watch.*inspect.*conclude/)
  assert.match(script, /archiveDshActiveAgentTurnReceipts\(batch, archive\)/)
})

it('reopens an exact partial review when explicit additional author workflows were only recorded as gaps', async () => {
  const script = await readFile(new URL('../../scripts/run-dsh-active-agent-host.mjs', import.meta.url), 'utf8')
  assert.match(script, /--resume-after-author-workflow-gap/)
  assert.match(script, /resumeAfterAuthorWorkflowGap && input\.turnNumber === 1/)
  assert.match(script, /可切换.*附加.*工作流.*不能仅写成覆盖缺口/)
  assert.match(script, /重新 review.*recommend.*launch.*watch.*inspect.*conclude/)
})

it('reopens only the exact formerly closed model session after an author adapter coverage gate is added', async () => {
  const script = await readFile(new URL('../../scripts/run-dsh-active-agent-host.mjs', import.meta.url), 'utf8')
  assert.match(script, /--resume-after-author-adapter-coverage-fix/)
  assert.match(script, /dshActiveAgentCaseFormerlyClosedForAdapterRepair\(targetId, old\)/)
  assert.match(script, /resumeAfterAuthorAdapterCoverageFix && input\.turnNumber === 1/)
  assert.match(script, /独立 headless adapter.*重新 launch.*watch.*inspect.*conclude/)
  assert.match(script, /action=network,input=\{route:"direct"\|"configured-proxy"\|"recovery-proxy"\}/)
  assert.match(script, /制品.*取不到.*network.*重新 launch/)
  assert.match(script, /consecutiveTransportOnlyTurns/)
  assert.match(script, /tls handshake eof/)
  assert.match(script, />= 5/)
  assert.match(script, /consecutiveTerminalNoActionTurns/)
  assert.match(script, /launchResult[\s\S]{0,100}summary/)
  assert.match(script, />= 6/)
})
