import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CASE_ROOT = join(ROOT, 'examples/cases/dsh-web-ui-issue-71')
const DEFAULT_REPORT = join(ROOT, 'examples/dsh/reports/dsh-web-ui-issue-71-analysis.json')
const writeReport = process.argv.includes('--write-report')
const envFileArgumentIndex = process.argv.indexOf('--env-file')
const envFile = envFileArgumentIndex >= 0 ? process.argv[envFileArgumentIndex + 1] : process.env.ISSUE_LOCATOR_ENV_FILE

const { checkDshProfile } = await import('../dist/src/dsh-profile-check.js')

function parseEnv(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const equal = line.indexOf('=')
    if (equal < 1) continue
    let value = line.slice(equal + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[line.slice(0, equal).trim()] = value
  }
  return result
}

async function loadLlmConfig() {
  const values = {
    ISSUE_LOCATOR_LLM_BASE_URL: process.env.ISSUE_LOCATOR_LLM_BASE_URL,
    ISSUE_LOCATOR_LLM_API_KEY: process.env.ISSUE_LOCATOR_LLM_API_KEY,
    ISSUE_LOCATOR_LLM_MODEL: process.env.ISSUE_LOCATOR_LLM_MODEL,
  }
  if (envFile !== undefined) {
    try {
      await access(envFile)
      Object.assign(values, parseEnv(await readFile(envFile, 'utf8')))
    } catch (error) {
      return { configured: false, source: envFile, error: `cannot read env file: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const configured = Boolean(values.ISSUE_LOCATOR_LLM_BASE_URL && values.ISSUE_LOCATOR_LLM_API_KEY && values.ISSUE_LOCATOR_LLM_MODEL)
  return {
    configured,
    source: envFile ?? 'process environment',
    ...(configured
      ? {
          baseUrl: values.ISSUE_LOCATOR_LLM_BASE_URL,
          apiKey: values.ISSUE_LOCATOR_LLM_API_KEY,
          model: values.ISSUE_LOCATOR_LLM_MODEL,
        }
      : {}),
  }
}

function fallbackAnalysis() {
  return {
    root_cause: 'minimumReleaseAge 让 profile 留在旧的 0.1.5/0.1.4 组合；旧版把 qq98 皮肤放进 bundled carrier，但生成的 patch 仍插入已经不存在的独立包。手动补装独立包后，又会和 carrier 自带的 ui-skin-qq98 重复注册。',
    user_impact: '启动前已经可以确定 profile 不一致：修复前会因为缺少 loader 包而失败，手动补包会变成 duplicate loader entry；这不是“启动后再观察”的问题。',
    maintainer_fix: '把相关 @linxin666 包升级到 0.1.7，按 bundled carrier 的方式激活已有 loader 行，不再插入独立 qq98 包；同时把这些包加入 minimumReleaseAgeExclude，避免新修复版本被冷却期挡住。',
    why_monitoring_matters: 'Radar 只需读取 profile 的锁文件、patch 和 release-age 配置，就能在 DSH 启动前复现这条因果链，并把可修复的版本/patch 改动交给作者。',
    confidence: 'high',
  }
}

function parseModelJson(text) {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('model returned no JSON object')
  const value = JSON.parse(trimmed.slice(start, end + 1))
  const fields = ['root_cause', 'user_impact', 'maintainer_fix', 'why_monitoring_matters', 'confidence']
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== fields.length) {
    throw new Error('model returned an unexpected JSON shape')
  }
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].length === 0) throw new Error(`model field ${field} is invalid`)
  }
  return value
}

async function askModel(config, facts) {
  if (!config.configured) return { status: 'not-configured' }
  const prompt = [
    '你是 DSH 插件维护者的故障分析助手。下面的事实由静态检查器直接得到。',
    '不要改变 blocked/pass 判断，不要把推测写成事实；只解释根因、用户影响、作者修复和为什么值得持续监控。',
    '只输出一个 JSON 对象，字段必须是 root_cause、user_impact、maintainer_fix、why_monitoring_matters、confidence。',
    JSON.stringify(facts, null, 2),
  ].join('\n\n')
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '只返回合法 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) return { status: 'unavailable', httpStatus: response.status }
    const body = await response.json()
    const text = body?.choices?.[0]?.message?.content
    if (typeof text !== 'string') return { status: 'unavailable', error: 'model response has no message content' }
    return { status: 'used', result: parseModelJson(text) }
  } catch (error) {
    return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) }
  }
}

function compactReport(report) {
  return {
    status: report.status,
    packageManager: report.packageManager,
    lockfile: report.lockfile,
    dependencyNodes: report.dependencyGraph?.nodes.length ?? 0,
    loaderEntries: report.loaderEntries,
    findings: report.findings.map(finding => ({
      code: finding.code,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      remediation: finding.remediation,
    })),
  }
}

const cases = [
  { id: 'before', directory: join(CASE_ROOT, 'before'), checkedAt: '2026-08-17T08:00:00.000Z' },
  { id: 'manual-add', directory: join(CASE_ROOT, 'manual-add'), checkedAt: '2026-08-17T08:01:00.000Z' },
  { id: 'fixed', directory: join(CASE_ROOT, 'fixed'), checkedAt: '2026-08-17T08:02:00.000Z' },
]

const checked = []
for (const item of cases) {
  const report = await checkDshProfile({ profileDirectory: item.directory, checkedAt: item.checkedAt })
  checked.push({ id: item.id, report: compactReport(report) })
}
assert.equal(checked.find(item => item.id === 'before')?.report.status, 'blocked')
assert.equal(checked.find(item => item.id === 'manual-add')?.report.status, 'blocked')
assert.equal(checked.find(item => item.id === 'fixed')?.report.status, 'pass')

const facts = {
  case: 'dsh-web-ui release-age / skin-loader mismatch',
  sources: [
    'https://github.com/zhu1090093659/dsh-web-ui/issues/71',
    'https://github.com/zhu1090093659/dsh-web-ui/issues/35',
  ],
  static_checks: checked,
  boundaries: {
    installs: false,
    plugin_code: false,
    dsh_start: false,
    static_facts_are_decisive: true,
  },
}
const config = await loadLlmConfig()
const model = await askModel(config, facts)
const analysis = model.status === 'used' ? model.result : fallbackAnalysis()
const output = {
  schema: 'upstream-radar.dsh-case-analysis/v1alpha1',
  generatedAt: new Date().toISOString(),
  case: facts.case,
  sources: facts.sources,
  staticChecks: checked,
  analysis,
  analysisSource: model.status === 'used' ? 'issue-locator-llm' : 'deterministic-evidence-fallback',
  model: {
    status: model.status,
    configured: config.configured,
    source: config.source,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(model.httpStatus === undefined ? {} : { httpStatus: model.httpStatus }),
    ...(model.error === undefined ? {} : { error: model.error }),
  },
  execution: {
    network: model.status !== 'not-configured',
    installs: false,
    pluginCode: false,
    dshAgent: false,
    llm: model.status === 'used',
  },
}

if (writeReport) await writeFile(DEFAULT_REPORT, `${JSON.stringify(output, null, 2)}\n`)

const before = checked.find(item => item.id === 'before')
const manualAdd = checked.find(item => item.id === 'manual-add')
const fixed = checked.find(item => item.id === 'fixed')
console.log(`Case: ${facts.case}`)
console.log(`Before DSH starts: ${before?.report.status.toUpperCase()} — ${before?.report.findings.map(finding => finding.code).join(', ')}`)
console.log(`Manual package workaround: ${manualAdd?.report.status.toUpperCase()} — ${manualAdd?.report.findings.map(finding => finding.code).join(', ')}`)
console.log(`Maintainer fix replay: ${fixed?.report.status.toUpperCase()} — ${fixed?.report.findings.length ?? 0} findings`)
console.log(`Analysis: ${output.analysisSource}`)
console.log(`Root cause: ${analysis.root_cause}`)
console.log(`Author fix: ${analysis.maintainer_fix}`)
console.log(`Model: ${model.status}${model.httpStatus === undefined ? '' : ` (HTTP ${model.httpStatus})`}`)
if (writeReport) console.log(`Report: ${DEFAULT_REPORT}`)
