# Changelog

All notable changes to Upstream Radar are documented here.

## [0.4.1] - 2026-08-15

### Changed

- Reworked the English and Chinese README opening around one concrete DSH incident, the deterministic/model boundary, and a direct npm install path.
- Changed installation examples to track the npm `latest` release instead of a hard-coded package version.

### Security

- Added npm trusted publishing through a single GitHub Actions workflow with short-lived OIDC authentication and automatic provenance.
- The release workflow checks the tag/package version contract, tests the package, runs the real DSH headless proof, and packs the artifact before publishing.

## [0.4.0] - 2026-08-14

### Added

- Native DeepSeek Harness bundle installation through `dsh plugin add`.
- Always-on OSV and npm release polling with durable `new`, `updated`, and `resolved` incidents.
- Exact physical dependency paths that preserve duplicate installed versions.
- DSH/Cordis, Node.js, entrypoint, export-map, bundle, dependency, and version-boundary compatibility signals.
- Plugin-originated DSH Agent follow-ups with durable offline retry.
- A real DSH headless integration proof and a live OSV/npm mode.
- English and Simplified Chinese launch documentation.

### Safety

- Advisory and release text remains explicitly untrusted model input.
- Version matching and compatibility facts are calculated outside the model.
- Agent analysis is read-only and requires project evidence and explicit uncertainty.

[0.4.1]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.4.1
[0.4.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.4.0
