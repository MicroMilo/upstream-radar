import assert from 'node:assert/strict'
import { execFile as callback } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { promisify } from 'node:util'
import { DSH_ADAPTER_EXECUTION_CONTRACT } from '../src/dsh-adapter-observation.js'

const execFile = promisify(callback)

it('runs a scheduled adapter only through the isolated boundary and binds its raw report to the persisted case and terminal container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radar-adapter-case-'))
  try {
    const cell = { id: 'feishu-node22-sdk', targetId: 'feishu', plugin: 'dsh-feishu-bot@0.19.16', dshVersion: '0.1.5-rc.2',
      nodeMajor: 22, adapter: 'sdk', profile: 'dsh-lark-sdk', recipe: 'feishu-0.19.16-doctor-initialize', platform: 'linux', architecture: 'x64',
      profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} }, expectedArtifactSha256: 'a'.repeat(64),
      sourceFingerprint: `sha256:${'b'.repeat(64)}`, contractFingerprint: `sha256:${'c'.repeat(64)}`, versionRole: 'target', allowedBuilds: '', reasons: ['fixture'] }
    const report = { schema: 'upstream-radar.dsh-adapter-observation/v1alpha1', executionContract: DSH_ADAPTER_EXECUTION_CONTRACT,
      plugin: cell.plugin, dshVersion: cell.dshVersion, adapter: cell.adapter, profile: cell.profile, recipe: cell.recipe,
      runtime: { nodeVersion: '22.23.2', platform: 'linux', architecture: 'x64', pnpmVersion: '11.7.0' },
      profileEnvironment: cell.profileEnvironment, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      artifact: { sha256: cell.expectedArtifactSha256, bytes: 1 }, commands: [], fixtureRequests: 0,
      stages: { runtime: 'passed', artifact: 'passed', install: 'failed', initialize: 'skipped', profileGraph: 'skipped' },
      boundary: { lifecycleScripts: 'disabled', inheritedHostSecrets: false, note: 'External Docker boundary fixture only.' },
      result: 'unknown', coverageGaps: ['Fixture install unavailable.'], reason: 'No target code ran in this test.' }
    const bin = join(root, 'bin'), output = join(root, 'adapter-report'), calls = join(root, 'calls.jsonl')
    await mkdir(bin)
    await writeFile(join(root, 'cell.json'), JSON.stringify(cell))
    await writeFile(join(root, 'report.json'), JSON.stringify(report))
    await writeFile(join(root, 'executor.json'), JSON.stringify({ dockerContext: 'fixture', architecture: 'x64', timeoutSeconds: 30, maxTasks: 1 }))
    await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'); const root=process.env.RADAR_CASE_FIXTURE, args=process.argv.slice(2);
if(args[0]!=='--context'||args[1]!=='fixture') throw new Error('wrong Docker boundary'); args.splice(0,2);
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='info') console.log(JSON.stringify({OSType:'linux',Architecture:'x86_64'}));
else if(args[0]==='image') console.log(JSON.stringify([{Id:'sha256:'+'d'.repeat(64),Architecture:'amd64'}]));
else if(args[0]==='create') { if(!fs.existsSync(path.join(root,'adapter-report','case.json'))) throw new Error('case was not durable before dispatch'); fs.writeFileSync(path.join(root,'create.json'),JSON.stringify(args)); }
else if(args[0]==='inspect') { const create=JSON.parse(fs.readFileSync(path.join(root,'create.json'))); console.log(JSON.stringify([{Id:'e'.repeat(64),Image:'sha256:'+'d'.repeat(64),State:{Running:false,Status:'exited',ExitCode:0},Config:{User:'10001:10001',Labels:{'upstream-radar.task':create[create.indexOf('--label')+1].split('=')[1]}},Mounts:[],HostConfig:{Privileged:false,ReadonlyRootfs:true,NetworkMode:'bridge'}}])); }
else if(args[0]==='logs') console.log(JSON.stringify({report:JSON.parse(fs.readFileSync(path.join(root,'report.json'))),attachments:[],attachmentGaps:[]}));
else if(!['build','start','wait','rm'].includes(args[0])) throw new Error('unexpected Docker command');
`)
    await chmod(join(bin, 'docker'), 0o700)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADAR_CASE_FIXTURE: root, RUNNER_TEMP: root,
      RADAR_CASE_JSON: JSON.stringify(cell), RADAR_DOCKER_CONTEXT: 'fixture', ISSUE_LOCATOR_LLM_API_KEY: 'must-not-enter-container' }
    const workflow = await readFile('.github/workflows/observe-dsh-plugin-adapter.yml', 'utf8')
    assert.doesNotMatch(workflow, /secrets\.|secrets: inherit/)
    const section = workflow.split('      - name: Observe the exact author adapter')[1]!.split('\n      - name:')[0]!
    const command = section.split('        run: |\n')[1]!.split('\n').map(line => line.replace(/^          /, '')).join('\n')
    await execFile('bash', ['-euc', command], { cwd: process.cwd(), env, timeout: 10_000 })
    assert.deepEqual(JSON.parse(await readFile(join(output, 'case.json'), 'utf8')), cell)
    assert.deepEqual(JSON.parse(await readFile(join(output, 'report.json'), 'utf8')), report)
    const container = JSON.parse(await readFile(join(output, 'container.json'), 'utf8'))
    assert.equal(container.state.Status, 'exited')
    const dispatched = JSON.parse(await readFile(join(root, 'create.json'), 'utf8')) as string[]
    assert.ok(dispatched.includes('--read-only') && dispatched.includes('10001:10001'))
    assert.ok(!dispatched.includes('--volume') && !dispatched.includes('--mount'))
    assert.doesNotMatch(JSON.stringify(dispatched), /must-not-enter-container|ISSUE_LOCATOR_LLM_API_KEY/)
    const recorded = await readFile(calls, 'utf8')
    await writeFile(join(root, 'cell.json'), JSON.stringify({ ...cell, plugin: 'dsh-feishu-bot@0.19.17' }))
    await assert.rejects(execFile(process.execPath, ['scripts/run-dsh-adapter-case.mjs', join(root, 'cell.json'), join(root, 'invalid'), join(root, 'executor.json'), '--execute'],
      { cwd: process.cwd(), env, timeout: 10_000 }))
    assert.equal(await readFile(calls, 'utf8'), recorded, 'an unreviewed recipe must fail before invoking Docker')
  } finally { await rm(root, { recursive: true, force: true }) }
})
