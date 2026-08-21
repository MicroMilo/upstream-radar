import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDshCompatibilityIR,
  buildDshCompatibilityReverseIndex,
  parseDshCompatibilityIR,
  parseDshCompatibilityReverseIndex,
} from '../src/dsh-compatibility-ir.js'
import {
  DSH_COMPATIBILITY_LEDGER_SCHEMA,
  type DshCompatibilityLedger,
} from '../src/dsh-compatibility-ledger.js'

function ledger(): DshCompatibilityLedger {
  return {
    schema: DSH_COMPATIBILITY_LEDGER_SCHEMA,
    entries: [{
      caseId: 'openpencil-node24',
      targetId: 'openpencil',
      plugin: '@zseven-w/dsh-openpencil@0.1.0-rc.1',
      dshVersion: '0.1.0-rc.8',
      runtime: {
        nodeMajor: 24,
        nodeVersion: '24.19.0',
        platform: 'linux',
        architecture: 'x64',
        pnpmVersion: '11.7.0',
      },
      staticFingerprint: `sha256:${'a'.repeat(64)}`,
      contractFingerprint: `sha256:${'b'.repeat(64)}`,
      observedAt: '2026-08-22T00:00:00.000Z',
      result: 'peer-contract-incompatible',
      reason: 'one direct host peer is absent and one resolved version is outside the declared range',
      artifact: {
        lifecycleScripts: [],
        sha256: 'c'.repeat(64),
      },
      resolution: {
        runtimeGraph: {
          digest: `sha256:${'d'.repeat(64)}`,
          nodes: 447,
          edges: 2020,
          unresolved: 1,
          optionalUnavailable: 59,
          pluginPeerContracts: {
            declared: 3,
            satisfied: 1,
            mismatched: 1,
            indeterminate: 0,
            missing: 1,
            relations: [
              {
                name: '@deepseek-ai/dsh-client-ui-slots',
                required: '^0.1.0-rc.6',
                status: 'missing',
                staticUsage: 'type-only-reference-observed',
              },
              {
                name: '@deepseek-ai/dsh-tools',
                required: '^0.1.0-rc.6',
                status: 'satisfied',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '0.1.0-rc.8',
              },
              {
                name: 'react-dom',
                required: '^18.2.0',
                status: 'mismatched',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '19.2.8',
              },
            ],
            issues: [
              {
                name: '@deepseek-ai/dsh-client-ui-slots',
                required: '^0.1.0-rc.6',
                status: 'missing',
                staticUsage: 'type-only-reference-observed',
              },
              {
                name: 'react-dom',
                required: '^18.2.0',
                status: 'mismatched',
                staticUsage: 'runtime-import-observed',
                resolvedVersion: '19.2.8',
              },
            ],
          },
          hostRuntime: { source: 'dsh-profile-fallback', resolvedNodes: 38, dshVersion: '0.1.0-rc.8' },
        },
      },
      observer: {
        schema: 'upstream-radar.dsh-install-observation/v1alpha1',
        version: '0.41.0',
      },
    }],
  }
}

describe('DSH compatibility IR', () => {
  it('normalizes the measured plugin-to-host contracts and materializes reverse impacts', () => {
    const ir = buildDshCompatibilityIR(ledger())

    assert.equal(ir.cells.length, 1)
    assert.equal(ir.relations.length, 3)
    assert.equal(ir.cells[0]?.plugin.artifactSha256, 'c'.repeat(64))
    assert.equal(ir.cells[0]?.evidence.runtimeGraphNodes, 447)
    assert.deepEqual(ir.relations.map(relation => ({
      name: relation.dependency.name,
      status: relation.dependency.status,
      staticUsage: relation.dependency.staticUsage,
      resolvedVersion: relation.dependency.resolvedVersion,
    })), [
      { name: '@deepseek-ai/dsh-client-ui-slots', status: 'missing', staticUsage: 'type-only-reference-observed', resolvedVersion: undefined },
      { name: '@deepseek-ai/dsh-tools', status: 'satisfied', staticUsage: 'runtime-import-observed', resolvedVersion: '0.1.0-rc.8' },
      { name: 'react-dom', status: 'mismatched', staticUsage: 'runtime-import-observed', resolvedVersion: '19.2.8' },
    ])
    assert.deepEqual(parseDshCompatibilityIR(ir), ir)

    const reverse = buildDshCompatibilityReverseIndex(ir)
    assert.deepEqual(parseDshCompatibilityReverseIndex(reverse), reverse)
    assert.deepEqual(reverse.dependencies.find(item => item.name === 'react-dom')?.impacts, [{
      relationId: ir.relations.find(item => item.dependency.name === 'react-dom')?.id,
      cellId: ir.cells[0]?.id,
      caseId: 'openpencil-node24',
      plugin: '@zseven-w/dsh-openpencil@0.1.0-rc.1',
      dshVersion: '0.1.0-rc.8',
      nodeMajor: 24,
      required: '^18.2.0',
      status: 'mismatched',
      staticUsage: 'runtime-import-observed',
      resolvedVersion: '19.2.8',
    }])
  })

  it('refuses an IR that silently drops a declared peer relation', () => {
    const ir = buildDshCompatibilityIR(ledger())
    const incomplete = {
      ...ir,
      relations: ir.relations.slice(1),
    }
    assert.throws(() => parseDshCompatibilityIR(incomplete), /relation count does not match declared peer contracts/)
  })
})
