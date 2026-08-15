# Changelog

All notable changes to Upstream Radar are documented here.

## [0.16.0] - 2026-08-16

### Changed

- Group pending same-project DSH runtime compatibility tasks into one native Agent notice.
- Keep each package's compatibility incident and evidence independent in durable state.
- Add a deterministic showcase for the grouped DSH runtime handoff.

## [0.15.0] - 2026-08-16

### Changed

- CLI `radar check` and `radar watch` now refresh CLI-generated DSH profile inventories before each poll, matching the native DSH adapter.
- Read-only `radar status` and explicit-file `radar compare` remain non-refreshing.
- Ignore npm `latest` tags that point to the installed or an older version instead of creating false breaking-change incidents.

### Safety

- The shared refresh path reads manifests only, never imports or executes plugin code; a failed refresh aborts the cycle before durable state replacement.
- A registry tag rollback does not resolve an existing compatibility incident without evidence that the installed project changed.

## [0.14.0] - 2026-08-16

### Added

- Add profile metadata to CLI-generated inventories and generated DSH overlays.
- Refresh the installed DSH profile graph before each native poll, including later plugin and host-runtime changes.
- Abort a polling cycle when profile refresh fails, preserving the last durable state.

### Safety

- Profile refresh reads package manifests only and never imports or executes plugin code.

## [0.13.0] - 2026-08-16

### Added

- Preserve the physical origin of affected packages in vulnerability events and DSH analysis tasks.
- Render whether an alert comes from the plugin profile, the DSH host runtime, or both.
- Extend the deterministic dependency-graph showcase with origin evidence.

### Fixed

- Avoid losing the profile-versus-host distinction between graph construction and the user-facing alert.

## [0.12.0] - 2026-08-16

### Added

- Include DSH's shared `profiles/node_modules` host-runtime dependency plane in installed profile graphs.
- Mark physical packages as `profile` or `dsh-host` and keep host-runtime counts visible in init and status output.
- Distinguish required unresolved dependencies from optional platform packages that are not installed.

### Fixed

- Avoid reporting DSH's platform-specific optional native packages as required dependency coverage failures.

## [0.11.0] - 2026-08-16

### Added

- Build the default DSH inventory from the profile's installed `node_modules` resolution tree, so duplicate versions, overrides, and local package-manager choices match what DSH can actually load.
- Preserve unresolved dependency declarations as incomplete coverage instead of dropping them from the config.
- Add graph source and coverage details to JSON and `radar status` output.
- Keep explicit `--registry` initialization available for public npm graph comparisons.

### Security

- Refuse DSH bundle manifests and dependency manifests whose symlinks escape the reviewed profile.

## [0.10.0] - 2026-08-16

### Added

- Auto-select the only DSH profile with third-party bundles when `init --profile` is omitted; multiple candidates still require an explicit profile.
- Add read-only `radar status` for first-run diagnosis without refreshing upstream sources.
- Report source health, last completed check, active vulnerability/compatibility incidents, source-health incidents, and pending DSH analysis tasks in human-readable and JSON forms.

## [0.9.0] - 2026-08-16

### Added

- Add `init --dsh-patch` to generate a reviewable, self-contained DSH overlay with explicit config and state paths.
- Keep the existing environment-variable configuration path available for advanced overrides.
- Add release metadata validation so the runtime tool version cannot drift from `package.json`.

## [0.8.0] - 2026-08-16

### Added

- Persist per-source health with last attempt, last success, consecutive failures, and bounded error details.
- Create one durable DSH `source-health` notice after three consecutive source failures and resolve it when the source recovers.
- Add source-health lifecycle evidence to the deterministic showcase.

## [0.7.1] - 2026-08-16

### Fixed

- Preserve confirmed vulnerability matches and pending DSH tasks when OSV is temporarily unavailable instead of aborting the cycle.
- Return visible `osv` source warnings from the CLI and JSON result; one-shot checks now fail closed on source errors.
- Add a source-outage scene to the deterministic showcase.

## [0.7.0] - 2026-08-16

### Added

- Attach bounded public GitHub Release notes to npm candidate compatibility events when the exact version tag is available.
- Keep GitHub release failures independent from the OSV/npm monitoring path and surface them as source warnings.

## [0.6.2] - 2026-08-16

### Fixed

- Use explicit `pnpm dlx --package=upstream-radar@latest upstream-radar` examples so the commands resolve the published package even when run from the Upstream Radar workspace itself.

## [0.6.1] - 2026-08-16

### Fixed

- Make the new CLI examples directly runnable from a fresh setup with `pnpm dlx upstream-radar@latest` instead of assuming a global binary.

## [0.6.0] - 2026-08-16

### Added

- Add `upstream-radar radar watch` with a safe bounded interval and `--once` mode for simple local, CI, and demo runs.
- Document the CLI fallback while keeping native DSH delivery as the recommended always-on path.

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

[0.16.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.16.0
[0.15.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.15.0
[0.14.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.14.0
[0.13.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.13.0
[0.12.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.12.0
[0.11.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.11.0
[0.10.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.10.0
[0.9.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.9.0
[0.8.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.8.0
[0.7.1]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.7.1
[0.7.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.7.0
[0.6.2]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.6.2
[0.6.1]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.6.1
[0.6.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.6.0
[0.5.3]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.3
[0.5.2]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.2
[0.5.1]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.1
[0.5.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.5.0
[0.4.1]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.4.1
[0.4.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.4.0
