import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createDshBatchExecutorIdentity, dshBatchContainerArguments, dshBatchDockerObjectAbsent } from '../src/dsh-batch-executor.js'

it('reuses the same executor across scheduling budgets and image enumeration order but not runtime changes', () => {
  const input = { sourceIdentity: 'a'.repeat(64), images: [
    { nodeMajor: 22, pnpmVersion: '11.7.0', id: `sha256:${'b'.repeat(64)}` },
    { nodeMajor: 24, pnpmVersion: '11.7.0', id: `sha256:${'c'.repeat(64)}` },
  ], config: { dockerContext: 'fixture', architecture: 'arm64', timeoutSeconds: 180, maxTasks: 1 } }
  const initial = createDshBatchExecutorIdentity(input)
  assert.equal(createDshBatchExecutorIdentity({ ...input, images: [...input.images].reverse(), config: { ...input.config, maxTasks: 100 } }), initial)
  for (const config of [{ ...input.config, timeoutSeconds: 300 }, { ...input.config, architecture: 'x64' },
    { ...input.config, networkProxy: 'http://127.0.0.1:7897' }, { ...input.config, dockerContext: 'another-daemon' }]) {
    assert.notEqual(createDshBatchExecutorIdentity({ ...input, config }), initial)
  }
  assert.notEqual(createDshBatchExecutorIdentity({ ...input, sourceIdentity: 'd'.repeat(64) }), initial)
  assert.notEqual(createDshBatchExecutorIdentity({ ...input, images: input.images.map(image => ({ ...image, id: `sha256:${'e'.repeat(64)}` })) }), initial)
})

it('recognizes Docker object absence without treating daemon or transport failures as a missing handle', () => {
  assert.equal(dshBatchDockerObjectAbsent({ stderr: 'error: no such object: radar-batch-fixture\n' }), true)
  assert.equal(dshBatchDockerObjectAbsent({ stderr: 'Error response from daemon: No such image: fixture\n' }), true)
  assert.equal(dshBatchDockerObjectAbsent({ stderr: 'Cannot connect: no such file or directory' }), false)
  assert.equal(dshBatchDockerObjectAbsent({ stderr: 'request timed out' }), false)
})

it('passes exact planned data into an unprivileged container without host mounts or inherited credentials', () => {
  const input = { name: 'radar-batch-fixture', key: 'a'.repeat(64), image: `sha256:${'b'.repeat(64)}`,
    kind: 'native' as const, timeoutSeconds: 180, networkProxy: 'http://192.168.5.2:7897',
    cell: { id: 'plugin-node22', plugin: 'plugin@1.0.0', dshVersion: '0.1.5-rc.2',
      profileEnvironment: { pnpmVersion: '10.33.0', overrides: { peer: '1.0.0' } } } }
  const args = dshBatchContainerArguments(input)
  assert.equal(args[0], 'create')
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('10001:10001'))
  assert.ok(args.includes('no-new-privileges=true'))
  assert.ok(!args.some(value => ['-v', '--volume', '--mount', '--privileged', '--env-file', '--network=host'].includes(value)))
  const data = JSON.parse(args.at(-1)!)
  assert.deepEqual(data.cell.profileEnvironment, input.cell.profileEnvironment)
  assert.equal(data.timeoutSeconds, 180)
  assert.throws(() => dshBatchContainerArguments({ ...input, image: 'some-image:latest' }), /exact image/)
  assert.throws(() => dshBatchContainerArguments({ ...input, networkProxy: 'http://user:secret@example.com' }), /credential-free/)
  assert.throws(() => dshBatchContainerArguments({ ...input, timeoutSeconds: 99999 }), /bounds/)
  const adapterArgs = dshBatchContainerArguments({ ...input, kind: 'adapter', cell: { ...input.cell,
    adapter: 'sdk', expectedArtifactSha256: 'c'.repeat(64) } })
  assert.equal(JSON.parse(adapterArgs.at(-1)!).kind, 'adapter')
  assert.ok(adapterArgs.some(value => value.includes('observeDshAuthorAdapter')))
  assert.ok(!adapterArgs.includes('SYS_PTRACE'))
})
