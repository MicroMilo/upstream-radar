# Changelog

All notable changes to Upstream Radar are documented here.

## [Unreleased]

## [0.33.0] - 2026-08-16

### Added

- Add an optional provider-neutral HTTPS webhook for changed vulnerability, compatibility, malware, and source-health events from both the native DSH adapter and CLI `radar check/watch`.
- Deduplicate webhook event ids per endpoint, persist only the endpoint fingerprint, and retry failed deliveries on a later cycle.
- Add a read-only `graph pnpm-lock` CLI command for pnpm v6/v9 lockfile dependency graphs, including project-root importers and explicit ambiguous peer references.
- Add `init --pnpm-lock` to turn a lockfile graph into a static Radar config that can run the normal OSV check before DSH installation; it infers the root from an adjacent `package.json` and accepts `--root` as an explicit override.
- Add the matching `graph npm-lock` and `init --npm-lock` path, including npm project roots from `package-lock.json` `packages[""]`.
- Let the reusable GitHub Action optionally build that config from `pnpm-lock` or `npm-lock`, with an optional `root` override, while preserving the reviewed-config mode by default.
- Treat an npm registry `404` for an unpublished plugin as a skipped release comparison rather than blocking its exact dependency vulnerability check; other registry and OSV failures remain visible errors.

### Validation

- Add a real DSH host-runtime showcase that refreshes a plugin's graph from the running process, matches a deterministic local OSV advisory against `@deepseek-ai/cordis`, and proves `dsh-host` event persistence plus Agent writeback.
- Run the host-runtime proof in CI and the npm publish preflight, with a checked-in JSON result and one-command documentation.

### Usability

- Make `setup` generate `upstream-radar.dsh.yml` by default, so the first DSH run does not require users to understand environment-variable wiring.

## [0.32.0] - 2026-08-16

### Added

- Discover the exact DSH runtime dependency plane from the running CLI entrypoint using bounded, read-only manifest checks.
- Include packages resolved from that process plane in refreshed plugin graphs as `dsh-host` nodes and query their exact versions for upstream vulnerabilities.
- Show whether the captured DSH host plane came from the running process or the profile fallback in `radar status`.

### Safety

- Runtime discovery never imports DSH, loads plugin code, or runs lifecycle scripts; it only verifies the exact `@deepseek-ai/dsh` manifest and reads package manifests through the existing graph collector.

### Validation

- Add discovery, explicit host-plane refresh, graph provenance, status, and full real-DSH showcase coverage.

## [0.31.0] - 2026-08-16

### Changed

- Preserve npm `peerDependenciesMeta.optional` in installed and candidate dependency graphs so an absent optional peer does not create a false required coverage gap.
- Make `radar status` and `doctor` identify missing `@deepseek-ai/dsh-*` and Cordis peers as unobserved DSH host dependencies when the profile does not expose an exact host version.
- Keep incomplete host coverage explicit: Radar does not invent a DSH runtime version or query a package it was never shown.

### Validation

- Add installed-graph, npm-lock, inventory, and status tests for optional peers and unobserved DSH host peers.
- Re-run the real `dsh-cloudflare-browser-run@0.1.1` profile showcase; the result reports 8 unobserved DSH host dependencies and 2 optional absent peers.

## [0.30.0] - 2026-08-16

### Added

- Add an explicit `upstream-radar setup` command that installs the exact running Radar version through DSH, generates the reviewable inventory and overlay, and runs the network-free wiring check.
- Add `--no-install` for profiles that already contain the Radar bundle.
- Shorten the DSH quickstart and document the safe boundary: setup does not start DSH or execute plugin business actions.

### Validation

- Add a CLI integration test covering exact DSH installation arguments, generated files, and the doctor result.

## [0.29.0] - 2026-08-16

### Added

- Bind each DSH analysis delivery to its exact task, message, session, and upstream event.
- Accept model conclusions only from the matching DSH `assistant/message` with the strict six-field JSON result contract.
- Persist verified analysis results, expose them through `radar status` and `analysis list/show`, and remove stale conclusions when an incident changes or resolves.
- Extend the real DSH headless showcase to prove result writeback, not only task delivery.

### Safety

- Ordinary chat, forged plugin markers, malformed JSON, other sessions, and stale event responses cannot become Radar conclusions.
- Model conclusions remain advisory and never rewrite deterministic vulnerability or compatibility state.

## [0.28.0] - 2026-08-16

### Added

