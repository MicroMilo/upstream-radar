import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'

it('lets the trusted Agent runner observe a live case even when a model turn has not yielded a tool call', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-supervised-watch.mjs', import.meta.url))
  const { performDshActiveAgentSupervisorWatch } = await import(script)
  const root = await mkdtemp(join(tmpdir(), 'radar-supervised-watch-'))
  const requests = join(root, 'requests'), responses = join(root, 'responses')
  try {
    await Promise.all([mkdir(requests), mkdir(responses)])
    const pending = performDshActiveAgentSupervisorWatch(root, 'fixture')
    let name: string | undefined
    const deadline = Date.now() + 4_000
    while (!name) {
      name = (await readdir(requests)).find(file => file.endsWith('.json'))
      if (!name && Date.now() >= deadline) throw new Error('supervised watch did not hand off its exact request')
      if (!name) await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    const request = JSON.parse(await readFile(join(requests, name), 'utf8'))
    assert.equal(request.schema, 'upstream-radar.dsh-active-case-request/v1alpha1')
    assert.equal(request.targetId, 'fixture')
    assert.equal(request.action, 'watch')
    assert.deepEqual(request.input, { cursor: 0 })
    assert.match(request.id, /^[a-f0-9]{32}$/)
    await writeFile(join(responses, `${request.id}.json`), JSON.stringify({ id: request.id,
      ok: true, value: { status: 'running', launchId: 'a'.repeat(32), cursor: 0 } }))
    const observed = await pending
    assert.equal(observed.status, 'running')
    assert.equal(observed.launchId, 'a'.repeat(32))
    assert.match(observed.observedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('observes an active launch at each Agent supervisor snapshot, including after a slow model turn', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-supervised-watch.mjs', import.meta.url))
  const { supervisedDshActiveAgentSnapshot } = await import(script)
  const id = 'b'.repeat(32)
  let watches = 0, reads = 0
  const snapshot = async () => { reads += 1; return { launch: { id }, launchResult: undefined } }
  const watch = async () => { watches += 1; return { status: 'running', launchId: id } }
  await supervisedDshActiveAgentSnapshot(snapshot, watch)
  await new Promise(resolveWait => setTimeout(resolveWait, 5)) // A model turn without a tool call.
  await supervisedDshActiveAgentSnapshot(snapshot, watch)
  assert.equal(watches, 2)
  assert.equal(reads, 4)
  const completed = async () => ({ launch: { id }, launchResult: { id } })
  await supervisedDshActiveAgentSnapshot(completed, watch)
  assert.equal(watches, 2, 'a finished launch does not manufacture another running observation')
})

it('continues trusted online watches inside a slow model turn and stops when that turn ends', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-supervised-watch.mjs', import.meta.url))
  const { withDshActiveAgentTurnWatch } = await import(script)
  let watches = 0, modelFinished = false
  const result = await withDshActiveAgentTurnWatch(async () => {
    await new Promise(resolveWait => setTimeout(resolveWait, 95))
    modelFinished = true
    return 'same-session'
  }, async () => {
    assert.equal(modelFinished, false, 'the watch must run before the model turn returns')
    watches += 1
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }, 20)
  assert.equal(result, 'same-session')
  assert.ok(watches >= 2, `expected repeated during-turn watches, saw ${watches}`)
  const finalWatches = watches
  await new Promise(resolveWait => setTimeout(resolveWait, 60))
  assert.equal(watches, finalWatches, 'no background watch may outlive the model turn')
})

it('fails closed if its during-turn broker observation fails', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-supervised-watch.mjs', import.meta.url))
  const { withDshActiveAgentTurnWatch } = await import(script)
  await assert.rejects(withDshActiveAgentTurnWatch(async () => {
    await new Promise(resolveWait => setTimeout(resolveWait, 40))
    return 'must-not-close'
  }, async () => { throw new Error('trusted broker unavailable') }, 10), /trusted broker unavailable/)
})

it('keeps model evidence review free of running-case watches until a launch actually exists', async () => {
  const script = fileURLToPath(new URL('../../scripts/dsh-active-agent-supervised-watch.mjs', import.meta.url))
  const { withDshActiveAgentTurnWatch, supervisedDshActiveAgentSnapshot } = await import(script)
  let watches = 0, launch: { id: string } | undefined
  const snapshot = async () => ({ launch })
  const safeWatch = async () => {
    watches += 1
    return { status: 'running', launchId: launch!.id }
  }
  await withDshActiveAgentTurnWatch(async () => {
    await new Promise(resolveWait => setTimeout(resolveWait, 65))
  }, () => supervisedDshActiveAgentSnapshot(snapshot, safeWatch), 20)
  assert.equal(watches, 0, 'prelaunch evidence fetch must not queue a broker running watch')
  await withDshActiveAgentTurnWatch(async () => {
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
    launch = { id: 'c'.repeat(32) }
    await new Promise(resolveWait => setTimeout(resolveWait, 70))
  }, () => supervisedDshActiveAgentSnapshot(snapshot, safeWatch), 20)
  assert.ok(watches >= 2, `expected watches after the launch appeared, saw ${watches}`)
  const host = await readFile(fileURLToPath(new URL('../../scripts/run-dsh-active-agent-host.mjs', import.meta.url)), 'utf8')
  const container = await readFile(fileURLToPath(new URL('../../scripts/run-dsh-active-agent.mjs', import.meta.url)), 'utf8')
  assert.match(host, /withDshActiveAgentTurnWatch\(\(\) => codexTurn\(input\), supervisedSnapshot/)
  assert.match(container, /withDshActiveAgentTurnWatch\(\(\) => codexTurn\(input\), supervisedSnapshot/)
})

it('reopens a closed exact model session only for a recorded README source-read gap after transport repair', async () => {
  const host = await readFile(fileURLToPath(new URL('../../scripts/run-dsh-active-agent-host.mjs', import.meta.url)), 'utf8')
  assert.match(host, /--resume-after-evidence-transport-fix/)
  assert.match(host, /hasLargeReadmeGap/)
  assert.match(host, /可信仓库取证通道已修复.*README/s)
})
