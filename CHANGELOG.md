# Changelog

All notable changes to Upstream Radar are documented here.

## [Unreleased]

## [0.43.0] - 2026-08-24

### Agent-driven headless closure

- Let the configured DSH Agent read bounded repository instructions plus the
  latest isolated result and choose either a constrained headless retry or an
  explicit stop. There is no static environment-planning fallback.
- Add a fast `headless-agent` GitHub Actions mode that reuses current exact
  observations instead of waiting for the full upstream refresh before every
  follow-up.
- Bind every Agent plan to the exact plugin artifact digest, DSH version and
  Node runtime. The model key stays in the planning job; the target package
  executes later in a separate secret-free disposable runner.
- Translate an Agent-approved root package to pnpm's exact local-tarball build
  key, and accumulate approvals across staged lifecycle gates instead of
  replacing the previous set and oscillating.
- Complete the first live loop over the 29 catalog review cells: the Agent
  selected nine bounded retries, seven became compatible, and two stopped at a
  Web-client dependency boundary. The maintained fleet now records 74
  compatible, 22 review-only, zero reproduced-incompatible and four
  source-only catalog entries.

## [0.42.0] - 2026-08-23

### 100-plugin maintained fleet

- Expand the immutable `awesome-dsh-plugin` cohort from 50 to 100 repositories
  across all 21 catalog categories, with 96 exact npm artifacts and four
  explicitly source-only targets.
- Add a reproducible, bounded importer that aligns each new catalog URL with
  its source manifest, npm identity, repository metadata, DSH contract, and
  maintained Node runtime before it may enter the fleet.
- Complete a clean 100-cell contract refresh in disposable GitHub-hosted
  runners: 67 catalog plugins are observed compatible, 29 retain review-only
  evidence, zero are reproduced incompatible, and the four source-only
  entries remain explicit.

### Compatibility evidence accuracy

- Distinguish pnpm build approval from an install failure when the ignored
  build list names the exact reviewed plugin tarball through a `file:`
  coordinate, while continuing to reject arbitrary local coordinates.
- Boot the actual composed DSH profile instead of importing a bundle's package
  root. Bundle patches may legitimately load subpaths or command adapters and
  do not declare a root ESM-export contract.
- Raise only the bounded aggregate artifact expansion allowance to 192 MiB,
  retaining the 64 MiB compressed and per-file limits, so large published DSH
  bundles can be reviewed without weakening the archive boundary.
- Version the corrected execution contract as `dsh-install/v1alpha2`, forcing
  old and new evidence to be retested instead of mixed; the five provisional
  red cells from the first run were reclassified or cleared and their managed
  incidents closed automatically.

## [0.41.0] - 2026-08-23

### Closed-loop compatibility incidents

- Evaluate npm's bare `*` peer range as an explicit match instead of an
  indeterminate contract, preventing resolved wildcard peers from creating a
  daily observer failure.
- Reconcile actionable isolated DSH incompatibilities into one managed GitHub
  issue per stable target/runtime cell. Persistent failures update the same
  issue, regressions reopen it, and a compatible retest comments and closes it.
- Treat reproduced incompatibility as a successful observer result while still
  failing missing, malformed, rejected, or `unknown` evidence. Scanner failure
  therefore cannot be presented as a plugin defect.
- Keep issue delivery and compatibility-ledger persistence in one retryable
  scheduled transaction, and classify a fixed replacement artifact as a
  resolved incompatibility before generic artifact drift.
- Add the published `@sanqi-normal/dsh-webui-market-plugin@0.5.5` repair to the
  maintained dynamic matrix, bringing the corpus to ten public plugins.

### DSH contract evidence

- Materialize the exact plugin-to-DSH-host compatibility frontier into
  `compatibility-ir.json` and a host-package reverse index after every accepted
  isolated observation.
- Resolve every non-optional plugin peer from the real DSH profile before the
  direct plugin import and headless boot. A missing or out-of-range host peer
  is no longer hidden by a successful install/load stage.
- Preserve bounded static evidence beside each peer relation: runtime literal
  import observed, type-only reference observed, no literal reference observed,
  or scan incomplete. This keeps a declaration drift distinct from an already
  reproduced runtime crash.
- Maintain the OpenPencil cell on Node 24, matching its published Node engine,
  and add a reproducible current-DSH contract-drift case.

### Continuously reconciled DSH compatibility

