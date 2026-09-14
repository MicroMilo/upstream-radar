import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseDshAuthorEnvironment, validateDshAuthorEnvironment } from '../src/dsh-author-environment.js'

// A bounded excerpt of bowenliang123/dsh-context docs/compatibility.md at
// 33fd7ae6801d892ddbee7b76a964a4b2c6ff0416. The real model cited the row, not
// the header; requiring "DSH" to appear again inside every row rejected it.
const path = 'docs/compatibility.md'
const row = '| `0.1.2-rc.1` | V0 | compatible | ✅ baseline `v0.1.2-rc.1` | ✅ install OK → 1 composed row → uninstall OK → 0 rows (verified 2026-09-05) |'
const document = [
  '## Supported dsh releases', '',
  '| dsh release | Session log | Declared | Automated seam matrix | Disposable-profile install / uninstall |',
  '| --- | --- | --- | --- | --- |', row,
].join('\n')

function environment(quote = row, version = '0.1.2-rc.1', evidencePath = path) {
  return parseDshAuthorEnvironment({ packageManagers: [], overrides: [], workflows: [],
    dshVersions: [{ version, evidence: [{ path: evidencePath, quote }] }],
  })!
}

it('accepts an exact author DSH release table row through its own version-column header', () => {
  assert.doesNotThrow(() => validateDshAuthorEnvironment(environment(), new Map([[path, document]])))
})

it('does not attribute another package column, detached table or DSH baseline document to the plugin release', () => {
  const unrelated = '| 0.1.0 | 0.1.2-rc.1 | DSH integration |'
  assert.throws(() => validateDshAuthorEnvironment(environment(unrelated), new Map([[path,
    '| DSH version | Other package | Notes |\n| --- | --- | --- |\n' + unrelated,
  ]])), /not supported by plugin evidence/)
  for (const text of [
    document.replace('| dsh release |', '| package version |'),
    document.replace('| --- | --- | --- | --- | --- |', ''),
    document.replace(row, '\n| Other package | Session log | Declared | Matrix | Notes |\n| --- | --- | --- | --- | --- |\n' + row),
    document.replace(row, row + ' extra text'),
  ]) assert.throws(() => validateDshAuthorEnvironment(environment(), new Map([[path, text]])), /not supported|does not match/)
  const baseline = 'dsh-repository/docs/compatibility.md'
  assert.throws(() => validateDshAuthorEnvironment(environment(row, '0.1.2-rc.1', baseline), new Map([[baseline, document]])), /not supported/)
})

it('keeps exact quotes, column widths and bounded table input mandatory', () => {
  assert.throws(() => validateDshAuthorEnvironment(environment(row.replace('V0', 'V1')), new Map([[path, document]])), /evidence does not match/)
  assert.throws(() => validateDshAuthorEnvironment(environment(), new Map([[path, document.replace('| dsh release | Session log |', '| dsh release |')]])), /not supported/)
  assert.throws(() => validateDshAuthorEnvironment(environment(), new Map([[path, document + 'x'.repeat(48 * 1024)]])), /not supported/)
  const rangeRow = row.replace('`0.1.2-rc.1`', '`>=0.1.2-rc.1`')
  assert.throws(() => validateDshAuthorEnvironment(environment(rangeRow), new Map([[path, document.replace(row, rangeRow)]])), /not supported/)
})

it('finds the supporting DSH occurrence when the same quoted row also appears in another table', () => {
  const repeated = document.replace('| dsh release |', '| package version |') + '\n\n' + document
  assert.doesNotThrow(() => validateDshAuthorEnvironment(environment(), new Map([[path, repeated]])))
})

it('applies the same DSH-column check when the model quotes several table lines', () => {
  const otherPackage = '| DSH version | Other package |\n| --- | --- |\n| 0.1.0 | 0.1.2-rc.1 |'
  assert.throws(() => validateDshAuthorEnvironment(environment(otherPackage), new Map([[path, otherPackage]])), /not supported/)
  assert.doesNotThrow(() => validateDshAuthorEnvironment(environment(document), new Map([[path, document]])))
  const onlyOtherRow = '| Other package | Version |\n| --- | --- |\n| DSH integration | 0.1.2-rc.1 |'
  const source = document + '\n\n' + onlyOtherRow
  assert.throws(() => validateDshAuthorEnvironment(environment(onlyOtherRow), new Map([[path, source]])), /not supported/)
})

it('does not turn DSH-owned manifests or documents into plugin author requirements', () => {
  const quote = 'DSH 0.1.5-rc.2 uses pnpm 11.3.0; sdk --profile bridge; DSH_BRIDGE_DISABLED=1; overrides: {"cordis":"3.18.0"}'
  const facts = {
    packageManagers: [{ name: 'pnpm', version: '11.3.0', scope: 'development' }],
    overrides: [{ scope: 'development', values: { cordis: '3.18.0' } }],
    workflows: [{ kind: 'sdk', role: 'primary', profile: 'bridge' }],
    dshVersions: [{ version: '0.1.5-rc.2' }],
    startupConfigurations: [{ plane: 'web', scope: 'Disabled bridge comparison', environment: { DSH_BRIDGE_DISABLED: '1' } }],
  }
  for (const [key, values] of Object.entries(facts)) {
    for (const evidencePath of ['dsh-source-manifest', 'dsh-published-manifest', 'dsh-repository/README.md', 'README.md']) {
      const input = parseDshAuthorEnvironment({ packageManagers: [], overrides: [], workflows: [], dshVersions: [],
        [key]: values.map(value => ({ ...value, evidence: [{ path: evidencePath, quote }] })),
      })!
      const validate = () => validateDshAuthorEnvironment(input, new Map([[evidencePath, quote]]))
      if (evidencePath === 'README.md') assert.doesNotThrow(validate, key)
      else assert.throws(validate, /not supported/, `${key}: ${evidencePath}`)
    }
  }
})
