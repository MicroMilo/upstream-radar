# Issue draft: publish `dsh-inline-images` with npm provenance

Suggested title: `Enable npm provenance before the first dsh-inline-images release`

Repository: [3403473060/dsh-inline-images](https://github.com/3403473060/dsh-inline-images)

Observed at commit [`79f8ba7`](https://github.com/3403473060/dsh-inline-images/commit/79f8ba778441c86738dedba574f5911fd2b5b2be)

## Finding

`.github/workflows/ci.yml` runs `npm publish --access public` at line 45 and
uses `NODE_AUTH_TOKEN` at lines 46–47. The workflow does not declare
`--provenance`, `NPM_CONFIG_PROVENANCE=true`, or GitHub Actions `id-token: write`.

The source package declares version `1.0.0`, but the npm registry currently
returns 404 for `dsh-inline-images@1.0.0`, so this is a release-before-publish
finding. Radar does not describe it as a problem in an artifact that users can
already install.

## Suggested fix

Before the first npm release, either enable provenance on the existing publish
step:

```yaml
permissions:
  contents: read
  id-token: write

- run: npm publish --access public --provenance
```

or configure npm trusted publishing with GitHub OIDC. After publishing, run
`upstream-radar inspect npm:dsh-inline-images@1.0.0 --deep` and confirm
`provenance: verified`.

Radar result: [batch follow-up](dsh-batch-50-provenance-follow-up-2026-08-18.md).
