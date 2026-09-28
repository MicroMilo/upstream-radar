import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseDshActiveCaseRequest } from '../src/dsh-active-case-protocol.js'

it('limits the agent to one exact case and a small set of named actions', () => {
  const request = { schema: 'upstream-radar.dsh-active-case-request/v1alpha1', id: 'a'.repeat(32),
    targetId: 'cloudflare-browser', action: 'watch', input: { cursor: 0 } }
  assert.deepEqual(parseDshActiveCaseRequest(request, 'cloudflare-browser'), request)
  assert.throws(() => parseDshActiveCaseRequest({ ...request, targetId: 'another-plugin' }, 'cloudflare-browser'), /target/)
  assert.throws(() => parseDshActiveCaseRequest({ ...request, action: 'shell' }, 'cloudflare-browser'), /action/)
  assert.throws(() => parseDshActiveCaseRequest({ ...request, input: { command: 'rm -rf /' } }, 'cloudflare-browser'), /input/)
  assert.throws(() => parseDshActiveCaseRequest({ ...request, extra: 'x' }, 'cloudflare-browser'), /keys/)
  assert.equal(parseDshActiveCaseRequest({ ...request, action: 'network', input: { route: 'direct' } }, 'cloudflare-browser').action, 'network')
  assert.throws(() => parseDshActiveCaseRequest({ ...request, action: 'network', input: { route: 'http://untrusted.example' } }, 'cloudflare-browser'), /network|route/)
  assert.throws(() => parseDshActiveCaseRequest({ ...request, action: 'network', input: { route: 'direct', command: 'curl example.com' } }, 'cloudflare-browser'), /input/)
  const evidence = { ...request, action: 'evidence', input: { path: '.github/workflows/ci.yml' } }
  assert.equal(parseDshActiveCaseRequest(evidence, 'cloudflare-browser').action, 'evidence')
  assert.equal(parseDshActiveCaseRequest({ ...evidence,
    input: { path: 'README.md', offset: 24 * 1024 } }, 'cloudflare-browser').input.offset, 24 * 1024)
  for (const offset of [-1, 1.5, 256 * 1024 + 1, '0']) {
    assert.throws(() => parseDshActiveCaseRequest({ ...evidence,
      input: { path: 'README.md', offset } }, 'cloudflare-browser'), /offset|evidence/)
  }
  for (const path of ['../other', '/etc/passwd', 'https://other.example/a', 'docs/../../x']) {
    assert.throws(() => parseDshActiveCaseRequest({ ...evidence, input: { path } }, 'cloudflare-browser'), /path|evidence/)
  }
  assert.throws(() => parseDshActiveCaseRequest({ ...evidence, input: { path: 'README.md', url: 'https://evil' } }, 'cloudflare-browser'), /input/)
  const buildReview = { ...request, action: 'build-review', input: { caseId: 'cloudflare-browser-node22' } }
  assert.equal(parseDshActiveCaseRequest(buildReview, 'cloudflare-browser').action, 'build-review')
  const build = { ...request, action: 'build', input: { caseId: 'cloudflare-browser-node22', decision: {
    action: 'retry-headless', classification: 'build-approval', allowedBuilds: ['protobufjs'],
    summary: 'Approve only the observed build.', evidence: ['observed-build-gate'],
  } } }
  assert.equal(parseDshActiveCaseRequest(build, 'cloudflare-browser').action, 'build')
  assert.throws(() => parseDshActiveCaseRequest({ ...build, input: { ...build.input, command: 'curl untrusted' } }, 'cloudflare-browser'), /input/)
  assert.throws(() => parseDshActiveCaseRequest({ ...buildReview, input: { caseId: '../another-plugin' } }, 'cloudflare-browser'), /caseId|case/)
  const surfaceReview = { ...request, action: 'surface-build-review', input: { caseId: 'cloudflare-browser-node22-web' } }
  assert.equal(parseDshActiveCaseRequest(surfaceReview, 'cloudflare-browser').action, 'surface-build-review')
  const surfaceBuild = { ...request, action: 'surface-build', input: { caseId: 'cloudflare-browser-node22-web',
    decision: { action: 'retry-surface', classification: 'build-approval', allowedBuilds: ['node-pty'],
      summary: 'Only the isolated gate.', evidence: ['Exact profile report.'] } } }
  assert.equal(parseDshActiveCaseRequest(surfaceBuild, 'cloudflare-browser').action, 'surface-build')
  assert.throws(() => parseDshActiveCaseRequest({ ...surfaceBuild, input: { ...surfaceBuild.input, command: 'shell' } }, 'cloudflare-browser'), /input/)
  const conclusion = { ...request, action: 'conclude', input: { launchId: 'b'.repeat(32),
    statement: 'The exact run has incomplete coverage.', coverageNotes: ['Web plane still unknown.'] } }
  assert.equal(parseDshActiveCaseRequest(conclusion, 'cloudflare-browser').action, 'conclude')
  assert.throws(() => parseDshActiveCaseRequest({ ...conclusion, input: { ...conclusion.input, command: 'git push' } }, 'cloudflare-browser'), /input/)
})
