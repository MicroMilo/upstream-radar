const SAFE_NPM_DIST_TAG = /^[a-z][a-z0-9._-]{0,127}$/

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function validateTag(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty lowercase npm dist-tag`)
  }
  if (!SAFE_NPM_DIST_TAG.test(value)) throw new Error(`${label} must be a lowercase npm dist-tag`)
  return value
}

/**
 * Select the npm stream that a maintainer intends users to consume.
 *
 * An explicit observer setting is policy and therefore wins. Otherwise the
 * current source manifest may declare its publishing stream. Falling back to
 * `latest` is safe only when neither source provides a tag; malformed source
 * metadata remains incomplete evidence instead of silently selecting a
 * different artifact.
 */
export function resolveNpmReleaseTag(manifest: unknown, explicitTag?: string): string {
  if (explicitTag !== undefined) return validateTag(explicitTag, 'configured npm release tag')
  const source = record(manifest)
  if (source === undefined) throw new Error('npm package manifest must be an object')
  if (source.publishConfig === undefined) return 'latest'
  const publishConfig = record(source.publishConfig)
  if (publishConfig === undefined) throw new Error('package.json publishConfig must be an object')
  if (publishConfig.tag === undefined) return 'latest'
  return validateTag(publishConfig.tag, 'package.json publishConfig.tag')
}
