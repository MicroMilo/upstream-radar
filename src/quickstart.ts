import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { discoverDshProfiles } from './init.js'
import { TOOL_VERSION } from './version.js'

export const QUICKSTART_SCHEMA = 'upstream-radar.quickstart/v1alpha1' as const

export type QuickstartMode =
  | 'configured'
  | 'dsh'
  | 'choose-dsh-profile'
  | 'pnpm-lock'
  | 'npm-lock'
  | 'choose-lockfile'
  | 'demo'

export type QuickstartEffect = 'read-only' | 'writes-local-files' | 'installs-and-writes' | 'installs-and-starts'

export interface QuickstartStep {
  label: string
  command: string
  effect: QuickstartEffect
  reason: string
}

export interface QuickstartReport {
  schema: typeof QUICKSTART_SCHEMA
  cwd: string
  mode: QuickstartMode
  evidence: {
    config?: string
    pnpmLock?: string
    npmLock?: string
    dshProfiles: string[]
  }
  steps: QuickstartStep[]
  warnings: string[]
}

export interface QuickstartOptions {
  /** Override DSH_HOME for callers that already resolved the local profile root. */
  dshHome?: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function launcher(): string {
  return `npx --yes upstream-radar@${TOOL_VERSION}`
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function configuredForDsh(path: string): Promise<boolean | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const value = raw as Record<string, unknown>
    return typeof value.dshProfile === 'object' && value.dshProfile !== null && !Array.isArray(value.dshProfile)
  } catch {
    return undefined
  }
}

function setupSteps(profile?: string): QuickstartStep[] {
  const profileArg = profile === undefined ? '' : ` --profile ${shellQuote(profile)}`
  const setup = `${launcher()} setup${profileArg} --project-name ${shellQuote('My DSH project')}`
  const start = `${setup} --start`
  return [
    {
      label: 'Generate and check DSH wiring',
      command: setup,
      effect: 'installs-and-writes',
      reason: 'Install the exact Radar bundle version, generate a reviewable config and DSH overlay, then run the local doctor.',
    },
    {
      label: 'Start in one command (optional)',
      command: start,
      effect: 'installs-and-starts',
      reason: 'Runs the same doctor gate before installing/starting DSH; copy this only when you explicitly accept starting DSH.',
    },
    {
      label: 'View the first check result',
      command: `${launcher()} radar status ./upstream-radar.config.json`,
      effect: 'read-only',
      reason: 'Reads local state only; it does not query vulnerability sources again.',
    },
  ]
}

function lockfileSteps(kind: 'pnpm' | 'npm', file: string): QuickstartStep[] {
  const flag = kind === 'pnpm' ? '--pnpm-lock' : '--npm-lock'
  const init = `${launcher()} init ${flag} ${shellQuote(`./${file}`)}`
  return [
    {
      label: 'Build a reviewable inventory',
      command: init,
      effect: 'writes-local-files',
      reason: 'Reads only the lockfile and writes a static dependency graph; it does not run plugin code or lifecycle scripts.',
    },
    {
      label: 'Run the first vulnerability check',
      command: `${launcher()} radar check ./upstream-radar.config.json --frozen --fail-on high`,
      effect: 'read-only',
      reason: 'Checks exact locked versions; --frozen means the local DSH profile is not read.',
    },
  ]
}

function demoSteps(): QuickstartStep[] {
  return [{
    label: 'See the network-free demo first',
    command: `${launcher()} demo`,
    effect: 'read-only',
    reason: 'Shows the exact-path-to-DSH task loop without reading a repository, installing packages, or claiming the demo advisory is real.',
  }]
}

function finalizeReport(report: QuickstartReport): QuickstartReport {
  if (report.cwd === resolve(process.cwd())) return report
  const prefix = `cd ${shellQuote(report.cwd)} && `
  return {
    ...report,
    steps: report.steps.map(step => ({ ...step, command: `${prefix}${step.command}` })),
  }
}

