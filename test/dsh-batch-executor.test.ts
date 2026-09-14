import assert from 'node:assert/strict'
import { it } from 'node:test'
import { dshBatchContainerArguments, dshBatchDockerObjectAbsent } from '../src/dsh-batch-executor.js'

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
})
