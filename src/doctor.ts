import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveDshProfileDirectory } from './init.js'
import { parseRadarConfig } from './inventory.js'
import { emptyRadarState } from './radar.js'
import { loadRadarState } from './radar-state.js'
import {
  createRadarStatus,
  renderRadarStatus,
  type RadarStatusReport,
} from './radar-status.js'
import type { RadarConfig, RadarState } from './radar-types.js'
import {
  isFeishuV2WebhookUrl,
  isLegacyFeishuWebhookUrl,
  normalizeRadarWebhookUrl,
  resolveRadarWebhookTargets,
} from './webhook.js'

export const DOCTOR_SCHEMA = 'upstream-radar.doctor/v1alpha1' as const

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail'
export type DoctorOverallStatus = 'ready' | 'ready-with-warnings' | 'blocked'

export interface DoctorCheck {
  id: string
  status: DoctorCheckStatus
  summary: string
  detail?: string
  action?: string
}

export interface DoctorReport {
  schema: typeof DOCTOR_SCHEMA
  status: DoctorOverallStatus
  configFile: string
  stateFile: string
  profile?: string
  checks: DoctorCheck[]
  radarStatus?: RadarStatusReport
}

export interface DoctorOptions {
  configFile: string
  stateFile?: string
  profile?: string
  patchFile?: string
  dshHome?: string
}

const MAX_CONFIG_BYTES = 8 * 1024 * 1024
const MAX_PATCH_BYTES = 1 * 1024 * 1024

