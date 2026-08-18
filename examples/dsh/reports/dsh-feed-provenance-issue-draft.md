# Issue draft: publish `dsh-feed` with npm provenance

Suggested title: `Enable npm provenance for the dsh-feed release workflow`

Repository: [863683348/dsh-feed](https://github.com/863683348/dsh-feed)

Observed at commit [`d9f5974`](https://github.com/863683348/dsh-feed/commit/d9f59743c53d8a349f1deb2f18f70117a4014ef7)

## Finding

`.github/workflows/publish.yml` runs `npm publish` at line 30 and authenticates
with `NODE_AUTH_TOKEN` at lines 31–32. The workflow does not declare
`--provenance`, `NPM_CONFIG_PROVENANCE=true`, or GitHub Actions `id-token: write`.

Radar independently reviewed the exact `dsh-feed@0.1.0` artifact:

- artifact SHA-256: `sha256:c806e91f45291fbb4f76403e80f8fe5b85f90351db7faabd0d5e599ffd295332`
- npm integrity: verified
- npm registry signature: verified
- build provenance: missing
- resolved packages: 18
- known vulnerabilities: 0

This is a supply-chain traceability gap, not a claim that the package is
malicious or vulnerable.

## Suggested fix

Choose one supported npm publication path:

```yaml
permissions:
  contents: read
  id-token: write

# Existing publish step
- run: npm publish --provenance
```

Alternatively, use npm trusted publishing with OIDC and remove the long-lived
`NPM_TOKEN` path. After the next release, run
`upstream-radar inspect npm:dsh-feed@<new-version> --deep` and confirm
`provenance: verified`.

Radar result: [batch follow-up](dsh-batch-50-provenance-follow-up-2026-08-18.md).