- Route pending DSH analysis notices to the root Agent whose session workspace exactly matches the Radar project workspace.
- Keep tasks queued when multiple DSH roots exist but no trustworthy workspace match is available.
- Preserve single-root delivery for existing installations and continue delivery for unrelated projects when one route fails.
- Add routing tests and document the multi-project behavior in the English and Chinese guides.

### Safety

- The adapter never guesses between multiple project sessions; an ambiguous route is visible as a durable pending task and a DSH warning.

## [0.27.0] - 2026-08-16

### Added

- Extend the reusable GitHub Action with an opt-in `probe-package`, `probe-dsh-versions`, and `probe-timeout` load-matrix step.
- Pack the exact npm release with lifecycle scripts disabled, run the published DSH matrix, expose `probe-result`, and preserve the matrix exit code.
- Add copyable English/Chinese workflow guidance using the real `dsh-cloudflare-browser-run@0.1.1` package.

### Safety

- The Action accepts only exact `name@version` package specs and never runs npm lifecycle scripts.
- The optional step remains load-only compatibility evidence; it is not a security sandbox, a capability benchmark, or an automatic upgrade decision.

## [0.26.0] - 2026-08-16

### Added

- Add `probe dsh-matrix` for testing one exact plugin tarball against two to eight exact DSH versions in isolated profiles.
- Aggregate per-version load results conservatively: any `incompatible` blocks the matrix, and any `unknown` prevents a green result.
- Add a real `0.1.0-rc.3` plus `0.1.0-rc.6` matrix showcase and run it in CI and the publish workflow.

### Safety

- Matrix runs are sequential and bounded; every version gets its own temporary `DSH_HOME` and the same artifact digest.
- The matrix remains load-only evidence. It does not execute plugin business actions, benchmark capabilities, or prove package/dependency safety.

## [0.25.0] - 2026-08-16

### Added

- Add `probe dsh-load <package.tgz>` to load a reviewed DSH bundle in a disposable `headless` profile against one exact DSH version.
- Return explicit `compatible`, `incompatible`, or `unknown` results with artifact, registration, and profile-load stages.
- Refuse lifecycle scripts during probe preflight and keep the probe limited to bundle loading; it does not run plugin business actions or prove package safety.
- Add a deterministic three-case DSH load-probe showcase covering a loadable bundle, a rejected bundle patch, and an artifact that remains unknown because it declares `postinstall`.

### Safety

- The probe uses a temporary `DSH_HOME`, disables telemetry and install scripts, and removes the profile unless `--keep-profile` is requested.
- A successful load is compatibility evidence for the selected DSH version only, not a security admission or capability benchmark.

## [0.24.0] - 2026-08-16

### Added

- Add `benchmark compatibility` for an offline, no-network regression check of deterministic compatibility signals and the `breaking`/`any` CI gates.
- Cover safe patches, analysis-only changes, DSH peer incompatibility, publisher-declared breaking changes, candidate dependency vulnerabilities, and incomplete graphs.

### Safety

- The benchmark does not install packages, load plugins, start DSH, or claim runtime compatibility; it checks the rule contract only.

## [0.23.0] - 2026-08-16

### Added

- Add `--fail-on-compatibility <never|breaking|any>` to the Radar CLI and a matching `fail-on-compatibility` input to the reusable GitHub Action.
- Let `breaking` fail only when a compatibility event contains a confirmed or strong incompatibility signal; let `any` fail on every active compatibility event that needs analysis.

### Safety

- The compatibility gate defaults to `never`, so existing vulnerability-only CI behavior is unchanged until a project opts in.
- The gate changes only the exit code and report; it does not install candidates, execute plugin code, or infer that a candidate is safe.

## [0.22.1] - 2026-08-16

### Fixed

- Quote the Action's `:memory:` input description so GitHub's workflow runner accepts the manifest as valid YAML.

### Added

- Add a real DSH plugin consumer smoke with a copyable config, workflow, local command, and scheduled dogfood workflow for the published GitHub Action.

## [0.22.0] - 2026-08-16

### Added

- Publish a reusable GitHub composite Action for the reviewed, frozen Radar CI gate.
- Allow repositories to configure the graph path, failure threshold, state path, exact Radar version, Node.js version, and working directory without copying the runner setup.

### Safety

- The Action pins its setup dependencies to exact commit SHAs and passes user inputs through environment variables before invoking the CLI.
- The Action requires the caller to check out the repository and only runs `radar check --frozen`; it does not start DSH, execute plugin code, modify dependencies, or create a branch.

## [0.21.0] - 2026-08-16

### Changed

