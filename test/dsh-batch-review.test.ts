import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  applyDshEnvironmentRecommendationsToSurfaceTargets,
  createDshEnvironmentRecommendationInputFingerprint,
  parseDshEnvironmentRecommendationDecision,
  parseDshEnvironmentRecommendations,
  type DshEnvironmentRecommendationCandidate,
} from '../src/dsh-environment-recommendation.js'
import { emptyDshCompatibilityLedger, mergeDshCompatibilityLedger, type DshCompatibilityExpectedCase } from '../src/dsh-compatibility-ledger.js'
import { buildDshSurfacePlan, emptyDshSurfaceLedger, mergeDshSurfaceLedger, parseDshSurfaceLedger, type DshSurfaceExpectedCase } from '../src/dsh-surface.js'
import { satisfiesSemverRange } from '../src/semver.js'

const root = new URL('../../examples/dsh/batch-review/2026-09-13/', import.meta.url)
const json = async (name: string) => JSON.parse(await readFile(new URL(name, root), 'utf8'))

describe('real DSH batch pre-execution review regression', () => {
  it('binds the fresh plane-aware headless run without converting browser gaps into plugin faults', async () => {
    const [prior, matrix] = await Promise.all([json('final-install-matrix.json'), json('plane-aware-install-matrix.json')])
    const reports = await Promise.all(matrix.include.map((cell: DshCompatibilityExpectedCase) => json(`plane-aware-install-reports/${cell.id}/report.json`)))
    assert.equal(reports.length, 10)
    assert.ok(matrix.include.every((cell: DshCompatibilityExpectedCase) => cell.contractFingerprint !== prior.include.find((old: DshCompatibilityExpectedCase) => old.id === cell.id).contractFingerprint))
    assert.ok(reports.every(report => report.executionContract === 'dsh-install/v1alpha3'
      && ['install', 'registration', 'load'].every(stage => report.stages[stage].status === 'passed')))
    const merged = mergeDshCompatibilityLedger({ ledger: emptyDshCompatibilityLedger(), expected: matrix.include, reports })
    assert.deepEqual(merged.rejectedReports, [])
    assert.equal(merged.acceptedCaseIds.length, 10)
    assert.equal(merged.ledger.entries.filter(entry => entry.result === 'compatible').length, 7)
    assert.equal(merged.ledger.entries.filter(entry => entry.result === 'unknown').length, 2)
    assert.equal(merged.ledger.entries.filter(entry => entry.result === 'peer-contract-incompatible').length, 1)
    for (const id of ['better-sidebar-node22', 'openpencil-node24']) {
      const entry = merged.ledger.entries.find(entry => entry.caseId === id)!
      assert.equal(entry.artifact.client?.platform, 'web')
      assert.ok(entry.artifact.client?.entryPoints.length)
      assert.equal(entry.resolution?.runtimeGraph?.pluginPeerContracts?.missing, 4)
      assert.ok(entry.resolution?.runtimeGraph?.pluginPeerContracts?.relations.every(relation => relation.usageByPlane !== undefined))
      assert.match(entry.reason, /coverage.*incomplete/)
    }
    assert.equal(merged.ledger.entries.find(entry => entry.caseId === 'dsh-univer-office-node22')?.resolution?.runtimeGraph?.pluginPeerContracts?.mismatched, 7)
  })

  it('retains the historical twenty-cell run and requires a new run after collector changes', async () => {
    const matrix = await json('plane-aware-surface-matrix.json') as { include: DshSurfaceExpectedCase[] }
    const reports = await Promise.all(matrix.include.map(cell => json(`plane-aware-surface-reports/${cell.id}/report.json`)))
    const historical = parseDshSurfaceLedger(await json('plane-aware-surface-ledger.json'))
    assert.equal(historical.entries.length, 10)
    assert.equal(historical.entries.filter(entry => entry.result === 'compatible').length, 9)
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: matrix.include, reports })
    assert.equal(merged.acceptedCaseIds.length, 0)
    assert.equal(merged.rejectedReports.length, 10)
    assert.ok(merged.rejectedReports.every(reason => /expected surface contract does not match the current collector requirements/.test(reason)))
    assert.equal(merged.missingCaseIds.length, 10)
    for (const report of reports) {
      assert.equal(report.executionContract, 'dsh-surface/v1alpha8')
      const prior = await json(`surface-final-reports/${report.caseId}/report.json`)
      assert.ok(Date.parse(report.startedAt) > Date.parse(prior.completedAt))
      assert.equal(report.artifact.sha256, prior.artifact.sha256)
      if (report.evidence.plane !== 'web' || report.result !== 'compatible') continue
      assert.match(report.evidence.clientContract.boot.sha256, /^[a-f0-9]{64}$/)
      assert.equal(report.evidence.clientContract.peerVersions, 'not-observed')
      if (report.evidence.pluginClientDeclared) {
        assert.ok(report.evidence.clientContract.boot.entries.some((entry: { id: string }) => entry.id === report.runtimeId))
        assert.match(report.evidence.clientContract.pluginBundle.sha256, /^[a-f0-9]{64}$/)
      }
    }
    const feishu = historical.entries.find(entry => entry.caseId === 'feishu-bot-node22-web')!
    assert.equal(feishu.stages.host.code, 1)
    assert.match(feishu.stages.host.detail!, /assertNever/)
    const [install, summary] = await Promise.all([json('plane-aware-compatibility-ledger.json'), json('plane-aware-summary.json')])
    assert.equal(summary.loop.allTwentyPlannedObservationsCompleted, true)
    assert.equal(summary.loop.unresolvedInfrastructureResults, 0)
    assert.equal(summary.loop.incompleteDependencyCoverageCells, 2)
    assert.equal(summary.browserContractCoverage.rosters, 7)
    assert.equal(summary.browserContractCoverage.exactBundleDigests, 6)
    assert.equal(summary.additionalAuthorSdkEvidenceReusedFromPriorRun, true)
    const newPlan = buildDshSurfacePlan(await json('surface-targets.json'), install, historical)
    assert.equal(newPlan.run, true)
    assert.equal(newPlan.matrix.include.length, 10)
    assert.ok(newPlan.matrix.include.every(cell => cell.reasons.includes('surface-contract-changed')))
  })

  it('keeps the author-supported SDK initialize success separate from the newer-host API mismatch', async () => {
    const author = await json('radar-feishu-sdk-author-pnpm10-proxy.json')
    const next = await json('radar-feishu-sdk-next-pnpm10-proxy.json')
    assert.equal(author.pnpmVersion, '10.33.0')
    assert.equal(next.pnpmVersion, '10.33.0')
    assert.equal(author.artifact.sha256, next.artifact.sha256)
    assert.equal(author.dshVersion, '0.1.0-rc.8')
    assert.equal(author.result, 'sdk-initialize-compatible')
    assert.equal(author.commands.at(-1).code, 0)
    assert.equal(next.dshVersion, '0.1.5-rc.2')
    assert.equal(next.result, 'sdk-initialize-failed')
    assert.equal(next.commands.at(-1).code, 1)
    assert.match(next.commands.at(-1).stdout, /ImageVariantId/)
    for (const report of [author, next]) {
      assert.equal(report.fixtureRequests, 0)
      assert.match(report.coverage, /initialize only/)
      assert.match(report.runtimeGraph.scope, /not-independent-sdk-profile/)
      assert.match(report.runtimeGraph.digest, /^sha256:[a-f0-9]{64}$/)
    }
    // Preserve the actual two physical server versions rather than deduplicating by package name.
    const servers = next.runtimeGraph.selectedPackages.filter((x: { name: string }) => x.name === '@deepseek-ai/dsh-sdk-jsonrpc-server')
    assert.deepEqual(servers.map((x: { version: string }) => x.version).sort(), ['0.1.0-rc.8', '0.1.5-rc.2'])
  })

  it('reconciles all twenty final exact-artifact observations without hiding peer facts or the real Web failure', async () => {
    const matrix = await json('final-install-matrix.json') as { include: DshCompatibilityExpectedCase[] }
    const headless = await Promise.all(matrix.include.map(cell => json(`${cell.allowedBuilds === '' ? 'final-reports' : 'build-reports'}/${cell.id}/report.json`)))
    const install = mergeDshCompatibilityLedger({ ledger: emptyDshCompatibilityLedger(), expected: matrix.include, reports: headless })
    assert.equal(install.acceptedCaseIds.length, 10)
    assert.deepEqual(install.rejectedReports, [])
    assert.equal(install.ledger.entries.filter(x => x.result === 'compatible').length, 7)
    assert.equal(install.ledger.entries.filter(x => x.result === 'peer-contract-incompatible').length, 3)
    assert.ok(install.ledger.entries.every(x => x.resolution?.runtimeGraph?.digest && x.runtime.architecture === 'arm64'))
    const surfaces = await json('surface-matrix.json') as { include: DshSurfaceExpectedCase[] }
    const reports = await Promise.all(surfaces.include.map(cell => json(`surface-final-reports/${cell.id}/report.json`)))
    const historical = parseDshSurfaceLedger(await json('surface-ledger.json'))
    const merged = mergeDshSurfaceLedger({ ledger: emptyDshSurfaceLedger(), expected: surfaces.include, reports })
    assert.equal(merged.acceptedCaseIds.length, 0)
    assert.equal(merged.rejectedReports.length, 10)
    assert.ok(merged.rejectedReports.every(reason => /expected surface contract does not match the current collector requirements/.test(reason)))
    assert.equal(historical.entries.filter(x => x.result === 'compatible').length, 9)
    assert.ok(historical.entries.every(x => x.resolution?.runtimeGraph?.digest && x.runtime.architecture === 'arm64'))
    const feishu = historical.entries.find(x => x.caseId === 'feishu-bot-node22-web')!
    assert.equal(feishu.result, 'surface-incompatible')
    assert.equal(feishu.stages.host.code, 1)
    const univer = historical.entries.find(x => x.caseId === 'dsh-univer-office-node22-web')!
    assert.equal(univer.result, 'compatible')
    assert.equal(univer.resolution?.runtimeGraph?.pluginPeerContracts?.mismatched, 7)
    const plan = buildDshSurfacePlan(await json('surface-targets.json'), install.ledger, historical, new Date('2026-09-13T12:20:00.000Z'))
    assert.equal(plan.run, true)
    assert.ok(plan.matrix.include.every(cell => cell.reasons.includes('surface-contract-changed')))
    assert.deepEqual(plan.blocked, [])
  })

  it('retains the real difference between a Web host-only tool and a published browser client', async () => {
    const cloudflare = await json('surface-final-reports/cloudflare-browser-node22-web/report.json')
    assert.equal(cloudflare.evidence.pluginClientDeclared, false)
    assert.equal(cloudflare.evidence.pluginEntryPresent, false)
    assert.equal(cloudflare.evidence.pluginMaterialized, false)
    assert.equal(cloudflare.evidence.applicationMounted, true)
    assert.equal(cloudflare.result, 'compatible')
    for (const id of ['context-node22-web', 'context-node24-web', 'better-sidebar-node22-web', 'dsh-agy-link-node24-web', 'dsh-univer-office-node22-web', 'openpencil-node24-web']) {
      const report = await json(`surface-final-reports/${id}/report.json`)
      assert.equal(report.evidence.pluginClientDeclared, true)
      assert.equal(report.evidence.pluginBundleStatus, 200)
      assert.equal(report.evidence.pluginMaterialized, true)
    }
  })

  it('preserves actual oversized/missing-document gaps in the historical batch inputs', async () => {
    const [candidates, review] = await Promise.all([json('candidates-with-coverage.json'), json('reviewed-recommendations.json')])
    const history = parseDshEnvironmentRecommendations(review)
    assert.equal(candidates.length, 8)
    assert.ok(candidates.find((item: DshEnvironmentRecommendationCandidate) => item.targetId === 'better-sidebar')?.collectionGaps?.some((gap: string) => /README.*exceeds/.test(gap)))
    for (const candidate of candidates as DshEnvironmentRecommendationCandidate[]) {
      const parsed = history.entries.find(item => item.targetId === candidate.targetId)!
      assert.equal(parsed.plugin, candidate.plugin)
      if ((candidate.collectionGaps?.length ?? 0) > 0) assert.match(parsed.coverageGaps?.join(' ') ?? '', /collection is incomplete/)
    }
  })

  it('keeps all ten incomplete real observations as review evidence under their actual Linux/arm64 contracts', async () => {
    const matrix = await json('install-matrix.json') as { include: DshCompatibilityExpectedCase[] }
    const reports = await Promise.all(matrix.include.map(cell => json(`reports/${cell.id}/report.json`)))
    const merged = mergeDshCompatibilityLedger({ ledger: emptyDshCompatibilityLedger(), expected: matrix.include, reports })
    assert.equal(merged.acceptedCaseIds.length, 10)
    assert.deepEqual(merged.rejectedReports, [])
    assert.ok(merged.ledger.entries.every(entry => entry.result === 'unknown' && entry.runtime.architecture === 'arm64'))
    assert.ok(merged.transitions.every(transition => transition.status === 'new-review-signal'))
  })

  it('retains eight historical manual reviews without granting them current execution authority', async () => {
    const [candidates, review, targets, observations, history] = await Promise.all([
      json('candidates.json'), json('review-decisions.json'), json('install-targets.json'), json('observations.json'), json('reviewed-recommendations.json'),
    ])
    assert.equal(candidates.length, 8)
    assert.match(review.reviewer, /not a configured DSH Agent/)
    const recommendations = parseDshEnvironmentRecommendations(history)
    const entries = recommendations.entries
    for (const candidate of candidates as DshEnvironmentRecommendationCandidate[]) {
      const entry = entries.find(item => item.targetId === candidate.targetId)!
      assert.equal(entry.plugin, candidate.plugin)
      assert.equal(entry.sourceFingerprint, candidate.sourceFingerprint)
      assert.notEqual(entry.inputFingerprint, createDshEnvironmentRecommendationInputFingerprint(candidate))
      assert.throws(() => parseDshEnvironmentRecommendationDecision(
        review.decisions.find((item: { targetId: string }) => item.targetId === candidate.targetId).decision,
        candidate,
      ), /authorEnvironment.*required/)
    }
    const surfaces = applyDshEnvironmentRecommendationsToSurfaceTargets({
      schema: 'upstream-radar.dsh-surface-targets/v1alpha1', refreshAfterHours: 168, surfaces: [],
    }, targets, observations, recommendations)
    assert.equal(surfaces.surfaces.length, 0, 'old manual review does not schedule a new execution')
    assert.equal(entries.find((item: { targetId: string }) => item.targetId === 'openpencil')?.plugin,
      '@zseven-w/dsh-openpencil@0.1.0-rc.9')
    assert.equal(entries.find((item: { targetId: string }) => item.targetId === 'better-sidebar')?.preferredNodeMajor, 22)
    assert.match(entries.find((item: { targetId: string }) => item.targetId === 'feishu-bot')?.coverageGaps?.join(' ') ?? '', /SDK adapter/)
    // pnpm 11.7 checks peers with includePrerelease:true; an old caret branch
    // can admit rc.2 despite the newest exact OR branch naming only rc.1.
    const tui = candidates.find((item: DshEnvironmentRecommendationCandidate) => item.targetId === 'dsh-tui')
    assert.equal(satisfiesSemverRange('0.1.5-rc.2', tui.publishedManifest.peerDependencies['@deepseek-ai/dsh-agent']), true)
  })
})
