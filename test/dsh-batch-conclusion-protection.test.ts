import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'

it('does not overwrite an Agent conclusion with an unnumbered direct batch run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-concluded-batch-'))
  const output = join(directory, 'batch')
  const review = join(directory, 'review')
  const targets = join(directory, 'targets.json')
  const config = join(directory, 'executor.json')
  await Promise.all([mkdir(output), mkdir(review)])
  await writeFile(targets, '{}\n')
  await writeFile(config, `${JSON.stringify({ dockerContext: 'fixture', architecture: 'arm64',
    timeoutSeconds: 180, maxTasks: 1 })}\n`)
  const conclusion = '{"targetId":"fixture","activeLaunchId":"0123456789abcdef0123456789abcdef"}\n'
  const summary = '{"activeLaunchId":"0123456789abcdef0123456789abcdef","executed":4}\n'
  await writeFile(join(output, 'agent-conclusion.json'), conclusion)
  await writeFile(join(output, 'summary.json'), summary)
  const script = new URL('../../scripts/run-dsh-compatibility-batch.mjs', import.meta.url)
  const result = spawnSync(process.execPath, [script.pathname, targets, review, output, config, '--execute'],
    { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /concluded Agent case.*separate output directory/)
  assert.equal(await readFile(join(output, 'summary.json'), 'utf8'), summary)
  assert.equal(await readFile(join(output, 'agent-conclusion.json'), 'utf8'), conclusion)
})

it('binds the active runner script and stages the author legacy headless adapter image environment', async () => {
  const script = await readFile(new URL('../../scripts/run-dsh-compatibility-batch.mjs', import.meta.url), 'utf8')
  assert.match(script, /sourceFiles = \['scripts\/run-dsh-compatibility-batch\.mjs'/,
    'environment-matrix changes in this runner must change the exact executor source identity')
  assert.match(script, /observations\.targets\[target\.observerTargetId\]\?\.package/,
    'the author adapter image must be selected from this run\'s exact observed artifact, not a stale static target')
  assert.doesNotMatch(script, /item\.kind === 'headless' && target\.spec === 'dsh-feishu-bot@0\.19\.16'/)
})
