import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_VERSION = '0.1.0-rc.6'
const PLUGIN_SPEC = 'dsh-cloudflare-browser-run@0.1.1'
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const CLI = join(ROOT, 'dist/src/cli.js')
const WRITE_REPORT = process.argv.includes('--write-report')
const KEEP_DSH_ADOPTION = process.env.KEEP_DSH_ADOPTION === '1'
const REPORT_PATH = join(ROOT, 'examples/dsh/reports/adoption-smoke.json')

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', rejectRun)
    child.on('close', code => resolveRun({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

function requireSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label} exited with ${result.code}:\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function lastTarball(output, label) {
  const tarball = output.trim().split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).at(-1)
  if (tarball === undefined) throw new Error(`${label} did not return a tarball path: ${output}`)
  return resolve(tarball)
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}\n${result.stderr}`)
  }
}

function checkStatus(report, id) {
  return report.checks.find(check => check.id === id)?.status
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'upstream-radar-dsh-adoption-'))
  const dshHome = join(scratch, 'dsh-home')
  const project = join(scratch, 'project')
  const packages = join(scratch, 'packages')
  await mkdir(project, { recursive: true })
  await mkdir(packages, { recursive: true })

  const env = {
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_MODE: 'DISABLED',
  }

  try {
    const radarTarball = lastTarball(
      requireSuccess(await run(PNPM, ['pack', '--pack-destination', packages], {
        env: { npm_config_ignore_scripts: 'true' },
      }), 'Radar pack').stdout,
      'Radar pack',
    )
    const pluginPack = requireSuccess(await run('npm', [
      'pack', '--ignore-scripts', '--pack-destination', packages, PLUGIN_SPEC,
    ]), 'real DSH plugin pack')
    const pluginTarball = join(packages, pluginPack.stdout.trim().split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).at(-1) ?? '')
    if (!pluginTarball.endsWith('.tgz')) throw new Error('real DSH plugin pack did not produce a tarball')

    // DSH creates its shared host dependency plane on first CLI startup. Help
    // is enough to initialize that plane without starting an Agent, loading a
    // plugin, calling a model, or executing plugin business actions.
    requireSuccess(await run(PNPM, [
      'dlx', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', 'headless', '--help',
    ], { env }), 'DSH host runtime bootstrap')
    requireSuccess(await run(PNPM, [
      'dlx', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'headless', 'add', radarTarball,
    ], { env }), 'Radar DSH install')
    requireSuccess(await run(PNPM, [
      'dlx', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'headless', 'add', pluginTarball,
    ], { env }), 'real DSH plugin install')

    const configName = 'upstream-radar.config.json'
    const patchName = 'upstream-radar.dsh.yml'
    const stateName = `${configName}.state.json`
    const setup = requireSuccess(await run(process.execPath, [
      CLI,
      'setup',
      '--no-install',
      '--profile',
      'headless',
      '--project-id',
      'real-dsh-consumer',
      '--project-name',
      'Real DSH consumer',
      '--output',
      configName,
      '--dsh-patch',
      patchName,
    ], { cwd: project, env }), 'Radar setup')

    const configPath = join(project, configName)
    const patchPath = join(project, patchName)
    const statePath = join(project, stateName)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const plugin = config.projects?.[0]?.plugins?.[0]
    if (plugin?.package?.name !== 'dsh-cloudflare-browser-run' || plugin.package.version !== '0.1.1') {
      throw new Error(`setup did not discover the expected real DSH plugin: ${JSON.stringify(plugin?.package)}`)
    }
    if (plugin.graph?.source !== 'installed-node-modules') throw new Error('setup did not use the installed DSH graph')
    if ((plugin.graph?.hostRuntime?.resolvedNodes ?? 0) < 1) throw new Error('setup did not observe the DSH host dependency plane')
    if (plugin.graph?.hostRuntime?.package?.name !== '@deepseek-ai/dsh'
      || plugin.graph.hostRuntime.package.version !== DSH_VERSION) {
      throw new Error(`setup did not record the exact DSH executable package: ${JSON.stringify(plugin.graph?.hostRuntime?.package)}`)
    }
    if ((plugin.graph?.unresolved ?? []).some(item => item.kind !== 'optional')) throw new Error('real DSH graph has a required unresolved dependency')

    const doctorBefore = parseJson(requireSuccess(await run(process.execPath, [
      CLI, 'doctor', configName, '--profile', 'headless', '--patch', patchName, '--json',
    ], { cwd: project, env }), 'doctor before first check'), 'doctor before first check')
    if (doctorBefore.status === 'blocked' || checkStatus(doctorBefore, 'dsh-profile') !== 'pass') {
      throw new Error(`doctor did not accept the generated DSH wiring: ${JSON.stringify(doctorBefore)}`)
    }

    const check = parseJson(requireSuccess(await run(process.execPath, [
      CLI,
      'radar',
      'check',
      configName,
      '--state',
      stateName,
      '--frozen',
      '--fail-on',
      'never',
      '--json',
    ], { cwd: project, env }), 'real DSH dependency check'), 'real DSH dependency check')
    if (check.sourceErrors.length !== 0) throw new Error(`real DSH check reported source errors: ${JSON.stringify(check.sourceErrors)}`)

    const doctorAfter = parseJson(requireSuccess(await run(process.execPath, [
      CLI, 'doctor', configName, '--profile', 'headless', '--patch', patchName, '--json',
    ], { cwd: project, env }), 'doctor after first check'), 'doctor after first check')
    if (doctorAfter.status !== 'ready' || checkStatus(doctorAfter, 'monitoring') !== 'pass') {
      throw new Error(`doctor did not become ready after the first check: ${JSON.stringify(doctorAfter)}`)
    }

    const status = parseJson(requireSuccess(await run(process.execPath, [
      CLI, 'radar', 'status', configName, '--state', stateName, '--json',
    ], { cwd: project, env }), 'real DSH status'), 'real DSH status')
    if (status.monitoring !== 'healthy' || status.coverage !== 'complete') {
      throw new Error(`real DSH status is not healthy and complete: ${JSON.stringify(status)}`)
    }

    const report = {
      schema: 'upstream-radar.dsh-adoption-showcase/v1alpha1',
      dshVersion: DSH_VERSION,
      plugin: PLUGIN_SPEC,
      install: {
        packagePackScriptsDisabled: true,
        profile: 'headless',
        radarBundleRegistered: checkStatus(doctorAfter, 'dsh-profile') === 'pass',
      },
      setup: {
        status: setup.stdout.includes('Local wiring check:') ? 'completed' : 'unknown',
        graphSource: plugin.graph.source,
        dshRuntimePackage: plugin.graph.hostRuntime.package,
        dependencyNodes: plugin.graph.nodes.length,
        dshHostPackages: plugin.graph.hostRuntime.resolvedNodes,
        optionalDependenciesNotInstalled: (plugin.graph.unresolved ?? []).filter(item => item.kind === 'optional').length,
      },
      check: {
        packagesQueried: check.packagesQueried,
        releasePackagesQueried: check.releasePackagesQueried,
        events: check.events.length,
        sourceErrors: check.sourceErrors.length,
        activeVulnerabilities: Object.keys(check.state.activeVulnerabilities).length,
      },
      doctor: {
        beforeFirstCheck: doctorBefore.status,
        afterFirstCheck: doctorAfter.status,
      },
      status: {
        monitoring: status.monitoring,
        coverage: status.coverage,
        activeVulnerabilities: status.activeVulnerabilities,
        activeCompatibility: status.activeCompatibility,
        sourceHealthIncidents: status.activeSourceHealth,
      },
      boundary: 'Uses a disposable DSH_HOME and exact published packages. Both package tarballs were packed with lifecycle scripts disabled; the DSH host is bootstrapped with --help. It does not start an Agent, call a model, or execute plugin business actions; it proves install, graph, doctor, and real upstream checks.',
    }
    if (WRITE_REPORT) {
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    if (KEEP_DSH_ADOPTION) process.stderr.write(`Kept DSH adoption showcase files at ${scratch}\n`)
    else await rm(scratch, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
