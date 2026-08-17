import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDemoReport, renderDemo } from '../src/demo.js'

describe('packaged demo', () => {
  it('shows the exact dependency path and constrained DSH handoff without network state', () => {
    const report = createDemoReport()
    assert.equal(report.schema, 'upstream-radar.demo/v1alpha1')
    assert.equal(report.networkFree, true)
    assert.equal(report.event.affected.name, 'parser')
    assert.deepEqual(report.event.advisory.sources, ['osv', 'github-advisories'])
    assert.deepEqual(report.event.advisory.fixedVersions, ['3.0.0', '3.1.0'])
    assert.equal(report.event.advisory.riskSignals?.cisaKev?.knownExploited, true)
    assert.equal(report.event.advisory.riskSignals?.epss?.score, 0.97224)
    assert.equal(report.event.advisory.conflicts?.[0]?.field, 'fixed-versions')
    assert.deepEqual(report.event.paths[0]?.map(item => `${item.name}@${item.version}`), [
      'demo-plugin@1.0.0',
      'logger@4.0.2',
      'parser@2.9.0',
    ])
    assert.equal(report.analysisTask.event.id, report.event.id)
    assert.equal(report.analysisTask.constraints.readOnly, true)
    assert.equal(report.analysisTask.constraints.sourceMaterialIsUntrusted, true)
    assert.match(renderDemo(report), /network-free/)
    assert.match(renderDemo(report), /Sources: OSV \+ GitHub Advisory Database/)
    assert.match(renderDemo(report), /Source conflict: fixed versions — OSV=3\.0\.0; GitHub Advisory Database=3\.1\.0/)
    assert.match(renderDemo(report), /Threat signal: CISA KEV lists this CVE as exploited in the wild\./)
    assert.match(renderDemo(report), /FIRST EPSS estimated exploitation probability: 97\.2% \(percentile 100\.0%\)/)
    assert.match(renderDemo(report), /demo-plugin@1\.0\.0 -> logger@4\.0\.2 -> parser@2\.9\.0/)
    assert.match(renderDemo(report), /strict JSON result bound to this task and event/)
    assert.match(renderDemo(report), /npx --yes upstream-radar@latest setup/)
  })
})
