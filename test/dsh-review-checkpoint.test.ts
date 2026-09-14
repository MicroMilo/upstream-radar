import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it } from 'node:test'

const execFile = promisify(callback)

it('restores the newest surviving review checkpoint when the most recent completed CI run produced none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-checkpoint-'))
  const workflowPath = fileURLToPath(new URL('../../.github/workflows/dsh-rebuild-validation.yml', import.meta.url))
  const workflow = await readFile(workflowPath, 'utf8')
  const section = workflow.split('      - name: Restore the previous durable review checkpoint')[1]!.split('\n      - name:')[0]!
  const command = section.split('        run: |\n')[1]!.split('\n').map(line => line.replace(/^          /, '')).join('\n')
  const fakeGh = join(root, 'gh')
  try {
    await writeFile(fakeGh, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.RADAR_GH_FIXTURE;
const mode = process.env.RADAR_GH_MODE;
const log = path.join(root, 'calls.json');
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
calls.push(args); fs.writeFileSync(log, JSON.stringify(calls));
if (args[0] === 'run' && args[1] === 'list') {
  console.log(args.includes('--jq') ? '300' : JSON.stringify([{databaseId:300},{databaseId:200},{databaseId:100}]));
} else if (args[0] === 'api') {
  if (mode === 'metadata-error') { console.error('temporary GitHub metadata failure'); process.exit(1); }
  const absent = args[1].includes('/300/');
  console.log(JSON.stringify({total_count:absent ? 0 : 1, artifacts:absent ? [] : [{id:2000,name:'dsh-rebuild-review',expired:false}]}));
} else if (args[0] === 'run' && args[1] === 'download') {
  if (args[2] !== '200') { console.error('no artifact survived the newest run'); process.exit(1); }
  const output = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(output,{recursive:true}); fs.writeFileSync(path.join(output,'recommendations.json'),JSON.stringify({pendingTasks:[{id:'preserved-review'}]}));
  if (mode === 'download-error') { console.error('temporary artifact download failure'); process.exit(1); }
} else { console.error('unexpected gh invocation'); process.exit(1); }
`)
    await chmod(fakeGh, 0o755)
    await execFile('bash', ['-c', command], { cwd: root, timeout: 20_000, env: {
      ...process.env, PATH: `${dirname(fakeGh)}:${process.env.PATH}`, GITHUB_REPOSITORY: 'fixture/radar', RADAR_BRANCH: 'codex/test',
      RADAR_GH_FIXTURE: root, RADAR_RESTORE_SCRIPT: fileURLToPath(new URL('../../scripts/restore-dsh-review-checkpoint.mjs', import.meta.url)),
    } })
    const saved = JSON.parse(await readFile(join(root, 'validation-output/recommendations.json'), 'utf8'))
    assert.deepEqual(saved.pendingTasks, [{ id: 'preserved-review' }])
    const calls = JSON.parse(await readFile(join(root, 'calls.json'), 'utf8')) as string[][]
    assert.deepEqual(calls.filter(args => args[1] === 'download').map(args => args[2]), ['200'])
    assert.ok(!calls.some(args => args[0] === 'api' && args[1]?.includes('/100/')), 'stop once the newest surviving checkpoint is found')
    const restoreScript = fileURLToPath(new URL('../../scripts/restore-dsh-review-checkpoint.mjs', import.meta.url))
    for (const mode of ['metadata-error', 'download-error']) {
      await writeFile(join(root, 'calls.json'), '[]')
      await assert.rejects(execFile(process.execPath, [restoreScript, 'fixture/radar', 'codex/test', join(root, mode)], {
        cwd: root, timeout: 20_000, env: { ...process.env, PATH: `${dirname(fakeGh)}:${process.env.PATH}`, RADAR_GH_FIXTURE: root, RADAR_GH_MODE: mode },
      }), /temporary/)
      assert.ok(!(await readdir(root)).includes(mode), 'a failed download must not become a partial checkpoint')
      assert.ok(!(await readdir(root)).some(name => name.startsWith('.dsh-review-restore-')), 'discard only the owned temporary extraction')
      const failureCalls = JSON.parse(await readFile(join(root, 'calls.json'), 'utf8')) as string[][]
      assert.ok(!failureCalls.some(args => args[0] === 'api' && args[1]?.includes('/100/')), 'a transport failure must not silently select older state')
    }
    assert.deepEqual(JSON.parse(await readFile(join(root, 'validation-output/recommendations.json'), 'utf8')), saved)
  } finally { await rm(root, { recursive: true, force: true }) }
})
