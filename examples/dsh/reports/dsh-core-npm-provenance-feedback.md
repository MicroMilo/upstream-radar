# Maintainer feedback: publish DSH with npm provenance

Repository: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)

Package reviewed: `@deepseek-ai/dsh@0.1.0-rc.7`

## What Radar observed

The exact npm artifact was reviewed without installing or executing DSH:

- artifact SHA-256: `sha256:2f8f0b763d611ac536f7a9411ee43c0afc067c1b8732c3102c04dbe398bcacc5`
- npm integrity: verified
- npm registry signature: verified
- build provenance: missing
- resolved dependency graph: 568 nodes and 2,085 edges
- npm audit: 0 known vulnerabilities in the resolved graph

This is not evidence that DSH is malicious. It means a consumer can verify the
published bytes and the registry signature, but cannot yet verify which source
commit and GitHub Actions build produced those bytes.

## Why this is actionable

The current DSH release workflow's `publish` job grants `contents: read` only,
and its final step runs `npm publish` without enabling npm provenance. The
release already has a separated pack → publish flow, so provenance can be
added at the publication boundary without changing the packed artifact.

## Smallest patch to review

In `.github/workflows/release.yml`, the `publish` job can opt into the GitHub
OIDC permission and pass npm's provenance setting to the existing publish
command:

```yaml
publish:
  permissions:
    contents: read
    id-token: write
  steps:
    # existing steps remain unchanged
    - name: Publish tarballs
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        NPM_CONFIG_PROVENANCE: 'true'
      run: pnpm run release:publish --family dsh --from dist/npm
```

Before merging, the maintainer should verify npm organization policy and run
the existing packed-install/release checks. After the next release, Radar can
confirm whether the exact artifact reports `provenance: verified` and records
the source repository, ref, commit, and workflow.

## Product result

This is the author-facing output we want from an upstream check:

```text
exact artifact
→ signature and dependency evidence
→ one concrete supply-chain gap
→ smallest maintainer patch
→ verify the next published artifact
```

The finding is based on static artifact and workflow evidence. No DSH Agent or
LLM conclusion is required to produce it.
