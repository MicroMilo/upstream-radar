import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_VERSION = '0.1.0-rc.6'
const DEFAULT_PLUGIN_SPECS = [
  'dsh-cloudflare-browser-run@0.1.1',
  '@open-agfs/dsh-agfs@0.1.9',
  'dsh-feishu-bot@0.14.0',
]
const PLUGIN_SPECS = (process.env.DSH_ADOPTION_PLUGINS === undefined
  ? DEFAULT_PLUGIN_SPECS
  : process.env.DSH_ADOPTION_PLUGINS.split(',').map(spec => spec.trim()).filter(Boolean))
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

function summarizeInstallFailure(result) {
  const text = `${result.stdout}\n${result.stderr}`
  const signals = []
  if (text.includes('ERR_PNPM_IGNORED_BUILDS') || text.includes('Ignored build scripts')) {
    signals.push('DSH/pnpm stopped on an unapproved dependency build script')
  }
  if (text.includes('Issues with peer dependencies')) signals.push('peer dependency warnings were reported')
  if (text.includes('pnpm failed in profile directory')) signals.push('the DSH profile install was not completed')
  if (signals.length === 0) signals.push('the DSH profile install command failed')
  return signals
}

function summarizeEvent(event) {
  if (event.kind === 'compatibility') {
    return {
      id: event.id,
      incidentId: event.incidentId,
      kind: event.kind,
      change: event.change,
      plugin: event.plugin,
      installed: event.installed,
      candidate: event.candidate,
      signals: event.signals.map(signal => ({
        code: signal.code,
        confidence: signal.confidence,
        summary: signal.summary,
        ...(signal.before === undefined ? {} : { before: signal.before }),
        ...(signal.after === undefined ? {} : { after: signal.after }),
      })),
      ...(event.upgradePath === undefined ? {} : {
        upgradePath: {
          evaluated: event.upgradePath.evaluated,
          blockedCount: event.upgradePath.blockedCount,
          vulnerabilityStatus: event.upgradePath.vulnerabilityStatus,
          ...(event.upgradePath.dependencyStatus === undefined ? {} : { dependencyStatus: event.upgradePath.dependencyStatus }),
          ...(event.upgradePath.firstCandidate === undefined ? {} : { firstCandidate: event.upgradePath.firstCandidate.candidate }),
        },
      }),
      ...(event.releaseNotesUrl === undefined ? {} : { releaseNotesUrl: event.releaseNotesUrl }),
    }
  }
  if (event.kind === 'vulnerability' || event.kind === 'malware') {
    return {
      id: event.id,
      incidentId: event.incidentId,
      kind: event.kind,
      change: event.change,
      plugin: event.plugin,
      affected: event.affected,
      advisory: {
        id: event.advisory.id,
        severity: event.advisory.severity,
        summary: event.advisory.summary,
      },
    }
  }
  return {
    id: event.id,
    incidentId: event.incidentId,
    kind: event.kind,
    change: event.change,
    source: event.source,
    error: event.error,
  }
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
    const pluginTarballs = []
    for (const pluginSpec of PLUGIN_SPECS) {
      const pluginPack = requireSuccess(await run('npm', [
        'pack', '--ignore-scripts', '--pack-destination', packages, pluginSpec,
      ]), `real DSH plugin pack (${pluginSpec})`)
      const pluginTarball = join(packages, pluginPack.stdout.trim().split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).at(-1) ?? '')
      if (!pluginTarball.endsWith('.tgz')) throw new Error(`real DSH plugin pack did not produce a tarball: ${pluginSpec}`)
      pluginTarballs.push({ spec: pluginSpec, tarball: pluginTarball })
    }

    // DSH creates its shared host dependency plane on first CLI startup. Help
    // is enough to initialize that plane without starting an Agent, loading a
    // plugin, calling a model, or executing plugin business actions.
    requireSuccess(await run(PNPM, [
      'dlx', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', 'headless', '--help',
    ], { env }), 'DSH host runtime bootstrap')
    requireSuccess(await run(PNPM, [
      'dlx', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'headless', 'add', radarTarball,
    ], { env }), 'Radar DSH install')
    const pluginInstallations = []
    for (const plugin of pluginTarballs) {
      const result = await run(PNPM, [
        'dlx', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'headless', 'add', plugin.tarball,
      ], { env })
      if (result.code === 0) {
        pluginInstallations.push({ spec: plugin.spec, status: 'installed' })
      } else {
        pluginInstallations.push({
          spec: plugin.spec,
          status: 'blocked',
          exitCode: result.code,
          signals: summarizeInstallFailure(result),
        })
      }
    }

    const installedPluginSpecs = pluginInstallations
      .filter(plugin => plugin.status === 'installed')
      .map(plugin => plugin.spec)
    if (installedPluginSpecs.length === 0) {
      throw new Error(`none of the real DSH plugins could be installed: ${JSON.stringify(pluginInstallations)}`)
    }

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
    const plugins = config.projects?.[0]?.plugins ?? []
    const pluginsBySpec = new Map(plugins.map(plugin => [
      `${plugin.package?.name}@${plugin.package?.version}`,
      plugin,
    ]))
    for (const pluginSpec of installedPluginSpecs) {
      const plugin = pluginsBySpec.get(pluginSpec)
      if (plugin === undefined) throw new Error(`setup did not discover the expected real DSH plugin: ${pluginSpec}`)
      if (plugin.graph?.source !== 'installed-node-modules') throw new Error(`setup did not use the installed DSH graph: ${pluginSpec}`)
      if ((plugin.graph?.hostRuntime?.resolvedNodes ?? 0) < 1) throw new Error(`setup did not observe the DSH host dependency plane: ${pluginSpec}`)
      if (plugin.graph?.hostRuntime?.package?.name !== '@deepseek-ai/dsh'
        || plugin.graph.hostRuntime.package.version !== DSH_VERSION) {
        throw new Error(`setup did not record the exact DSH executable package for ${pluginSpec}: ${JSON.stringify(plugin.graph?.hostRuntime?.package)}`)
      }
      if ((plugin.graph?.unresolved ?? []).some(item => item.kind !== 'optional')) {
        throw new Error(`real DSH graph has a required unresolved dependency: ${pluginSpec}`)
      }
    }

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
      plugins: PLUGIN_SPECS,
      install: {
        packagePackScriptsDisabled: true,
        profile: 'headless',
        radarBundleRegistered: checkStatus(doctorAfter, 'dsh-profile') === 'pass',
        pluginInstallations,
      },
      setup: {
        status: setup.stdout.includes('Local wiring check:') ? 'completed' : 'unknown',
        pluginCount: plugins.length,
        plugins: installedPluginSpecs.map(pluginSpec => {
          const plugin = pluginsBySpec.get(pluginSpec)
          return {
            package: plugin.package,
            graphSource: plugin.graph.source,
            dshRuntimePackage: plugin.graph.hostRuntime.package,
            dependencyNodes: plugin.graph.nodes.length,
            dshHostPackages: plugin.graph.hostRuntime.resolvedNodes,
            unresolvedOptionalDependencies: (plugin.graph.unresolved ?? []).filter(item => item.kind === 'optional').length,
          }
        }),
      },
      check: {
        packagesQueried: check.packagesQueried,
        releasePackagesQueried: check.releasePackagesQueried,
        events: check.events.length,
        eventSummaries: check.events.map(summarizeEvent),
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
      boundary: 'Uses a disposable DSH_HOME and exact published packages. Radar and all real plugin tarballs were packed with lifecycle scripts disabled; the DSH host is bootstrapped with --help. It does not start an Agent, call a model, or execute plugin business actions; it proves multi-plugin install, graph, doctor, and real upstream checks.',
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