- Replace the change-only install plan with a compatibility ledger. The daily
  static lane now forms the current plugin × DSH × Node/runtime-policy matrix
  and selects only cells that are missing, stale, or invalidated by static
  evidence or execution-contract drift.
- Treat a new DSH/plugin publication as an immediate retest signal, rather than
  the only way a dynamic compatibility check can run. Existing evidence is
  revalidated after a reviewed seven-day window.
- Bind every dynamic report to a scheduled case id, exact plugin coordinate,
  DSH release, Node major, and approved dependency-build list before accepting
  it into durable state. Missing or malformed reports remain unsatisfied.

### Static + dynamic evidence

- Record the bounded SHA-256 and dependency-graph digest of the DSH profile
  lockfile produced by the real isolated install, including DSH's pnpm virtual
  store layout. A green install/load does not satisfy a compatibility cell
  until that graph is complete; missing or unresolved graph evidence stays
  actionable.
- Build a second, effective runtime graph from the installed plugin profile and
  DSH's shared host dependency plane. This resolves normal DSH-provided peers
  without hiding genuine missing edges, and makes the effective graph—not the
  profile lockfile alone—the compatibility-coverage criterion.
- Surface `resolution-drift` when the same exact plugin/DSH/runtime contract
  resolves to a different profile dependency graph on a later clean install.
- Add configured Node runtime profiles. A static Node-engine mismatch prevents
  plugin execution on the wrong runtime and automatically schedules a
  potentially matching alternative profile once, avoiding a false global
  incompatibility claim.
- Add a final Actions reconciliation job that collects per-VM reports, updates
  `compatibility-ledger.json`, and writes only new/changed compatibility facts.

## [0.40.0] - 2026-08-21

### Awesome DSH cohort

- Import a commit-pinned, eight-repository cohort from `awesome-dsh-plugin`,
  monitor all eight source/lockfile streams, and add the six independently
  matched npm artifacts to the isolated DSH compatibility matrix.
- Support explicit GitHub-only observer targets so repository-installed plugins
  are never silently mapped to an unrelated same-name npm package.

### Isolated compatibility contracts

- Stop isolated DSH plugin observations before code execution when the exact npm
  artifact's declared Node range excludes the runner, and report the pair as
  `runtime-incompatible` instead of a false compatibility success.
- Record each artifact's Node requirement in JSON, text output, and GitHub Job
  Summaries.
- Approve only `node-pty` for the maintained Better Sidebar install case, matching
  the plugin's documented native dependency instead of allowing all builds.
- Include the standard Node-gyp Python/C++ toolchain in the disposable observer
  image so an explicitly approved native build is not confused with a plugin
  compatibility failure.

### Live validation

- Test nine exact public plugin artifacts against DSH `0.1.1-rc.1` in separate
  disposable GitHub-hosted VMs: eight satisfy their recorded install contracts,
  while OpenPencil is correctly stopped before execution because its Node
  `>=24.11.0` contract excludes the Node 22 runner.
- Prove the steady-state always-on path across 13 targets: no upstream changes,
  no Agent invocation, no install matrix, and no timestamp-only state commit.

## [0.39.0] - 2026-08-21

### Isolated DSH install and load observation

- Add an explicit `probe dsh-install` lane that binds one exact npm tarball to one exact DSH release, then records install and load process, network, file-write, registration, and filesystem evidence.
- Require explicit execution consent and an externally declared disposable Linux boundary; keep ordinary graph, artifact, and observer collection non-executing.
- Add a secret-free reusable GitHub Actions workflow using a fresh hosted VM and restricted container for each plugin, with bounded JSON evidence and honest trace-coverage states.
- Record the exact Node/pnpm runtime and explicit dependency-build allowlist, preserve the report before failing a non-compatible check, and install the authenticated local tarball rather than resolving its filename from the registry.
- Observe the official `@deepseek-ai/dsh` coordinate and fan out a maintained three-plugin matrix only when DSH or a mapped plugin's exact published coordinate changes, using each mapped plugin's latest observed exact package.
- Follow DSH's explicit npm `next` channel, persist the selected dist-tag, and keep no-change observation state byte-stable so persistent source/publish drift cannot wake the Agent or create timestamp-only cron commits.
- Add the dynamic result schema, tested plan builder, public execution-boundary documentation, and a Firecracker migration boundary for future adversarial tamper resistance.

## [0.38.0] - 2026-08-21

### Always-on known finding watch

