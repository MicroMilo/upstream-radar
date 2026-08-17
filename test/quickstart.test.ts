import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createQuickstartReport, renderQuickstartReport } from '../src/quickstart.js'

describe('quickstart guidance', () => {
  it('starts with the network-free demo in an empty directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-empty-'))
    try {
      const report = await createQuickstartReport(root, { dshHome: join(root, 'no-dsh') })
      assert.equal(report.mode, 'demo')
      assert.equal(report.steps.length, 1)
      assert.match(report.steps[0]?.command ?? '', / upstream-radar@0\.33\.0 demo$/)
      assert.match(renderQuickstartReport(report), /only inspected local files/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers an existing config over other local signals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-config-'))
    try {
      await writeFile(join(root, 'upstream-radar.config.json'), JSON.stringify({
        schema: 'upstream-radar.radar-config/v1alpha1',
        projects: [],
      }))
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
      const report = await createQuickstartReport(root, { dshHome: join(root, 'no-dsh') })
      assert.equal(report.mode, 'configured')
      assert.equal(report.evidence.config, 'upstream-radar.config.json')
      assert.equal(report.steps[0]?.effect, 'read-only')
      assert.match(report.steps[1]?.command ?? '', /--frozen/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('chooses the only supported lockfile and explains the two-step path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-pnpm-'))
    try {
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
      const report = await createQuickstartReport(root, { dshHome: join(root, 'no-dsh') })
      assert.equal(report.mode, 'pnpm-lock')
      assert.equal(report.steps.length, 2)
      assert.equal(report.steps[0]?.effect, 'writes-local-files')
      assert.match(report.steps[0]?.command ?? '', /init --pnpm-lock '\.\/pnpm-lock\.yaml'/)
      assert.match(report.steps[1]?.command ?? '', /radar check .*--frozen --fail-on high/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefixes commands with cd when inspecting a directory outside the caller cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-path-'))
    try {
      await writeFile(join(root, 'package-lock.json'), '{}\n')
      const report = await createQuickstartReport(root, { dshHome: join(root, 'no-dsh') })
      assert.match(report.steps[0]?.command ?? '', new RegExp(`^cd '${root.replaceAll("'", "'\\''")}' && `))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not guess when both lockfiles exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-both-'))
    try {
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
      await writeFile(join(root, 'package-lock.json'), '{}\n')
      const report = await createQuickstartReport(root, { dshHome: join(root, 'no-dsh') })
      assert.equal(report.mode, 'choose-lockfile')
      assert.equal(report.steps.length, 2)
      assert.ok(report.warnings.some(item => item.includes('Both pnpm-lock.yaml')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects one eligible DSH profile and keeps the explicit start boundary visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-quickstart-dsh-'))
    const dshHome = join(root, 'dsh-home')
    const profile = join(dshHome, 'profiles', 'web')
    try {
      await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
      }))
      const report = await createQuickstartReport(root, { dshHome })
      assert.equal(report.mode, 'dsh')
      assert.deepEqual(report.evidence.dshProfiles, ['web'])
      assert.equal(report.steps[0]?.effect, 'installs-and-writes')
      assert.equal(report.steps[1]?.effect, 'installs-and-starts')
      assert.match(report.steps[1]?.command ?? '', /--start/)
      assert.match(report.steps[2]?.command ?? '', /radar status/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
