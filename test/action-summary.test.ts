import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const summaryScript = resolve(repository, 'scripts/action-summary.mjs')

describe('GitHub Action summary', () => {
  it('turns the machine report into a concise escaped job summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-action-summary-'))
    try {
      const report = join(root, 'report.json')
      await writeFile(report, JSON.stringify({
        packagesQueried: 3,
        releasePackagesQueried: 1,
        events: [{
          kind: 'vulnerability',
          change: 'new',
          affected: { name: 'parser', version: '2.9.0' },
          advisory: {
            id: 'GHSA-`demo`',
            severity: 'high',
            fixedVersions: ['3.0.0'],
            sources: ['osv', 'github-advisories'],
            conflicts: [{ field: 'fixed-versions', claims: [] }],
            riskSignals: {
              cisaKev: { knownExploited: true },
              epss: { score: 0.97224, percentile: 0.99999 },
            },
          },
          paths: [[
            { name: 'plugin', version: '1.0.0' },
            { name: 'parser', version: '2.9.0' },
          ]],
          affectedPlugins: [
            { name: 'plugin', version: '1.0.0' },
            { name: 'second-plugin', version: '1.0.0' },
          ],
        }],
        sourceErrors: [{ source: 'osv', message: 'temporary outage' }],
        policy: { status: 'fail' },
      }))
      const result = spawnSync(process.execPath, [summaryScript, report], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /## Upstream Radar/)
      assert.match(result.stdout, /source check incomplete/)
      assert.match(result.stdout, /HIGH · vulnerability/)
      assert.match(result.stdout, /plugin@1\.0\.0/)
      assert.match(result.stdout, /plugins: plugin@1\.0\.0, second-plugin@1\.0\.0/)
      assert.match(result.stdout, /GHSA-\\`demo\\`/)
      assert.match(result.stdout, /fix: 3\.0\.0/)
      assert.match(result.stdout, /sources: OSV \+ GitHub Advisory Database/)
      assert.match(result.stdout, /source conflict: fixed versions/)
      assert.match(result.stdout, /CISA KEV: known exploited/)
      assert.match(result.stdout, /EPSS: 97\.2% estimated exploitation probability/)
      assert.match(result.stdout, /next: Review parser@2\.9\.0 fixed version\(s\) 3\.0\.0 before changing the plugin\./)
      assert.match(result.stdout, /### Source warnings/)
      assert.match(result.stdout, /temporary outage/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders an exact plugin admission report with coverage and next steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-action-summary-admission-'))
    try {
      const report = join(root, 'inspect.json')
      await writeFile(report, JSON.stringify({
        schema: 'upstream-radar.scan/v1alpha1',
        target: { name: 'demo-plugin', version: '1.0.0' },
        verdict: 'review',
        riskVerdict: 'allow',
        coverageVerdict: 'incomplete',
        coverage: {
          artifactIntegrity: 'verified',
          dependencyResolution: 'resolved',
          registrySignature: 'verified',
          provenance: 'missing',
        },
        evidence: {
          npm: {
            registrySignature: { status: 'verified' },
            provenance: { status: 'missing' },
            dependencyAudit: { packages: 18 },
          },
        },
        findings: [{
          code: 'dependency-graph-incomplete',
          severity: 'high',
          summary: 'One required dependency edge could not be resolved.',
        }],
      }))
      const result = spawnSync(process.execPath, [summaryScript, report], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /plugin admission/)
      assert.match(result.stdout, /admission review required/)
      assert.match(result.stdout, /demo-plugin@1\.0\.0/)
      assert.match(result.stdout, /risk: `REVIEW` · coverage: `INCOMPLETE`/)
      assert.match(result.stdout, /18 packages/)
      assert.match(result.stdout, /dependency-graph-incomplete/)
      assert.match(result.stdout, /Review .*findings and incomplete coverage before installing it/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('gives each event kind a safe next step and distinguishes recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-action-summary-guidance-'))
    try {
      const report = join(root, 'report.json')
      await writeFile(report, JSON.stringify({
        events: [
          {
            kind: 'compatibility',
            change: 'new',
            installed: { name: 'dsh-plugin', version: '1.0.0' },
            candidate: { name: 'dsh-plugin', version: '2.0.0' },
            signals: [{ summary: 'breaking boundary' }],
          },
          {
            kind: 'source-health',
            change: 'resolved',
            source: 'osv',
            status: 'healthy',
            failureCount: 0,
          },
          {
            kind: 'vulnerability',
            change: 'new',
            plugin: { name: 'no-fix-plugin', version: '1.0.0' },
            affected: { name: 'parser', version: '2.0.0' },
            advisory: { id: 'GHSA-no-fix', severity: 'medium' },
            paths: [],
          },
          {
            kind: 'malware',
            change: 'resolved',
            plugin: { name: 'old-plugin', version: '1.0.0' },
            affected: { name: 'old-plugin', version: '1.0.0' },
            advisory: { id: 'MALWARE-demo', severity: 'critical' },
            paths: [],
          },
        ],
      }))
      const result = spawnSync(process.execPath, [summaryScript, report], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /next: inspect project impact before applying the candidate/)
      assert.match(result.stdout, /source health.*next: no action; continue monitoring/)
      assert.match(result.stdout, /fix: none published.*Assess containment or replacement for no-fix-plugin@1\.0\.0\./)
      assert.match(result.stdout, /fix: incident resolved.*Confirm the installed graph no longer matches this incident\./)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
