import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GitHubReleaseClient } from '../src/github-release.js'

const observation = {
  installed: { ecosystem: 'npm' as const, name: 'plugin', version: '1.0.0' },
  latestVersion: '2.0.0',
  previous: { name: 'plugin', version: '1.0.0' },
  candidate: { name: 'plugin', version: '2.0.0' },
  repository: 'git+https://github.com/acme/plugin.git',
}

describe('GitHub release notes source', () => {
  it('looks up the exact candidate tag and keeps only bounded public release material', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const client = new GitHubReleaseClient({
      fetch: async (input, init) => {
        const url = String(input)
        calls.push({ url, headers: new Headers(init?.headers) })
        if (url.endsWith('/releases/tags/v2.0.0')) return new Response(null, { status: 404 })
        return Response.json({
          tag_name: '2.0.0',
          body: 'BREAKING CHANGE: the Cordis adapter now requires an explicit session.',
          html_url: 'https://github.com/acme/plugin/releases/tag/2.0.0',
        })
      },
    })
    const result = await client.query([observation])
    const notes = result.get('npm:plugin@1.0.0')
    assert.equal(notes?.text.startsWith('BREAKING CHANGE:'), true)
    assert.equal(notes?.url, 'https://github.com/acme/plugin/releases/tag/2.0.0')
    assert.deepEqual(calls.map(call => call.url), [
      'https://api.github.com/repos/acme/plugin/releases/tags/v2.0.0',
      'https://api.github.com/repos/acme/plugin/releases/tags/2.0.0',
    ])
    assert.equal(calls[0]?.headers.get('accept'), 'application/vnd.github+json')
    assert.equal(calls[0]?.headers.get('x-github-api-version'), '2022-11-28')
  })

  it('does not turn arbitrary repository metadata into outbound requests', async () => {
    let calls = 0
    const client = new GitHubReleaseClient({
      fetch: async () => {
        calls += 1
        return Response.json({})
      },
    })
    const result = await client.query([
      { ...observation, repository: 'https://gitlab.com/acme/plugin' },
      { ...observation, installed: { ...observation.installed, version: '2.0.0' } },
    ])
    assert.equal(result.size, 0)
    assert.equal(calls, 0)
  })

  it('does not fetch release notes for a regressed latest tag', async () => {
    let calls = 0
    const client = new GitHubReleaseClient({
      fetch: async () => {
        calls += 1
        return Response.json({})
      },
    })
    const result = await client.query([{
      ...observation,
      latestVersion: '0.0.1',
      candidate: { name: 'plugin', version: '0.0.1' },
      candidateStatus: 'older',
    }])
    assert.equal(result.size, 0)
    assert.equal(calls, 0)
  })

  it('surfaces non-not-found failures so the radar can report a source warning', async () => {
    const client = new GitHubReleaseClient({
      fetch: async () => new Response(null, { status: 503 }),
    })
    await assert.rejects(client.query([observation]), /HTTP 503/)
  })
})
