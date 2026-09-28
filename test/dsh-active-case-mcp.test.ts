import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'

it('exposes only one bounded MCP hand and forwards an exact named action to the broker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-case-mcp-'))
  const requests = join(root, 'requests'), responses = join(root, 'responses')
  await Promise.all([mkdir(requests), mkdir(responses)])
  const script = fileURLToPath(new URL('../../scripts/dsh-active-case-mcp.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { RADAR_CASE_TARGET_ID: 'fixture', RADAR_CASE_CONTROL: root } })
  const lines: Array<Record<string, unknown>> = []
  let output = ''
  child.stdout!.on('data', chunk => {
    output += String(chunk)
    while (output.includes('\n')) {
      const end = output.indexOf('\n')
      lines.push(JSON.parse(output.slice(0, end)))
      output = output.slice(end + 1)
    }
  })
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 5_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('bounded MCP test did not receive its reply')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  function send(id: number, method: string, params: unknown) {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }
  try {
    send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'test', version: '1' } })
    await waitFor(() => lines.some(line => line.id === 1))
    assert.equal((lines.find(line => line.id === 1)?.result as Record<string, unknown>).protocolVersion, '2025-06-18')
    send(2, 'tools/list', {})
    await waitFor(() => lines.some(line => line.id === 2))
    const tools = (lines.find(line => line.id === 2)?.result as {
      tools: Array<{ name: string; description: string }>
    }).tools
    assert.deepEqual(tools.map(tool => tool.name), ['case_action'])
    assert.match(tools[0]!.description, /before conclude, inspect with \{\} once/)
    assert.match(tools[0]!.description, /network.*direct.*configured-proxy.*recovery-proxy/)
    send(3, 'tools/call', { name: 'case_action', arguments: { action: 'shell', input: { command: 'pwd' } } })
    await waitFor(() => lines.some(line => line.id === 3))
    assert.equal((lines.find(line => line.id === 3)?.result as Record<string, unknown>).isError, true)
    assert.deepEqual(await readdir(requests), [], 'unsupported shell never reaches the broker')
    send(5, 'tools/call', { name: 'case_action', arguments: { action: 'conclude',
      input: { text: 'wrong field' } } })
    await waitFor(() => lines.some(line => line.id === 5))
    const wrongConclusion = lines.find(line => line.id === 5)?.result as { content: Array<{ text: string }> }
    assert.match(wrongConclusion.content[0]!.text, /launchId.*statement.*coverageNotes/)
    assert.deepEqual(await readdir(requests), [], 'a malformed conclusion never reaches the broker')
    send(4, 'tools/call', { name: 'case_action', arguments: { action: 'watch', input: { cursor: 0 } } })
    let requestFile: string | undefined
    const deadline = Date.now() + 5_000
    while (!requestFile) {
      requestFile = (await readdir(requests)).find(name => name.endsWith('.json'))
      if (!requestFile && Date.now() > deadline) throw new Error('MCP case hand did not persist a broker request')
      if (!requestFile) await new Promise(resolve => setTimeout(resolve, 25))
    }
    const request = JSON.parse(await readFile(join(requests, requestFile), 'utf8'))
    assert.equal(request.action, 'watch')
    assert.equal(request.targetId, 'fixture')
    assert.deepEqual(request.input, { cursor: 0 })
    await writeFile(join(responses, `${request.id}.json`), JSON.stringify({ id: request.id, ok: true,
      value: { status: 'running', liveSignals: [] } }))
    await waitFor(() => lines.some(line => line.id === 4))
    const reply = lines.find(line => line.id === 4)?.result as { isError: boolean; content: Array<{ text: string }> }
    assert.equal(reply.isError, false)
    assert.equal(JSON.parse(reply.content[0]!.text).value.status, 'running')
    send(6, 'tools/call', { name: 'case_action', arguments: { action: 'evidence',
      input: { path: 'README.md', offset: 24 * 1024 } } })
    let excerptRequest: Record<string, unknown> | undefined
    const excerptDeadline = Date.now() + 5_000
    while (!excerptRequest) {
      const files = (await readdir(requests)).filter(name => name.endsWith('.json'))
      for (const file of files) {
        const item = JSON.parse(await readFile(join(requests, file), 'utf8'))
        if (item.action === 'evidence') excerptRequest = item
      }
      if (!excerptRequest && Date.now() > excerptDeadline) throw new Error('MCP excerpt request was not persisted')
      if (!excerptRequest) await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.deepEqual(excerptRequest.input, { path: 'README.md', offset: 24 * 1024 })
    await writeFile(join(responses, `${excerptRequest.id}.json`), JSON.stringify({ id: excerptRequest.id,
      ok: true, value: { path: 'README.md#bytes=24576-49152', pendingReview: true } }))
    await waitFor(() => lines.some(line => line.id === 6))
    assert.equal((lines.find(line => line.id === 6)?.result as Record<string, unknown>).isError, false)
  } finally {
    child.stdin?.end()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('close', resolve))
    }
    await rm(root, { recursive: true, force: true })
  }
})
