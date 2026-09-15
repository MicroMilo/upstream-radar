import assert from 'node:assert/strict'
import { it } from 'node:test'
import { collectDshHostNativeLoadFailures, parseDshHostBuildInventory } from '../src/dsh-host-builds.js'
import { assertDshHostBuildApproval, createDshHostBuildApproval, parseDshHostBuildApproval } from '../src/dsh-host-build-policy.js'

const installation = 'pnpm/dlx/key/instance'
const inventory = parseDshHostBuildInventory({ revision: 'dsh-host-build-inventory/1', scope: 'dsh-host-build-facts',
  dshVersion: '0.1.3-alpha.2', pnpmVersion: '11.7.0', coverageGaps: [],
  installation: { location: installation, manifestSha256: '1'.repeat(64), hostManifestSha256: '2'.repeat(64),
    lockfileSha256: '3'.repeat(64), lockGraphDigest: `sha256:${'4'.repeat(64)}` },
  packages: ['fs-ext@2.1.1', 'protobufjs@7.6.6'].map(spec => ({ spec, location: `${installation}/node_modules/.pnpm/${spec}/node_modules/${spec.split('@')[0]}`,
    manifestSha256: '5'.repeat(64), lifecycleScripts: { install: 'operator-owned fixture build' },
    reportedLocators: [spec], metadataSources: ['pendingBuilds'] })) })
const failures = collectDshHostNativeLoadFailures(inventory, '/sandbox/cache',
  `Error: Cannot find module './build/Release/fs_ext.node'\nRequire stack:\n- /sandbox/cache/${inventory.packages[0]!.location}/fs-ext.js\n`)
const context = { caseId: 'context-node24-web', plugin: 'dsh-context@0.52.2', artifactSha256: '6'.repeat(64),
  sourceFingerprint: `sha256:${'7'.repeat(64)}`, dshVersion: '0.1.3-alpha.2', plane: 'web' as const, profile: 'web',
  runtime: { nodeMajor: 24, nodeVersion: '24.21.0', platform: 'linux', architecture: 'arm64', pnpmVersion: '11.7.0' },
  profileEnvironment: { pnpmVersion: '11.7.0', overrides: {} } }

it('grants only an explicitly reviewed host failure and binds its permission to the complete execution identity', () => {
  const approval = createDshHostBuildApproval({ inventory, failures, context, packages: ['fs-ext@2.1.1'] })
  assert.equal(approval.scope, 'dsh-host-dependency-builds')
  assert.deepEqual(approval.packages, ['fs-ext@2.1.1'])
  assert.deepEqual(parseDshHostBuildApproval(JSON.parse(JSON.stringify(approval))), approval)
  assert.deepEqual(assertDshHostBuildApproval(approval, inventory, context), approval)
  assert.throws(() => createDshHostBuildApproval({ inventory, failures, context, packages: ['protobufjs@7.6.6'] }), /failure/)
  assert.throws(() => createDshHostBuildApproval({ inventory, failures, context, packages: ['fs-ext'] }), /exact/)
  for (const changed of [
    { ...context, artifactSha256: '8'.repeat(64) },
    { ...context, sourceFingerprint: `sha256:${'8'.repeat(64)}` },
    { ...context, caseId: 'different-surface' },
    { ...context, runtime: { ...context.runtime, nodeVersion: '24.22.0' } },
    { ...context, runtime: { ...context.runtime, architecture: 'x64' } },
    { ...context, profileEnvironment: { ...context.profileEnvironment, overrides: { other: '1.0.0' } } },
    { ...context, startupConfiguration: { scope: 'disabled comparison', environment: { DSH_LARK_DISABLED: '1' } } },
  ]) assert.throws(() => assertDshHostBuildApproval(approval, inventory, changed), /context/)
  for (const changed of [
    { ...inventory, installation: { ...inventory.installation!, lockGraphDigest: `sha256:${'8'.repeat(64)}` } },
    { ...inventory, installation: { ...inventory.installation!, lockfileSha256: '8'.repeat(64) } },
    { ...inventory, packages: inventory.packages.map(item => ({ ...item, manifestSha256: '8'.repeat(64) })) },
    { ...inventory, coverageGaps: ['physical package inspection incomplete'] },
  ]) assert.throws(() => assertDshHostBuildApproval(approval, changed, context), /inventory|coverage/)
})

it('accepts the same installed identity under a fresh DLX instance but binds every selected physical peer variant', () => {
  const second = { ...inventory.packages[0]!, location: `${installation}/node_modules/.pnpm/fs-ext@2.1.1_peer@1.0.0/node_modules/fs-ext` }
  const duplicated = { ...inventory, packages: [...inventory.packages, second] }
  const approval = createDshHostBuildApproval({ inventory: duplicated, failures, context, packages: ['fs-ext@2.1.1'] })
  const replacement = 'pnpm/dlx/new-cache-key/new-instance'
  const relocated = { ...duplicated, installation: { ...duplicated.installation!, location: replacement },
    packages: duplicated.packages.map(item => ({ ...item, location: item.location.replace(installation, replacement), metadataSources: ['pendingBuilds' as const, 'ignoredBuilds' as const] })) }
  assert.deepEqual(assertDshHostBuildApproval(approval, relocated, context), approval)
  assert.throws(() => assertDshHostBuildApproval(approval, inventory, context), /inventory/)
  assert.throws(() => assertDshHostBuildApproval(approval, { ...duplicated, packages: [...inventory.packages, { ...second, manifestSha256: '8'.repeat(64) }] }, context), /inventory/)
})

it('retains a verified previous host permission while approving a newly observed native gate', () => {
  const previousApproval = createDshHostBuildApproval({ inventory, failures, context, packages: ['fs-ext@2.1.1'] })
  const laterFailures = collectDshHostNativeLoadFailures(inventory, '/sandbox/cache',
    `Cannot find module './native.node'\nRequire stack:\n- /sandbox/cache/${inventory.packages[1]!.location}/index.js\n`)
  const input = { inventory, failures: laterFailures, context, previousApproval, packages: ['fs-ext@2.1.1', 'protobufjs@7.6.6'] }
  const combined = createDshHostBuildApproval(input)
  assert.deepEqual(combined.packages, input.packages)
  assert.deepEqual(assertDshHostBuildApproval(combined, inventory, context), combined)
  assert.throws(() => createDshHostBuildApproval({ ...input, packages: ['protobufjs@7.6.6'] }), /retain/)
  assert.throws(() => createDshHostBuildApproval({ ...input, inventory: { ...inventory,
    installation: { ...inventory.installation!, lockfileSha256: '8'.repeat(64) } } }), /inventory/)
  assert.throws(() => createDshHostBuildApproval({ ...input, context: { ...context, artifactSha256: '8'.repeat(64) } }), /context/)
})