/** Inspect the local project and return one honest first-use path without changing anything. */
export async function createQuickstartReport(root = process.cwd(), options: QuickstartOptions = {}): Promise<QuickstartReport> {
  const cwd = resolve(root)
  const configFile = join(cwd, 'upstream-radar.config.json')
  const pnpmLockFile = join(cwd, 'pnpm-lock.yaml')
  const npmLockFile = join(cwd, 'package-lock.json')
  const hasConfig = await isFile(configFile)
  const hasPnpmLock = await isFile(pnpmLockFile)
  const hasNpmLock = await isFile(npmLockFile)
  const warnings: string[] = []

  if (hasConfig) {
    const dshConfig = await configuredForDsh(configFile)
    if (dshConfig === undefined) warnings.push('upstream-radar.config.json exists, but its DSH profile origin is unclear; run doctor first.')
    return finalizeReport({
      schema: QUICKSTART_SCHEMA,
      cwd,
      mode: 'configured',
      evidence: {
        config: 'upstream-radar.config.json',
        ...(hasPnpmLock ? { pnpmLock: 'pnpm-lock.yaml' } : {}),
        ...(hasNpmLock ? { npmLock: 'package-lock.json' } : {}),
        dshProfiles: [],
      },
      steps: [
        {
          label: 'View the current status',
          command: `${launcher()} radar status ./upstream-radar.config.json`,
          effect: 'read-only',
          reason: 'Confirm whether a check has completed and whether any Agent tasks are waiting.',
        },
        {
          label: dshConfig === true ? 'Run one live check' : 'Run one frozen check',
          command: `${launcher()} radar check ./upstream-radar.config.json${dshConfig === true ? '' : ' --frozen'} --fail-on high`,
          effect: 'read-only',
          reason: dshConfig === true
            ? 'Refresh the configured DSH profile graph, then query the configured upstream sources.'
            : 'Query upstream sources using the reviewed static graph without reading a local DSH profile.',
        },
      ],
      warnings,
    })
  }

  let dshProfiles: string[] = []
  try {
    dshProfiles = await discoverDshProfiles(options.dshHome)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(`Could not fully inspect DSH profiles: ${message.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 512)}`)
  }

  if (dshProfiles.length === 1) {
    return finalizeReport({
      schema: QUICKSTART_SCHEMA,
      cwd,
      mode: 'dsh',
      evidence: {
        ...(hasPnpmLock ? { pnpmLock: 'pnpm-lock.yaml' } : {}),
        ...(hasNpmLock ? { npmLock: 'package-lock.json' } : {}),
        dshProfiles: [...dshProfiles],
      },
      steps: setupSteps(dshProfiles[0]),
      warnings,
    })
  }

  if (dshProfiles.length > 1) {
    const steps: QuickstartStep[] = dshProfiles.map(profile => ({
      label: `Choose DSH profile: ${profile}`,
      command: `${launcher()} setup --profile ${shellQuote(profile)} --project-name ${shellQuote('My DSH project')}`,
      effect: 'installs-and-writes' as const,
      reason: 'More than one profile has third-party bundles; Radar will not guess which one you want to monitor.',
    }))
    if (hasPnpmLock && !hasNpmLock) steps.push(...lockfileSteps('pnpm', 'pnpm-lock.yaml'))
    if (hasNpmLock && !hasPnpmLock) steps.push(...lockfileSteps('npm', 'package-lock.json'))
    return finalizeReport({
      schema: QUICKSTART_SCHEMA,
      cwd,
      mode: 'choose-dsh-profile',
      evidence: {
        ...(hasPnpmLock ? { pnpmLock: 'pnpm-lock.yaml' } : {}),
        ...(hasNpmLock ? { npmLock: 'package-lock.json' } : {}),
        dshProfiles: [...dshProfiles],
      },
      steps,
      warnings,
    })
  }

  if (hasPnpmLock && hasNpmLock) {
    return finalizeReport({
      schema: QUICKSTART_SCHEMA,
      cwd,
      mode: 'choose-lockfile',
      evidence: { pnpmLock: 'pnpm-lock.yaml', npmLock: 'package-lock.json', dshProfiles: [] },
      steps: [
        ...lockfileSteps('pnpm', 'pnpm-lock.yaml').slice(0, 1),
        ...lockfileSteps('npm', 'package-lock.json').slice(0, 1),
      ],
      warnings: [...warnings, 'Both pnpm-lock.yaml and package-lock.json are present; choose the lockfile your team actually uses. Radar will not guess.'],
    })
  }

  if (hasPnpmLock) {
    return finalizeReport({
      schema: QUICKSTART_SCHEMA,
      cwd,
      mode: 'pnpm-lock',
      evidence: { pnpmLock: 'pnpm-lock.yaml', dshProfiles: [] },
      steps: lockfileSteps('pnpm', 'pnpm-lock.yaml'),
      warnings,
    })
  }

  if (hasNpmLock) {
    return finalizeReport({
      schema: QUICKSTART_SCHEMA,
      cwd,
      mode: 'npm-lock',
      evidence: { npmLock: 'package-lock.json', dshProfiles: [] },
      steps: lockfileSteps('npm', 'package-lock.json'),
      warnings,
    })
  }

  return finalizeReport({
    schema: QUICKSTART_SCHEMA,
    cwd,
    mode: 'demo',
    evidence: { dshProfiles: [] },
    steps: demoSteps(),
    warnings,
  })
}

function effectLabel(effect: QuickstartEffect): string {
  switch (effect) {
    case 'read-only': return 'read-only'
    case 'writes-local-files': return 'writes local files'
    case 'installs-and-writes': return 'installs and writes'
    case 'installs-and-starts': return 'installs/starts'
  }
}

function detectedText(report: QuickstartReport): string {
  const items: string[] = []
  if (report.evidence.config !== undefined) items.push(report.evidence.config)
  if (report.evidence.pnpmLock !== undefined) items.push(report.evidence.pnpmLock)
  if (report.evidence.npmLock !== undefined) items.push(report.evidence.npmLock)
  if (report.evidence.dshProfiles.length > 0) items.push(`DSH profiles: ${report.evidence.dshProfiles.join(', ')}`)
  return items.length === 0 ? 'no Radar config, supported lockfile, or eligible DSH profile' : items.join('; ')
}

/** Render a compact copy/paste guide for humans. */
export function renderQuickstartReport(report: QuickstartReport): string {
  const lines = [
    'Upstream Radar quickstart — read-only inspection',
    `Detected: ${detectedText(report)}`,
    `Recommended path: ${report.mode}`,
    '',
  ]
  for (const [index, step] of report.steps.entries()) {
    lines.push(`${index + 1}. ${step.label} [${effectLabel(step.effect)}]`)
    lines.push(`   ${step.reason}`)
    lines.push(`   $ ${step.command}`)
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
  }
  lines.push('', 'Safety: quickstart itself only inspected local files and DSH profile metadata; it did not install packages, start DSH, query vulnerability sources, or execute plugin code.')
  return `${lines.join('\n')}\n`
}
