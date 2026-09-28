import assert from 'node:assert/strict'
import { it } from 'node:test'
import { observeDshPluginSurface } from '../src/dsh-surface-observation.js'
import type { InstallObservationCommandProgress } from '../src/dsh-install-observation.js'

it('exposes live Web-profile command progress before downloading any target artifact', async () => {
  const events: InstallObservationCommandProgress[] = []
  const report = await observeDshPluginSurface({ packageSpec: 'fixture-plugin@1.0.0', dshVersion: '0.1.5-rc.2',
    caseId: 'fixture-node22-web', sourceCaseId: 'fixture-node22',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`, contractFingerprint: `sha256:${'b'.repeat(64)}`,
    expectedArtifactSha256: 'c'.repeat(64), plane: 'web', profile: 'web', runtimeId: 'fixture-plugin',
    profileEnvironment: { pnpmVersion: '99.0.0', overrides: {} }, allowExecution: true,
    isolationProvider: 'other', timeoutMs: 30_000,
    hostEnvironment: { PATH: process.env.PATH, UPSTREAM_RADAR_ISOLATED_RUNNER: '1' },
    onProgress: event => events.push(event) })
  assert.equal(report.result, 'unknown')
  assert.deepEqual(events.map(event => event.kind), ['started', 'finished'])
  assert.ok(events.every(event => event.phase === 'runtime'))
  assert.equal(report.stages.artifact.status, 'skipped', 'no package code was reached under the wrong pnpm')
})
