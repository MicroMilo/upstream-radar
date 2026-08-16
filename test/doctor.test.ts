import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createDoctorReport, renderDoctorReport } from '../src/doctor.js'
import { writeDshPatch } from '../src/init.js'
import type { RadarConfig } from '../src/radar-types.js'

function config(profile?: string): RadarConfig {
  return {
    schema: 'upstream-radar.radar-config/v1alpha1',
    ...(profile === undefined ? {} : { dshProfile: { name: profile } }),
    projects: [{
      schema: 'upstream-radar.inventory/v1alpha1',
      project: { id: 'demo', name: 'Demo project' },
      plugins: [{
        package: { ecosystem: 'npm', name: 'demo-plugin', version: '1.0.0' },
        graph: {
          schema: 'upstream-radar.dependency-graph/v1alpha1',
          rootNodeId: 'demo-plugin',
          nodes: [{ id: 'demo-plugin', name: 'demo-plugin', version: '1.0.0' }],
          edges: [],
        },
      }],
    }],
  }
}

async function writeProfile(root: string, bundles: string[]): Promise<string> {
  const profile = join(root, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles } },
  }))
  return profile
}

async function withWebhookEnvironment<T>(
  webhookUrl: string | undefined,
  feishuSecret: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const previousUrl = process.env.UPSTREAM_RADAR_WEBHOOK_URL
  const previousSecret = process.env.UPSTREAM_RADAR_FEISHU_SECRET
  if (webhookUrl === undefined) delete process.env.UPSTREAM_RADAR_WEBHOOK_URL
  else process.env.UPSTREAM_RADAR_WEBHOOK_URL = webhookUrl
  if (feishuSecret === undefined) delete process.env.UPSTREAM_RADAR_FEISHU_SECRET
  else process.env.UPSTREAM_RADAR_FEISHU_SECRET = feishuSecret
  try {
    return await action()
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTREAM_RADAR_WEBHOOK_URL
    else process.env.UPSTREAM_RADAR_WEBHOOK_URL = previousUrl
    if (previousSecret === undefined) delete process.env.UPSTREAM_RADAR_FEISHU_SECRET
    else process.env.UPSTREAM_RADAR_FEISHU_SECRET = previousSecret
  }
}

describe('upstream-radar doctor', () => {
  it('confirms the local DSH wiring without creating a state file or making a network request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-doctor-'))
    try {
      const dshHome = join(root, 'dsh-home')
      await writeProfile(dshHome, ['@deepseek-ai/dsh-base', 'upstream-radar', 'demo-plugin'])
      const configFile = join(root, 'upstream-radar.config.json')
      const stateFile = join(root, 'upstream-radar.state.json')
      const patchFile = join(root, 'upstream-radar.dsh.yml')
      await writeFile(configFile, `${JSON.stringify(config('web'), null, 2)}\n`)
      await writeDshPatch({ output: patchFile, configFile, stateFile, profile: 'web' })

      const report = await createDoctorReport({ configFile, stateFile, patchFile, dshHome })
      assert.equal(report.status, 'ready-with-warnings')
      assert.equal(report.radarStatus?.monitoring, 'not-started')
      assert.equal(report.radarStatus?.stateExists, false)
      assert.equal(report.checks.find(check => check.id === 'config')?.status, 'pass')
      assert.equal(report.checks.find(check => check.id === 'dsh-profile')?.status, 'pass')
      assert.equal(report.checks.find(check => check.id === 'dsh-overlay')?.status, 'pass')
      assert.equal(report.checks.find(check => check.id === 'state')?.status, 'warn')
      assert.match(renderDoctorReport(report), /状态文件尚未创建/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks when the selected DSH profile does not contain Radar or the state is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-doctor-blocked-'))
    try {
      const dshHome = join(root, 'dsh-home')
      await writeProfile(dshHome, ['@deepseek-ai/dsh-base', 'demo-plugin'])
      const configFile = join(root, 'upstream-radar.config.json')
      const stateFile = join(root, 'upstream-radar.state.json')
      await writeFile(configFile, `${JSON.stringify(config('web'), null, 2)}\n`)
      await writeFile(stateFile, '{not-json}\n')

      const report = await createDoctorReport({ configFile, stateFile, dshHome })
      assert.equal(report.status, 'blocked')
      assert.equal(report.checks.find(check => check.id === 'dsh-profile')?.status, 'fail')
      assert.equal(report.checks.find(check => check.id === 'state')?.status, 'fail')
      assert.match(renderDoctorReport(report), /没有 upstream-radar bundle/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the legacy environment-variable setup visible as a warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-doctor-legacy-'))
    try {
      const configFile = join(root, 'upstream-radar.config.json')
      await writeFile(configFile, `${JSON.stringify(config(), null, 2)}\n`)
      const report = await createDoctorReport({ configFile })
      assert.equal(report.status, 'ready-with-warnings')
      assert.equal(report.checks.find(check => check.id === 'dsh-profile')?.status, 'warn')
      assert.equal(report.checks.find(check => check.id === 'dsh-overlay')?.status, 'warn')
      assert.match(renderDoctorReport(report), /UPSTREAM_RADAR_\* 环境变量/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('catches invalid webhook routes before the first polling cycle and recognizes Feishu V2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-doctor-webhook-'))
    try {
      const configFile = join(root, 'upstream-radar.config.json')
      await writeFile(configFile, `${JSON.stringify(config(), null, 2)}\n`)

      await withWebhookEnvironment(
        'https://open.feishu.cn/open-apis/bot/hook/legacy-token',
        undefined,
        async () => {
          const report = await createDoctorReport({ configFile })
          assert.equal(report.status, 'blocked')
          assert.equal(report.checks.find(check => check.id === 'webhook')?.status, 'fail')
          assert.match(renderDoctorReport(report), /V1 webhook/)
          assert.doesNotMatch(renderDoctorReport(report), /legacy-token/)
        },
      )

      await withWebhookEnvironment(
        'https://open.feishu.cn/open-apis/bot/v2/hook/v2-token',
        'signing-secret',
        async () => {
          const report = await createDoctorReport({ configFile })
          assert.equal(report.checks.find(check => check.id === 'webhook')?.status, 'pass')
          assert.match(renderDoctorReport(report), /飞书\/Lark V2 webhook/)
          assert.doesNotMatch(renderDoctorReport(report), /v2-token|signing-secret/)
        },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports malformed HTTPS and unused Feishu secret configuration without contacting the endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-doctor-webhook-boundary-'))
    try {
      const configFile = join(root, 'upstream-radar.config.json')
      await writeFile(configFile, `${JSON.stringify(config(), null, 2)}\n`)

      await withWebhookEnvironment('http://alerts.example.test/radar', undefined, async () => {
        const report = await createDoctorReport({ configFile })
        assert.equal(report.status, 'blocked')
        assert.equal(report.checks.find(check => check.id === 'webhook')?.status, 'fail')
        assert.match(renderDoctorReport(report), /webhook URL must use HTTPS/)
      })

      await withWebhookEnvironment('https://alerts.example.test/radar', 'unused-secret', async () => {
        const report = await createDoctorReport({ configFile })
        assert.equal(report.checks.find(check => check.id === 'webhook')?.status, 'pass')
        assert.equal(report.checks.find(check => check.id === 'webhook-secret')?.status, 'warn')
        assert.match(renderDoctorReport(report), /不会用于当前 webhook/)
        assert.doesNotMatch(renderDoctorReport(report), /unused-secret/)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