- Make `init` record `project.workspace` as `.` by default, so the generated dependency inventory can be reviewed and committed without embedding the creator's absolute home path.
- Remove the unnecessary `$PWD` argument from the first-use commands; pass `--workspace <absolute-path>` only when DSH is launched outside the project root.

### Safety

- The portable default changes only the project path presented to the DSH Agent; it does not change the exact installed dependency graph or its source evidence.

## [0.20.0] - 2026-08-16

### Added

- Add `radar check/status/watch --fail-on <severity>` for a machine-enforced active-vulnerability threshold; malware is treated as critical.
- Add `radar check/watch --frozen` so CI can use a reviewed config graph without requiring a local DSH profile.
- Add a copyable GitHub Actions workflow using a memory-only state file and an explicit high-severity gate.

### Safety

- `--frozen` does not claim the checked-in graph is current; it makes the graph source explicit and still queries the configured upstream sources.
- `--fail-on` changes only the exit code and report policy; it never upgrades packages, runs plugin code, or creates a branch.

## [0.19.4] - 2026-08-16

### Added

- Add bounded active-incident summaries to `radar status`, including the exact first vulnerable path or candidate signal and a suggested next step.
- Point users with pending DSH tasks to the local `task show` command.

### Safety

- Status summaries are derived only from durable local state; they do not poll upstream sources or make upgrade/safety decisions.
- Large state files are truncated to a bounded summary and report the number of omitted incidents.

## [0.19.3] - 2026-08-16

### Fixed

- Make the first-run README commands explicit about the DSH profile and separate the long-running DSH process from the read-only status check.
- Make `init` print a version-pinned `doctor` command before the DSH start command, so the next local verification step is visible immediately.

## [0.19.2] - 2026-08-16

### Added

- Add a network-free `upstream-radar doctor` command for first-run DSH diagnosis.
- Check local config parsing, DSH profile bundle registration, generated overlay alignment, state-file readability, monitoring status, and required dependency coverage.
- Support human-readable and `--json` doctor output; only blocked wiring returns a non-zero exit code.

### Safety

- Doctor never contacts OSV, npm, or GitHub and never imports or executes plugin code.
- A missing first-run state or incomplete coverage remains visible as a warning; neither is described as safe.

## [0.19.1] - 2026-08-16

### Fixed

- Carry the registry selected by `init --registry` into the generated DSH overlay so runtime release and candidate dependency checks use the same registry.
- Expose registry and candidate-graph controls through the legacy environment-variable patch as well.

## [0.19.0] - 2026-08-16

### Added

- Resolve the earliest bounded prefix of newer npm candidates with `npm install --package-lock-only --ignore-scripts` in a temporary directory.
- Query every resolved node in those candidate graphs against OSV and retain the vulnerable transitive path in the compatibility event.
- Distinguish complete, partial, incomplete, and unavailable candidate dependency coverage; do not recommend a candidate when its checked graph is incomplete or unavailable.
- Run the bounded candidate graph check by default in the native DSH adapter and CLI Radar loop, with `--no-deep-candidates` and `deepCandidates: false` escape hatches.

### Safety

- Candidate graph resolution never imports candidate code or runs lifecycle scripts; it only resolves registry metadata into a temporary lockfile.
- A failed or incomplete graph is uncertainty, not a clean result. DSH is instructed to treat transitive coverage gaps as unknown.
- Candidate graph failures have their own `npm-candidate-graphs` source-health record, while OSV failures still preserve confirmed state.

## [0.18.0] - 2026-08-16

### Added

- Query every exact intermediate upgrade candidate against OSV before selecting a first candidate.
- Mark known-vulnerable candidates as confirmed blockers with their advisory id and fixed versions.
- Withhold the upgrade recommendation when the candidate OSV check is unavailable.

### Safety

- A candidate without an OSV match is not a safety certificate; DSH still performs project-specific analysis.
- The OSV candidate check never installs or executes a candidate package.
- Persisted 0.17.0 upgrade paths remain readable after the new vulnerability-status field is added.

## [0.17.0] - 2026-08-16

### Added

- Read newer exact npm manifests from the existing packument and evaluate them in ascending order.
- Record the first candidate without a confirmed or strong deterministic blocker when the latest release is risky.
- Show blocked intermediate candidates and their reasons in the compatibility event and DSH analysis task.

### Safety

- The first candidate is explicitly not a safety or compatibility certificate; DSH still has to inspect project evidence.
- Candidate ranking remains outside the model and does not install or execute any release.
- Persisted upgrade-path state is bounded and validated before it is accepted.

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

[0.18.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.18.0
[0.17.0]: https://github.com/MicroMilo/upstream-radar/releases/tag/v0.17.0
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
