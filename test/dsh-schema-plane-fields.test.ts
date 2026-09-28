import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

type Schema = { $ref?: string; additionalProperties?: boolean; properties?: Record<string, Schema>;
  items?: Schema; $defs?: Record<string, Schema>; const?: unknown; maxItems?: number; type?: string; pattern?: string }
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

// This checks recursive field admission, not a replacement for a JSON Schema validator.
function assertAdmittedFields(schema: Schema, value: unknown, root: Schema, path = '$'): void {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace('#/$defs/', '')
    assert.ok(root.$defs?.[name], `missing schema definition ${name}`)
    return assertAdmittedFields(root.$defs[name]!, value, root, path)
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => assertAdmittedFields(schema.items!, item, root, `${path}[${index}]`))
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, item] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(schema.properties?.[name], `${path}.${name} is rejected by the published schema`)
      if (schema.properties?.[name]) assertAdmittedFields(schema.properties[name]!, item, root, `${path}.${name}`)
    }
  }
}

describe('published plane-aware evidence schema consistency', () => {
  it('admits both legacy history and every fresh install observation field', async () => {
    const schema = await json('schemas/dsh-install-observation.schema.json') as Schema
    const batch = 'examples/dsh/batch-review/2026-09-13/'
    const matrix = await json(batch + 'plane-aware-install-matrix.json')
    for (const cell of matrix.include) assertAdmittedFields(schema,
      await json(`${batch}plane-aware-install-reports/${cell.id}/report.json`), schema)
    assertAdmittedFields(schema, await json(batch + 'final-reports/cloudflare-browser-node22/report.json'), schema)
    assert.equal(schema.properties?.executionContract?.const, 'dsh-install/v1alpha6')
    assert.equal(schema.$defs?.clientContract?.properties?.entryPoints?.maxItems, 64)
    const pathPattern = new RegExp(schema.$defs!.clientContract!.properties!.entryPoints!.items!.pattern!)
    assert.ok(pathPattern.test('lib/client.js'))
    for (const path of ['../entry.js', 'lib/../entry.js', '/entry.js', 'lib//entry.js', 'lib\\entry.js', 'lib/*.js', 'lib/']) {
      assert.equal(pathPattern.test(path), false, path)
    }
  })

  it('admits all fresh IR metadata, runtime plane and peer provenance fields', async () => {
    const schema = await json('schemas/dsh-compatibility-ir.schema.json') as Schema
    assertAdmittedFields(schema, await json('examples/dsh/batch-review/2026-09-13/plane-aware-compatibility-ir.json'), schema)
    assert.equal(schema.properties?.cells?.items?.properties?.runtime?.properties?.executionPlane?.const, 'headless')
    assert.equal(schema.$defs?.peerPlaneUsage?.additionalProperties, false)
    const install = await json('schemas/dsh-install-observation.schema.json') as Schema
    assert.deepEqual(schema.$defs, Object.fromEntries(['peerUsage', 'peerPlaneUsage', 'clientContract'].map(key => [key, install.$defs![key]])))
  })
})