function safeText(value: string, max = 2_048): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 1)}…`
}

function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error))
}

function addCheck(
  checks: DoctorCheck[],
  id: string,
  status: DoctorCheckStatus,
  summary: string,
  detail?: string,
  action?: string,
): void {
  checks.push({
    id,
    status,
    summary,
    ...(detail === undefined ? {} : { detail: safeText(detail) }),
    ...(action === undefined ? {} : { action: safeText(action) }),
  })
}

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const contents = await readFile(path, 'utf8')
  if (Buffer.byteLength(contents) > maxBytes) throw new Error(`${path} exceeds the ${maxBytes} byte limit`)
  return contents
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const contents = await readBounded(path, maxBytes)
  try {
    return JSON.parse(contents) as unknown
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
}

function profileBundles(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('DSH profile package.json must be an object')
  }
  const dsh = (value as Record<string, unknown>).dsh
  if (typeof dsh !== 'object' || dsh === null || Array.isArray(dsh)) {
    throw new Error('DSH profile package.json has no dsh section')
  }
  const profile = (dsh as Record<string, unknown>).profile
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new Error('DSH profile package.json has no dsh.profile section')
  }
  const bundles = (profile as Record<string, unknown>).bundles
  if (!Array.isArray(bundles) || !bundles.every(item => typeof item === 'string')) {
    throw new Error('DSH profile package.json has no valid dsh.profile.bundles list')
  }
  return bundles
}

async function inspectDshProfile(
  checks: DoctorCheck[],
  profile: string | undefined,
  dshHome: string | undefined,
): Promise<void> {
  if (profile === undefined) {
    addCheck(
      checks,
      'dsh-profile',
      'warn',
      '没有提供 DSH profile，无法确认原生 DSH 是否加载了 Radar',
      'doctor 只能检查配置文件，不能凭空证明某个 DSH 进程已经加载插件。',
      '使用 init 生成的配置，或传入 --profile <name>。',
    )
    return
  }

  try {
    const profileDirectory = resolveDshProfileDirectory(profile, dshHome)
    const manifestPath = resolve(profileDirectory, 'package.json')
    const bundles = profileBundles(await readJson(manifestPath, MAX_CONFIG_BYTES))
    if (!bundles.includes('upstream-radar')) {
      addCheck(
        checks,
        'dsh-profile',
        'fail',
        `DSH profile ${profile} 没有 upstream-radar bundle`,
        `当前 profile 声明了 ${bundles.length} 个 bundle，但没有 upstream-radar。`,
        `运行 dsh plugin --profile ${profile} add upstream-radar@latest 后再检查。`,
      )
      return
    }
    addCheck(
      checks,
      'dsh-profile',
      'pass',
      `DSH profile ${profile} 已登记 upstream-radar bundle`,
      manifestPath,
    )
  } catch (error: unknown) {
    addCheck(
      checks,
      'dsh-profile',
      'fail',
      `无法读取 DSH profile ${profile}`,
      errorText(error),
      `确认 DSH_HOME 和 profile 名称正确，或运行 dsh plugin --profile ${profile} add upstream-radar@latest。`,
    )
  }
}

async function inspectPatch(
  checks: DoctorCheck[],
  patchFile: string | undefined,
  configFile: string,
  stateFile: string,
  profile: string | undefined,
): Promise<void> {
  if (patchFile === undefined) {
    addCheck(
      checks,
      'dsh-overlay',
      'warn',
      '没有提供 DSH overlay，启动时将依赖 UPSTREAM_RADAR_* 环境变量',
      '这不是错误，但环境变量缺失时 Radar 会保持休眠。',
      `推荐重新运行 init --dsh-patch ./upstream-radar.dsh.yml，或显式设置 UPSTREAM_RADAR_CONFIG=${configFile}。`,
    )
    return
  }

  const output = resolve(patchFile)
  try {
    const contents = await readBounded(output, MAX_PATCH_BYTES)
    const hasBundle = contents.includes("name: 'upstream-radar/dsh'")
    const hasConfig = contents.includes(JSON.stringify(configFile))
    const hasState = contents.includes(JSON.stringify(stateFile))
    const hasProfile = profile === undefined || contents.includes(JSON.stringify(profile))
    if (!hasBundle || !hasConfig || !hasState || !hasProfile) {
      const missing = [
        ...(!hasBundle ? ['upstream-radar bundle'] : []),
        ...(!hasConfig ? ['config path'] : []),
        ...(!hasState ? ['state path'] : []),
        ...(!hasProfile ? ['profile name'] : []),
      ]
      addCheck(
        checks,
        'dsh-overlay',
        'fail',
        'DSH overlay 存在，但没有指向当前 Radar 配置',
        `缺少或不匹配：${missing.join('、')}。`,
        `用 upstream-radar init --profile ${profile ?? '<name>'} --dsh-patch ${output} --force 重新生成。`,
      )
      return
    }
    addCheck(checks, 'dsh-overlay', 'pass', 'DSH overlay 已指向当前配置、状态和 profile', output)
  } catch (error: unknown) {
    addCheck(checks, 'dsh-overlay', 'fail', '无法读取 DSH overlay', errorText(error), `确认文件存在且可读：${output}`)
  }
}

/**
 * Check the environment-based delivery route without contacting the endpoint.
 * The URL itself is deliberately never included in the report because webhook
 * query strings commonly contain a credential.
 */
function inspectWebhookEnvironment(checks: DoctorCheck[]): void {
  const configuredUrl = process.env.UPSTREAM_RADAR_WEBHOOK_URL?.trim()
  const configuredSecret = process.env.UPSTREAM_RADAR_FEISHU_SECRET?.trim()

  if (configuredUrl === undefined || configuredUrl.length === 0) {
    if (configuredSecret !== undefined && configuredSecret.length > 0) {
      addCheck(
        checks,
        'webhook-secret',
        'warn',
        '发现飞书密钥，但没有配置 webhook 地址',
        'UPSTREAM_RADAR_FEISHU_SECRET 只会用于飞书/Lark V2 自定义机器人；当前没有可用的 webhook，因此密钥会被忽略。',
        '设置 UPSTREAM_RADAR_WEBHOOK_URL，或清除 UPSTREAM_RADAR_FEISHU_SECRET。',
      )
    }
    return
  }

  let endpoint: string
  try {
    endpoint = normalizeRadarWebhookUrl(configuredUrl)
  } catch (error: unknown) {
    addCheck(
      checks,
      'webhook',
      'fail',
      'webhook 地址不可用',
      errorText(error),
      '设置一个不带账号密码、fragment 且使用 HTTPS 的 webhook 地址。',
    )
    return
  }

  if (isLegacyFeishuWebhookUrl(endpoint)) {
    addCheck(
      checks,
      'webhook',
      'fail',
      '配置的是不再支持的飞书/Lark V1 webhook',
      'Radar 只向 /open-apis/bot/v2/hook/… 地址发送原生飞书文本消息。',
      '把机器人地址替换为 /open-apis/bot/v2/hook/…；不要把旧 V1 地址继续交给 DSH。',
    )
    return
  }

  if (isFeishuV2WebhookUrl(endpoint)) {
    if (configuredSecret !== undefined && configuredSecret.length > 4_096) {
      addCheck(
        checks,
        'webhook',
        'fail',
        '飞书 webhook 密钥过长',
        'UPSTREAM_RADAR_FEISHU_SECRET 超过 4096 个字符，发送时会被拒绝。',
        '更换为不超过 4096 个字符的飞书签名密钥。',
      )
      return
    }
    addCheck(
      checks,
      'webhook',
      'pass',
      '已识别飞书/Lark V2 webhook',
      configuredSecret === undefined
        ? '使用原生 text 消息；未设置签名密钥时不会生成签名。密钥只从环境变量读取，不写入状态文件。'
        : '使用原生 text 消息和环境变量中的签名密钥；地址与密钥都不会写入状态文件。',
    )
    return
  }

  addCheck(
    checks,
    'webhook',
    'pass',
    'HTTPS webhook 配置有效',
    configuredSecret === undefined
      ? '使用通用 Radar JSON 消息；地址不会写入状态文件。'
      : '使用通用 Radar JSON 消息；飞书密钥不会用于该地址，也不会写入状态文件。',
  )
  if (configuredSecret !== undefined) {
    addCheck(
      checks,
      'webhook-secret',
      'warn',
      '飞书密钥不会用于当前 webhook',
      '只有飞书/Lark V2 自定义机器人地址会使用 UPSTREAM_RADAR_FEISHU_SECRET。',
      '如果目标是飞书，请改用 /open-apis/bot/v2/hook/… 地址；否则清除这个多余的环境变量。',
    )
  }
}

/** Check project-specific webhook environment routes without contacting them. */
function inspectProjectWebhookEnvironment(
  checks: DoctorCheck[],
  config: RadarConfig,
): void {
  const routedProjects = config.projects.filter(project => project.project.webhookUrlEnv !== undefined)
  if (routedProjects.length === 0) return
  try {
    const targets = resolveRadarWebhookTargets(config.projects)
    addCheck(
      checks,
      'project-webhooks',
      'pass',
      `已检查 ${routedProjects.length} 个项目级 webhook 路由`,
      `${targets.length} 个 endpoint；URL 和签名密钥只从环境变量读取，不写入配置或状态文件。`,
    )
  } catch (error: unknown) {
    addCheck(
      checks,
      'project-webhooks',
      'fail',
      '项目级 webhook 路由不可用',
      errorText(error),
      '设置配置中声明的 URL 环境变量，并确认地址使用 HTTPS；如果是飞书，使用 V2 webhook 地址。',
    )
  }
}

function reportStatus(checks: readonly DoctorCheck[]): DoctorOverallStatus {
  if (checks.some(check => check.status === 'fail')) return 'blocked'
  if (checks.some(check => check.status === 'warn')) return 'ready-with-warnings'
  return 'ready'
}

/** Check local Radar/DSH wiring without polling any upstream source or executing plugin code. */
export async function createDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const configFile = resolve(options.configFile)
  const stateFile = resolve(options.stateFile ?? `${configFile}.state.json`)
  const checks: DoctorCheck[] = []
  let config: RadarConfig | undefined
  let state: RadarState = emptyRadarState()
  let stateExists = false
  const configuredProfile = options.profile

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (Number.isSafeInteger(nodeMajor) && nodeMajor >= 22) {
    addCheck(checks, 'node-runtime', 'pass', `Node.js ${process.versions.node} 满足 >=22 要求`)
  } else {
    addCheck(checks, 'node-runtime', 'fail', `Node.js ${process.versions.node} 不满足 >=22 要求`, undefined, '使用 Node.js 22 或更高版本后再启动 DSH。')
  }

  try {
    config = parseRadarConfig(await readJson(configFile, MAX_CONFIG_BYTES))
    addCheck(checks, 'config', 'pass', 'Radar 配置文件有效', configFile)
  } catch (error: unknown) {
    addCheck(checks, 'config', 'fail', 'Radar 配置文件不可用', errorText(error), `重新运行 upstream-radar init，或修复 ${configFile}。`)
  }

  const profile = configuredProfile ?? config?.dshProfile?.name
  if (configuredProfile !== undefined && config?.dshProfile?.name !== undefined && configuredProfile !== config.dshProfile.name) {
    addCheck(
      checks,
      'profile-match',
      'fail',
      '命令行 profile 与配置文件不一致',
      `命令行是 ${configuredProfile}，配置文件记录的是 ${config.dshProfile.name}。`,
      '使用同一个 profile 重新运行 doctor 或重新生成配置。',
    )
  }

  if (config !== undefined) {
    try {
      await access(stateFile)
      stateExists = true
      state = await loadRadarState(stateFile)
      addCheck(checks, 'state', 'pass', '状态文件有效', stateFile)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        addCheck(
          checks,
          'state',
          'warn',
          '状态文件尚未创建，监控还没有完成过一次检查',
          stateFile,
          `启动 DSH，或运行 upstream-radar radar check ${configFile} --state ${stateFile}。`,
        )
      } else {
        addCheck(checks, 'state', 'fail', '状态文件不可用', errorText(error), '修复或移走损坏的状态文件后再运行一次检查。')
      }
    }

    const radarStatus = createRadarStatus(config, state, { configFile, stateFile, stateExists })
    if (radarStatus.coverage === 'complete') {
      addCheck(checks, 'coverage', 'pass', '必需依赖覆盖完整', `已记录 ${radarStatus.pluginBundles} 个 DSH plugin bundle。`)
    } else {
      addCheck(
        checks,
        'coverage',
        'warn',
        '依赖覆盖不完整，不能把当前结果理解成安全',
        `${radarStatus.requiredUnresolvedDependencies} 个必需依赖没有解析到。${radarStatus.dshHostDependenciesNotObserved === 0 ? '' : ` 其中 ${radarStatus.dshHostDependenciesNotObserved} 个是 DSH 宿主依赖，当前 profile 没有暴露它们的准确版本，因此不在本次检查范围内。`}`,
        '检查 DSH 运行时的依赖目录，或补充可读取的宿主依赖目录；不要把这次结果理解成完整安全结论。',
      )
    }
    if (radarStatus.monitoring === 'healthy') {
      addCheck(checks, 'monitoring', 'pass', '至少一个监控源最近成功返回')
    } else if (radarStatus.monitoring === 'degraded') {
      addCheck(checks, 'monitoring', 'warn', '监控源存在连续失败', '保留的漏洞状态仍有效，但当前数据可能不完整。', '先检查状态输出中的具体 source error。')
    } else {
      addCheck(checks, 'monitoring', 'warn', '尚未完成第一次监控', undefined, `启动 DSH 或运行 upstream-radar radar check ${configFile} --state ${stateFile}。`)
    }
    await inspectPatch(checks, options.patchFile, configFile, stateFile, profile)
    inspectWebhookEnvironment(checks)
    inspectProjectWebhookEnvironment(checks, config)

    const report: DoctorReport = {
      schema: DOCTOR_SCHEMA,
      status: reportStatus(checks),
      configFile,
      stateFile,
      ...(profile === undefined ? {} : { profile }),
      checks,
      radarStatus,
    }
    await inspectDshProfile(checks, profile, options.dshHome)
    report.status = reportStatus(checks)
    return report
  }

  await inspectPatch(checks, options.patchFile, configFile, stateFile, profile)
  inspectWebhookEnvironment(checks)
  if (config !== undefined) inspectProjectWebhookEnvironment(checks, config)
  await inspectDshProfile(checks, profile, options.dshHome)
  return {
    schema: DOCTOR_SCHEMA,
    status: reportStatus(checks),
    configFile,
    stateFile,
    ...(profile === undefined ? {} : { profile }),
    checks,
  }
}

function statusLabel(status: DoctorOverallStatus): string {
  if (status === 'ready') return 'READY'
  if (status === 'ready-with-warnings') return 'READY WITH WARNINGS'
  return 'BLOCKED'
}

/** Render a short, actionable local diagnosis for a human. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    'Upstream Radar doctor',
    `Status: ${statusLabel(report.status)}`,
    `Config: ${safeText(report.configFile)}`,
    `State: ${safeText(report.stateFile)}`,
    ...(report.profile === undefined ? [] : [`DSH profile: ${safeText(report.profile)}`]),
    '',
  ]
  for (const check of report.checks) {
    const label = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'
    lines.push(`[${label}] ${check.summary}`)
    if (check.detail !== undefined) lines.push(`       ${check.detail}`)
    if (check.action !== undefined) lines.push(`       下一步：${check.action}`)
  }
  if (report.radarStatus !== undefined) {
    lines.push('', renderRadarStatus(report.radarStatus).trimEnd())
  }
  return `${lines.join('\n')}\n`
}
