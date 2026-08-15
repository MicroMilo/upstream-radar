# Releasing Upstream Radar

Upstream Radar publishes to npm through GitHub Actions trusted publishing. The release workflow uses a short-lived OIDC identity; the repository stores no npm write token. npm automatically attaches provenance to a successful public release.

## One-time npm configuration

The `upstream-radar` package trusts this exact publisher identity:

```text
GitHub owner: MicroMilo
Repository: upstream-radar
Workflow: publish.yml
Allowed action: npm publish
```

The relationship can be inspected or replaced with npm CLI 11.5.1 or newer. Account-level two-factor authentication is required to change it.

## Release contract

1. Update `package.json`, `src/version.ts`, and `CHANGELOG.md` to the same version.
2. Regenerate checked-in showcase reports when their rendered version changes.
3. Merge the release commit into `main` after CI passes.
4. Publish a non-prerelease GitHub Release whose tag is exactly `v<package version>`.
5. Wait for the `Publish npm package` workflow to pass.
6. Verify the npm version, integrity, and provenance before announcing the release.

The workflow refuses a tag/package mismatch. It installs with lifecycle scripts disabled, runs the full test suite and real DSH headless proof, packs the artifact, and only then asks npm for a short-lived publish credential.

## Security properties

- No `NPM_TOKEN` secret is present in GitHub Actions.
- Only `.github/workflows/publish.yml` in `MicroMilo/upstream-radar` is trusted by npm.
- The publish job runs on a GitHub-hosted runner with `id-token: write` scoped to that job.
- A prerelease GitHub Release cannot publish to npm through this workflow.
- npm provenance links the published artifact back to its repository and build workflow; it does not claim that the package is vulnerability-free.
