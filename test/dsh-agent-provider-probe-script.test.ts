import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

describe('active Agent provider probe', () => {
  it('requires a real tool call and proves the continuation read the tool result', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests += 1
      response.setHeader('content-type', 'application/json')
      if (requests === 1) {
        const nonce = String(body.messages[1].content).match(/[a-f0-9]{24}/)?.[0]
        response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function',
            function: { name: 'read_probe_material', arguments: JSON.stringify({ nonce }) } }],
        } }] }))
      } else {
        const tool = body.messages.find((message: { role: string }) => message.role === 'tool')
        const marker = JSON.parse(tool.content).marker
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
          role: 'assistant', content: `Observed ${marker}`,
        } }] }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const root = await mkdtemp(join(tmpdir(), 'dsh-agent-provider-probe-'))
      const output = join(root, 'probe.json')
      const child = spawn(process.execPath, ['scripts/probe-dsh-agent-provider.mjs', output], {
        cwd: process.cwd(),
        env: { ...process.env, ISSUE_LOCATOR_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          ISSUE_LOCATOR_LLM_API_KEY: 'fixture-secret', ISSUE_LOCATOR_LLM_MODEL: 'fixture-model' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal(code, 0, stderr)
      assert.equal(requests, 2)
      const report = JSON.parse(await readFile(output, 'utf8'))
      assert.equal(report.toolLoop.toolCallObserved, true)
      assert.equal(report.toolLoop.toolExecuted, true)
      assert.equal(report.toolLoop.toolResultObservedByModel, true)
      assert.doesNotMatch(JSON.stringify(report), /fixture-secret|fixture-model/)
    } finally {
      server.close()
    }
  })
})