- Add a focused watch for seven real DSH plugin supply-chain findings, checking source and the exact npm artifact separately.
- Persist trusted observations and classify findings as added, resolved, changed, persisting, or unknown without treating network failures as fixes.
- Add a daily GitHub Actions workflow, machine-readable report, author-facing Markdown report, bounded retries, and proxy-aware npm checks.

## [0.37.0] - 2026-08-19

### Real DSH dependency corpus

- Scan the first 50 public DSH plugin repositories without installing or executing them.
- Review same-name, same-version npm artifacts when published and preserve missing graphs as explicit evidence gaps.
- Check in the resulting 37-plugin, 1,025-coordinate reverse dependency index and use it in the always-on observer workflows.
- Make the observer showcase route a real `@deepseek-ai/cordis` update to 17 downstream DSH plugins.

## [0.36.0] - 2026-08-18

### Downstream impact routing

- Add a persisted reverse dependency index schema and parser.
- Match upstream package-name version changes to downstream DSH plugins even before they upgrade.
- Route exact downstream paths and incomplete-coverage status into always-on observer reports and DSH tasks.
- Add `observe --reverse-index` and a network-free downstream-impact showcase.

## [0.35.0] - 2026-08-18

### Supply-chain alignment

- Add a versioned upstream/downstream IR that compares the Git source package,
  observed npm package, lockfile graph root, and dependency coverage.
- Surface source/published identity mismatches and incomplete graphs in the
  first observer baseline with concrete author repair steps.
- Persist the alignment IR in `observations.json` and validate it before reuse;
  legacy observation points are upgraded without manufacturing Agent tasks.

## [0.34.0] - 2026-08-18

### Usability

- Add `graph reverse` to build a deterministic dependency-to-affected-plugin
  index from saved scan, exact-review, or Radar config JSON, preserving exact
  paths, edge kinds, source observations, and incomplete coverage.
- Make the OpenAI-compatible DSH Agent path tolerate common GLM JSON shape
  differences while keeping the eight-field conclusion contract validated.
- Make exact DSH plugin reviews explain incomplete dependency coverage directly:
  resolved package count, unresolved edges, registry signature/provenance state,
  and the next author action now appear in the CLI and GitHub Job Summary.
- Let `observe` run the exact published artifact through a configured DSH release
  matrix on the same meaningful upstream change, then keep that result beside
  the dependency review and pending task.

## [0.33.12] - 2026-08-18

### Usability

- Keep a bounded summary of every pending upstream task in JSON and Markdown reports, including the source and published versions, commit range, changed runtime files, dependency edges, and the exact `--retry-pending` next step.
- Surface source-versus-published npm version drift as an author-facing review reason instead of hiding it inside a generic runtime change.

## [0.33.11] - 2026-08-18

### Diagnostics

- Report every known OpenAI-compatible endpoint attempted when an observer model call receives HTTP 404, so a misconfigured DSH/issue-locator endpoint can be corrected from the report instead of appearing as an opaque model failure.

## [0.33.10] - 2026-08-18

### Adoption

- Add a copy-paste GitHub Actions workflow for observing one public repository with the published npm CLI, without checking out or building Radar; it persists the observation point and only runs optional model analysis when all configured secrets are present.

## [0.33.9] - 2026-08-18

### Usability

- Auto-discover a committed `pnpm-lock.yaml` or `package-lock.json` when `observe` receives a GitHub repository URL without explicit lockfile options, so the one-command path includes the real dependency graph.

## [0.33.8] - 2026-08-18

### Usability

- Let `observe` accept one public GitHub repository URL directly, with optional package path and committed npm/pnpm lockfile arguments, so a first upstream baseline does not require writing YAML.
- Retry pending upstream-change tasks in the scheduled observer workflow when a model or Agent was temporarily unavailable.

## [0.33.7] - 2026-08-18

### Usability

- Make `scan` reconstruct the unique committed npm or pnpm lockfile graph, show direct edges and unresolved paths in text output, and explain when the graph cannot be established without guessing.

## [0.33.6] - 2026-08-18

### Usability

- When a public GitHub repository has no root `package.json`, find one unique DSH plugin directory up to three levels deep and scan it without asking the user to clone or guess the subdirectory.

## [0.33.5] - 2026-08-18

### Usability

- Let `scan` accept a public GitHub repository URL, shallow-clone it into a temporary directory, and print the same concrete static findings without installing or running the plugin.

## [0.33.4] - 2026-08-18

### Usability

- Show each finding's concrete remediation in the normal terminal scan report, so authors can move from a detected issue to the repair without switching to JSON.

