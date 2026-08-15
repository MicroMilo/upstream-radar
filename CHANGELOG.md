# Changelog

All notable changes to Upstream Radar are documented here.

## [0.5.3] - 2026-08-15

### Changed

- Make the npm package description lead with dependency security monitoring for DeepSeek Harness (DSH) plugins.
- Add focused npm discovery keywords for DSH, plugin security, dependency monitoring, vulnerability paths, and Agent tooling.

## [0.5.2] - 2026-08-15

### Fixed

- Keep the English `README.md` as the npm landing page; move the Chinese README under `docs/` so npm no longer selects it as the package readme.
- Repair relative links and hero assets in the moved Chinese documentation.

## [0.5.1] - 2026-08-15

### Changed

- Put the DSH quick start before the visual hero so the first screen explains how to run Radar.
- Make `init` print copy-pasteable environment variables and the profile start command, with the recommended state path included in JSON output.
- Sharpen npm and README descriptions around exact vulnerable paths, breaking updates, and DSH Agent follow-up.

## [0.5.0] - 2026-08-15

### Added

- Added `upstream-radar init --profile <name>` to discover third-party bundles from a real DSH profile and generate a reviewable Radar inventory.
- Added a real DSH profile initialization test covering bundle filtering, exact npm artifact inspection, and safe output creation.

### Changed

- Made the DSH first-use path start from the installed profile instead of asking users to hand-write a dependency graph.
- Documented the boundary between the generated public npm artifact graph and profile-specific package-manager overrides.

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
[0.5.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.0
[0.5.1]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.1
[0.5.2]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.2
[0.5.3]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.3