## [0.33.3] - 2026-08-18

### Reliability

- Retry one transient GitHub, raw-file, or npm registry request failure so a single upstream timeout does not hide a real DSH plugin change; permanent errors remain visible.

## [0.33.2] - 2026-08-18

### Usability

- Accept the natural `package@exact-version` form in `inspect` alongside the explicit `npm:` form, while keeping one canonical report identity.

## [0.33.1] - 2026-08-18

### Fixed

- Preserve the concrete npm resolver stderr in dependency-audit findings, so a DSH plugin report names the missing package instead of only saying that resolution failed.

### Usability

- Add a copyable real DSH plugin finding to the English and Chinese first-run paths, with an explicit no-LLM boundary and author report.
- Record the public DSH profile case with `model: not-configured` when no model is available, so deterministic evidence is not mistaken for a successful LLM analysis.

## [Unreleased]

### Added

- Add `observe --llm-env-file` as an explicit OpenAI-compatible issue-locator model entry point for installations that do not yet have a DSH Agent wrapper; model failures leave deterministic upstream tasks pending for retry.
- Make the scheduled upstream-observer workflow optionally forward issue-locator model secrets without making static observation depend on an LLM configuration.
- Show the concrete unresolved dependency edges behind an incomplete npm artifact review, and accept common `MODEL`/`CODEX_MODEL` env names for observer model calls.
- Retry the alternate ModelBest OpenAI-compatible path when the configured `/llm/v1` path returns 404.
- Allow `profile-check --summary` to auto-select the only DSH profile with third-party bundles, while keeping explicit selection for ambiguous installations.
- Add a concise `profile-check --summary` result and a reproducible DSH web-ui case showcase that turns static findings into an author-facing repair story; optional `issue-locator` model output never changes the deterministic result.
- Correct GitHub Advisory Database matching so an exact version at or above `first_patched_version` is no longer reported as affected; add a regression test for open-ended vulnerable ranges.
- Add per-incident follow-up records with owner, status, and handoff notes bound to the exact event version; show a copyable `triage` command in `radar next` without resolving or suppressing the active evidence.
- Add optional follow-up deadlines and mark overdue work in `radar status` and `radar next` without changing the underlying incident or delivery policy.
- Add project-specific HTTPS/Feishu webhook routes through environment-variable names, with project filtering, independent endpoint outboxes, conflict checks, and a global broadcast-compatible fallback.
- Make `radar next` show a verified DSH conclusion's urgency, recommendation, and bounded evidence inline, so the first action does not require opening a second report.
- Add bounded per-incident `mute`/`unmute` controls for DSH and webhook delivery, keep muted incidents visible in `radar status`/`radar next`, preserve mutes across polling, and automatically resume delivery when the exact event version expires or changes.
- Add an independent GitHub Advisory Database source for exact npm versions, merge OSV/GHSA/CVE duplicates into one durable incident, retain confirmed findings during a source outage, and expose per-source health through CLI and DSH.
- Add a network-free `showcase:github-advisories` proving two-source deduplication, three-failure source-health escalation, and recovery without a false vulnerability resolution; run it in CI and publish preflight.
- Retry one bounded transient GitHub Advisory transport, rate-limit, or 5xx failure so a single network hiccup does not block the first real DSH check; permanent responses remain visible errors.
- Preserve advisory source provenance through Radar state, merged incidents, terminal output, and webhook payloads, so OSV-only and OSV/GitHub cross-confirmed findings are visibly distinguishable.
- Surface severity and fixed-version disagreements between OSV and GitHub Advisory Database as explicit source conflicts, and keep the previous incident identity and evidence during a partial source outage.
- Make the network-free `demo` show the same cross-source provenance and fixed-version conflict that a real Radar event exposes, so the first run demonstrates the DSH-specific value without contacting upstream feeds.
- Add a read-only `quickstart` CLI that detects an existing Radar config, a single supported lockfile, or eligible DSH profiles, then prints one honest copy/paste path with explicit side-effect labels; ambiguous profiles and lockfiles remain user decisions.
- Coalesce the same shared DSH host-runtime vulnerability across all affected plugins in one project-level event, while retaining every plugin root and bounded exact path; migrate legacy per-plugin host keys without a fake resolve/new alert pair.
- Show the complete affected plugin scope for shared-host events in GitHub Job Summaries, and run the host-alert deduplication showcase in CI and the publish preflight.
- Walk the exact DSH executable package through a synthetic `host-runtime` boundary and its reachable host dependency closure, so advisories in DSH core's own transitive packages keep an exact path and source attribution instead of disappearing outside the plugin graph.
- Keep installed-package graph collection tolerant of non-semantic empty/non-string `main` and `type` metadata found in real DSH host packages without weakening the strict parser used for Radar configuration and release metadata.
- Record the exact `@deepseek-ai/dsh` executable package that owns the shared host plane, monitor its OSV vulnerabilities and npm releases, and render a DSH-core finding as an explicit host-runtime boundary rather than a fabricated plugin dependency edge.
- Keep a bounded, deduplicated transition ledger in the Radar state and expose it through the network-free `radar history` command, so resolved incidents and source recovery remain auditable.
- Write a concise escaped GitHub Job Summary from the reusable Action, including the exact path, published fix versions, and a suggested next step while preserving the raw JSON report and the original policy/source exit code.
- Send changed-event text directly to Feishu/Lark V2 custom bots, with optional signature generation from an environment-only secret; keep the existing provider-neutral webhook envelope for other endpoints.
- Extend the network-free `doctor` check to validate the environment webhook route before the first poll, reject retired Feishu/Lark V1 URLs, and warn about unused signing secrets without printing them.
- Make the primary DSH quickstart omit `--profile` when the machine has exactly one eligible profile; keep the explicit flag for multi-profile installations.
- Re-open a project-specific DSH analysis task when an existing advisory later gains its first fixed version, preserving the updated dependency evidence.
- Document the npm-native `npx` launcher alongside the pnpm quickstart, while recommending exact versions for reproducible team use.
- Add a packaged `upstream-radar demo` command that shows the exact-path-to-DSH handoff without network access, a DSH profile, or plugin installation.
- Add a repeatable real-plugin DSH adoption showcase that packs the packages with lifecycle scripts disabled, then validates setup, doctor, frozen upstream checks, and status in a disposable DSH profile.
- Add command-specific `--help` for setup, inspection, lockfile, DSH, radar, task, and analysis paths, plus concrete next-step guidance in text admission reports.
- Make a missing DSH executable during `setup` explain the exact prerequisite and recovery command instead of exposing a raw process-spawn error.
- Explain how to prepare a profile when `setup` finds DSH but no third-party plugin to monitor.
- Add a post-publish npm artifact smoke that installs the exact public tarball with scripts disabled and runs the packaged CLI demo.
- Add an opt-in GitHub Action pre-install artifact gate for one exact npm plugin, with an admission verdict, coverage, findings, next step, and `inspect-verdict` output.
- Add delivery-only per-project notification controls for minimum vulnerability severity and timezone-aware quiet hours; critical and malicious-package events bypass the controls, while DSH tasks and webhook events remain durable for retry.
- Let `setup` and all `init` modes configure those notification controls directly, with validation for severity values, IANA timezones, and quiet-hour ranges; generated configs no longer require hand-editing JSON for the common path.
- Add opt-in `setup --start` to launch the selected DSH profile only after the generated wiring passes the local doctor check; the default remains review-first and does not start DSH.
- Add an explicit next-action line to CLI vulnerability, compatibility, and source-health events so the first check tells the user what to do next; keep the doctor gate distinct from human review and safety admission.
- Make the repository's consumer smoke use the current local CLI by default, with an explicit `try:consumer:published` path for checking the public npm artifact before a release announcement.
- Add a structured DSH trial feedback form and place a redacted-result link in the English and Chinese README first-run paths.
- Document the real `create-dsh-plugin` to pnpm lockfile graph and GitHub Action path, so DSH plugin authors can review dependencies before installation and keep the same gate in CI.
- Order the read-only `radar status` Attention list by CISA KEV, EPSS, and advisory severity, and show the evidence used for each vulnerability's position.
- Reuse the same short priority evidence in DSH event text, Feishu/HTTPS webhook summaries, and GitHub Action Job Summaries.
- Add a read-only `radar next` handoff that selects the first status incident and points to its queued DSH task, verified analysis, or next check command.

## [0.33.0] - 2026-08-16

### Added

- Add CISA KEV and FIRST EPSS prioritization signals to native DSH monitoring, with explicit CLI and GitHub Action opt-in, source-health tracking, durable state validation, and an offline showcase.
- Compare active vulnerability ids and aliases with complete candidate dependency graphs, report `removed`/`still-affected`/`unknown` evidence, and identify the first non-blocked top-level plugin candidate that removes all checked paths without calling it safe.
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
