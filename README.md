<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>Always-on dependency radar for DeepSeek Harness plugins: exact paths, breaking-change signals, and project-aware Agent follow-up.</strong></p>

<p align="center">
  English · <a href="docs/README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm version" src="https://img.shields.io/npm/v/upstream-radar?style=flat-square&color=2563eb"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/MicroMilo/upstream-radar?style=flat-square&color=f59e0b"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/MicroMilo/upstream-radar/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="examples/dsh/README.md"><img alt="Tested with DSH 0.1.0-rc.6" src="https://img.shields.io/badge/tested_with_DSH-0.1.0--rc.6-5b5bd6?style=flat-square"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/MicroMilo/upstream-radar?style=flat-square"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0f766e?style=flat-square"></a>
</p>

<p align="center">
  <a href="#try-it-in-60-seconds">Try it in 60 seconds</a> ·
  <a href="#see-one-incident">See one incident</a> ·
  <a href="#install-in-dsh">Install in DSH</a> ·
  <a href="#run-the-proof">Run the proof</a> ·
  <a href="#run-it-in-github-actions">Run in GitHub Actions</a> ·
  <a href="#how-the-loop-works">How it works</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

## Try it in 60 seconds

Use a DSH profile that already contains at least one third-party bundle. Replace `web` with your profile name. The commands below are split between two terminals because DSH normally stays running:

```bash
# Terminal 1
pnpm dlx --package=upstream-radar@latest upstream-radar setup \
  --profile web \
  --project-name "My DSH project"
dsh --profile web --patch ./upstream-radar.dsh.yml
```

`setup` explicitly installs the exact Radar version used by the command into the selected DSH profile, discovers the installed graph, writes `./upstream-radar.config.json` and `./upstream-radar.dsh.yml` by default, and runs the network-free wiring check. It does not start DSH or execute plugin business actions; review the generated files before starting the process. Use `--output` or `--dsh-patch` for different paths; if Radar is already installed, add `--no-install`.

After DSH is running, use a second terminal for the read-only status check:

```bash
# Terminal 2
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

The setup command writes a reviewable inventory and an explicit DSH overlay. Its local doctor check verifies the wiring before DSH starts; `radar status` confirms the first completed check without another network request. Read the [full DSH setup](#install-in-dsh) for the legacy environment-variable path, profile boundaries, and the real runtime proof.

If you want to try the monitoring loop without booting a DSH profile, run one cycle from a reviewed inventory:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch ./upstream-radar.config.json --once
```

Remove `--once` to keep a local monitor alive. This is a lightweight CLI surface for demos, CI, and diagnosis; the native DSH bundle remains the recommended always-on path because it can deliver the task to a live Agent.

To also notify a team-owned HTTPS endpoint when an incident changes, keep the endpoint outside the reviewed config and state:

```bash
export UPSTREAM_RADAR_WEBHOOK_URL='https://alerts.example.test/upstream-radar?token=replace-me'

# Native DSH path: the bundle reads the variable at runtime.
dsh --profile web --patch ./upstream-radar.dsh.yml

# Or use the CLI path for a persistent one-shot/continuous monitor.
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch \
  ./upstream-radar.config.json --webhook "$UPSTREAM_RADAR_WEBHOOK_URL"
```

The webhook receives only `new`, `updated`, and `resolved` changes (including source-health changes) in the bounded `upstream-radar.webhook/v1alpha1` JSON format described by the [schema](schemas/webhook.schema.json). A successful HTTP 2xx response records the event id; a failed request remains retryable on the next cycle. The state stores only a SHA-256 endpoint fingerprint and delivered ids, never the URL or its token. This is a provider-neutral JSON endpoint; a Feishu or Slack relay can turn its `text` and `events` fields into the provider's native card. Run `pnpm run showcase:webhook` to see deduplication and retry behavior without contacting a real endpoint.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="docs/assets/upstream-radar-hero-mobile.jpg">
    <img src="docs/assets/upstream-radar-hero.jpg" alt="Upstream Radar watches a dependency graph, highlights one affected path, and routes one signal to a DSH Agent." width="100%">
  </picture>
</p>

---

A vulnerability feed stops at “package X is affected.” Upstream Radar keeps going: it identifies the exact installed dependency path, maintains one durable incident, and wakes a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent with the project evidence needed for a useful investigation.

```text
OSV advisory or npm release
  -> exact installed plugin path
  -> new / updated / resolved incident
  -> project-specific DSH Agent analysis task
```

**No matching installed path means no Agent wake-up.** Version matching and compatibility facts are calculated by code; the model handles only repository-specific judgment.

## The missing middle: candidate dependency graphs

An upgrade can look clean at the top level while introducing a vulnerable transitive package. Radar therefore does not stop at `plugin@1.3.0`'s manifest:

```text
candidate plugin@1.1.0
└── logger@4.1.0
    └── parser@2.9.0  ← OSV advisory
```

For the earliest bounded set of newer versions, Radar resolves npm metadata into a temporary `package-lock.json` with lifecycle scripts disabled, queries every resolved node against OSV, and keeps the exact path in the compatibility event. A missing required edge, resolver failure, or OSV failure is shown as incomplete or unavailable; it is never presented as “no vulnerability found”. Later versions are marked as unchecked when the candidate list is larger than the bounded prefix. The result is still a starting point for DSH project analysis, not an upgrade certificate.

## Inspect a pnpm lockfile before installation

If a DSH plugin is managed with pnpm, inspect the exact locked tree before putting it into a DSH profile:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar graph pnpm-lock \
  ./pnpm-lock.yaml \
  --root @your-scope/your-dsh-plugin@1.0.0 \
  --json
```

This reads only the lockfile. It does not run `pnpm install`, lifecycle scripts, plugin code, or network requests. It understands pnpm v6/v9 package locators, peer-context variants, duplicate versions, and a project root declared through the `importers` section. An unresolved or ambiguous dependency remains visible instead of being guessed away. The JSON is the same canonical graph shape used by Radar's OSV path matching, so a CI job can review the graph before the plugin is admitted to DSH. Run `pnpm run showcase:pnpm-lock` for a real repository example.

## See one incident

If an advisory affects only one of two installed `parser` versions, Radar reports the path that actually matched:

```text
[HIGH][NEW] Dependency vulnerability
Project: Payments API (payments-api)
Plugin: plugin@1.0.0
Affected: parser@2.9.0
Origin: plugin profile
Advisory: GHSA-demo-2026-parser / CVE-2026-1234
Paths:
  plugin@1.0.0 -> logger@4.0.2 -> parser@2.9.0
Fixed versions: 3.0.0
Route: payments-platform via feishu:payments-security
```

That incident becomes a plugin-originated DSH notice. It is not copied into a generic chatbot prompt.

| Upstream signal | Radar proves deterministically | DSH Agent investigates |
| --- | --- | --- |
| Vulnerability or malicious package | affected `name@version`, every installed path, fixed versions, incident state | whether project code reaches it, attacker input can reach it, and the least disruptive fix |
| Candidate npm release | version boundary and Node.js, peer, export, entrypoint, bundle, and dependency changes; exact direct and transitive candidate OSV status; when possible, the first newer version without a deterministic blocker or known vulnerable path | which APIs or Cordis configuration would break and what migration is appropriate; the first candidate is never treated as a safety certificate |

## Install in DSH

Upstream Radar is an npm-published DSH bundle, so no install-time build permission is required:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar setup \
  --profile web \
  --project-name "My DSH project"
```

`setup` delegates the package installation to DSH using the exact Radar version currently being run. It then generates `upstream-radar.config.json` and `upstream-radar.dsh.yml` by default, and runs `doctor` locally without contacting OSV, npm, or GitHub. It does not start DSH. Review the two generated files, then start the profile:

```bash
dsh --profile web --patch ./upstream-radar.dsh.yml --dump-config
dsh --profile web --patch ./upstream-radar.dsh.yml
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

For an already installed bundle, add `--no-install`. The lower-level manual path remains available when you want to review the DSH installation separately: run `dsh plugin --profile web add upstream-radar@<exact-version>`, then use `init --profile web --dsh-patch ...` and `doctor`.

The initializer reads the profile's actual third-party bundles and follows the installed `node_modules` tree exposed by that profile, including duplicate versions, overrides, and local package-manager choices. By default it records the workspace as `.` so the config can be committed and reused on another machine; start DSH from the project root. Pass `--workspace <absolute-path>` only when DSH is launched elsewhere. It reads manifests only: it does not import plugin code, run lifecycle scripts, start DSH, or enable polling.

If startup does not behave as expected, run the local wiring check before looking at upstream feeds:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar doctor ./upstream-radar.config.json \
  --profile web \
  --patch ./upstream-radar.dsh.yml
```

`doctor` does not contact OSV, npm, GitHub, or execute plugin code. It checks that the config parses, the selected DSH profile actually registers `upstream-radar`, the overlay points to the same config and state files, the dependency coverage is complete, and the durable state can be read. It exits non-zero only for a blocked setup; a missing first-run state is shown as a warning with the next command to run. Add `--json` when another tool needs the result.

The generated overlay points DSH at the config and state files explicitly and records the selected profile. If `--registry <url>` was used during initialization, the same registry is carried into the running DSH monitor; otherwise release and candidate checks use the public npm registry. Before each native DSH polling cycle, and before each CLI `radar check` or `radar watch` cycle, it re-reads that profile's installed graph, so later plugin installs, upgrades, removals, and host-runtime changes are not silently missed. If the refresh fails, that cycle stops without replacing the last durable state. `radar status` remains read-only and reports whether a check has completed, which source is unhealthy, whether dependency coverage is complete, the most important active incidents with their exact path or candidate, a suggested next step, pending DSH tasks, and verified model conclusions. You can inspect a stored conclusion with `upstream-radar analysis list <state.json>` or `analysis show <state.json>`. Radar accepts a conclusion only when the response is strict JSON from the matching DSH model session; it never treats arbitrary chat as an analysis result. `radar compare` remains a manual comparison of the files you provide. If you prefer environment variables or need to override the polling interval, omit `--dsh-patch` and use `UPSTREAM_RADAR_CONFIG`, `UPSTREAM_RADAR_STATE`, `UPSTREAM_RADAR_INTERVAL_SECONDS`, `UPSTREAM_RADAR_REGISTRY`, and `UPSTREAM_RADAR_DEEP_CANDIDATES` as before.

The generated graph is the actual installed profile graph. During a native DSH run, Radar also reads the exact DSH CLI entrypoint (`@deepseek-ai/dsh/lib/bin.js`) and discovers the `node_modules` plane that process is using. It does this with bounded, read-only manifest checks: it does not import DSH, load a plugin, or run an install hook. Packages resolved from that plane are marked as `dsh-host`, and their exact versions are checked for advisories. `radar status` says whether the host plane came from the running DSH process or the profile fallback. If a required dependency is declared but cannot be resolved from either place, it remains visible as incomplete coverage instead of being treated as absent. Missing optional platform packages are retained as evidence but do not make coverage incomplete. Passing `--registry <url>` explicitly selects the older public npm artifact graph path, which is useful for comparing a profile against registry resolution but is not the default.

For a hand-written or CI fixture, use [the example inventory](examples/radar/config.json). If neither a generated `--patch` overlay nor `UPSTREAM_RADAR_CONFIG` is provided, the bundle stays dormant and performs no polling.

Once running, Radar polls OSV, npm, and public GitHub Releases, persists incident state before delivery, and submits only changed incidents to the matching DSH project session. With one root Agent, delivery remains automatic; with multiple roots, Radar requires an exact match between `project.workspace` and `Agent.session.header.cwd`, and keeps the task queued when it cannot prove the route. The native adapter records the exact message id, DSH session, task id, and event id; it writes back only a matching `assistant/message` from that session whose visible text is the six-field JSON result. A new or updated upstream event invalidates the previous result, so an old model conclusion cannot survive a changed dependency fact. If a source is temporarily unavailable, Radar keeps the last confirmed state instead of claiming that the project is clean, continues delivering already queued tasks, and creates one source-health notice after three consecutive failures.

Each release cycle also checks a bounded prefix of candidate dependency graphs. This is enabled by default in the DSH adapter and CLI; use `--no-deep-candidates` only when you deliberately want manifest-only compatibility checks. The graph resolver is isolated in a temporary directory and uses `package-lock-only` plus `ignore-scripts`, so candidate package code is not loaded or executed.

## Run the proof

Boot a real DSH `headless` profile with the packed Upstream Radar bundle installed:

```bash
git clone https://github.com/MicroMilo/upstream-radar.git
cd upstream-radar
corepack enable
pnpm install --frozen-lockfile
pnpm run try:dsh
```

No DeepSeek API key is required. The paid model endpoint is replaced by a deterministic local DeepSeek-compatible stub; the Cordis loader, DSH Agent, Session, persistence stack, bundle installation, and plugin delivery are real.

The command fails unless DSH proves all five facts:

```json
{
  "bundleInstalled": true,
  "radarTaskReachedModel": true,
  "pluginSourcePreserved": true,
  "pendingTasksAfterDelivery": 0,
  "analysisResults": 1,
  "dshEntrypointObserved": true,
  "dshHostRuntimePlaneDiscovered": true
}
```

This proof runs in CI on Node.js 22. See the executable [showcase contract](examples/dsh/README.md) and its checked-in [result](examples/dsh/reports/headless-smoke.json). Run `pnpm run try:dsh:live` to include a current OSV and npm poll before the DSH handoff.

To demonstrate the host-runtime dependency path specifically, run `pnpm run showcase:dsh-runtime`. It starts a real DSH `headless` process, refreshes the installed plugin graph from the process's exact host `node_modules`, queries a local OSV-compatible feed for the real `@deepseek-ai/cordis` version, persists a `dsh-host` vulnerability path, and hands it to the DSH Agent. The model and advisory are deterministic local stubs; this proves integration and provenance, not the safety of a real advisory.

## Validate the compatibility rules

Before wiring a project into a compatibility gate, run the offline rule benchmark:

```bash
pnpm dlx --package=upstream-radar@0.33.0 upstream-radar benchmark compatibility
```

It covers six contracts: a safe patch, a change that only needs project analysis, an incompatible DSH peer, a publisher-declared breaking release, a vulnerable candidate dependency, and an incomplete candidate graph. The command does not access the network, install a package, load a plugin, or start DSH. It checks the behavior of Radar's deterministic rules and the `breaking`/`any` gates; it is not a runtime compatibility proof.

## Probe a real DSH bundle

When you have an exact plugin artifact and want to know whether one exact DSH release can load it, run the bounded probe:

```bash
# Pack an exact npm release without running its lifecycle scripts.
npm pack --ignore-scripts dsh-plugin@1.2.3

pnpm dlx --package=upstream-radar@0.33.0 upstream-radar probe dsh-load \
  ./dsh-plugin-1.2.3.tgz \
  --dsh-version 0.1.0-rc.6
```

The probe reads the tarball first, requires a package-local `dsh.bundle.patch`, and refuses lifecycle scripts. It then creates a temporary DSH `headless` profile, adds the exact tarball, checks that DSH registered the bundle, and runs `--dump-config`. The profile is removed at the end unless `--keep-profile` is supplied.

There are three deliberate outcomes:

| Result | Meaning | Exit code |
| --- | --- | ---: |
| `compatible` | This DSH version registered the bundle and loaded its configuration. | `0` |
| `incompatible` | DSH accepted installation but rejected registration or configuration loading. | `2` |
| `unknown` | Preflight, DSH startup, installation, or the time limit prevented a reliable conclusion. | `1` |

This is a load-compatibility check only. It does not run plugin business actions, test model behavior, or prove that the package and its dependencies are safe. The repository's reproducible three-case demo is:

```bash
pnpm run showcase:dsh-probe
```

It exercises a loadable bundle, a bundle patch DSH rejects, and a package that remains `unknown` because it declares `postinstall`.

To compare a plugin against more than one DSH release, use the matrix form:

```bash
pnpm dlx --package=upstream-radar@0.33.0 upstream-radar probe dsh-matrix \
  ./dsh-plugin-1.2.3.tgz \
  --dsh-version 0.1.0-rc.3 \
  --dsh-version 0.1.0-rc.6 \
  --json
```

The matrix runs versions one at a time in separate temporary profiles and evaluates the same artifact each time. It needs at least two distinct exact versions and accepts at most eight. The aggregate is `incompatible` if any version is incompatible, `unknown` if none is incompatible but at least one result is unknown, and `compatible` only when every tested version loads successfully. The JSON shape is documented in the [matrix result schema](schemas/dsh-load-matrix.schema.json).

## Run it in GitHub Actions

If your team wants a scheduled CI gate before wiring a machine to a live DSH profile, commit the reviewed `upstream-radar.config.json` and copy [the example workflow](examples/github-actions/upstream-radar.yml). The reusable Action keeps the workflow to two meaningful steps, with an optional third step for DSH load compatibility:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: MicroMilo/upstream-radar@v0.33.0
    with:
      config: upstream-radar.config.json
      fail-on: high
      # Optional: also fail on deterministic DSH/plugin compatibility breaks.
      fail-on-compatibility: breaking
```

The Action is a thin wrapper around `radar check --frozen --state :memory: --fail-on high --json`; when the optional compatibility input is enabled, it also passes `--fail-on-compatibility breaking` or `any`. `--frozen` is deliberate: it uses the graph in the reviewed config and does not try to read a developer's local DSH profile. Each run is independent, exits `2` when an active vulnerability or opted-in compatibility change meets its threshold, and exits `1` for an operational or source error. `breaking` catches confirmed or strong incompatibility signals; `any` catches every active compatibility event. The default is `never`, so vulnerability-only behavior stays unchanged. The Action does not deliver a DSH Agent task or modify a branch; the native DSH bundle remains the always-on analysis path. Pin the Action to a release tag such as `v0.33.0`, and pin the checkout Action in your workflow according to your repository's policy.

The Action requires the caller to check out the repository first. It does not install the project's dependencies or run their lifecycle scripts; it only reads the committed graph and queries the configured upstream sources. For a fully explicit, lower-level invocation, the equivalent command is:

```bash
pnpm dlx --package=upstream-radar@0.33.0 upstream-radar radar check \
  ./upstream-radar.config.json --frozen --state :memory: --fail-on high \
  --fail-on-compatibility breaking --json
```

To add the optional DSH load matrix for a published plugin, provide an exact npm package and at least two exact DSH versions:

```yaml
- uses: MicroMilo/upstream-radar@v0.33.0
  id: radar
  with:
    config: upstream-radar.config.json
    fail-on: high
    probe-package: dsh-cloudflare-browser-run@0.1.1
    probe-dsh-versions: 0.1.0-rc.3,0.1.0-rc.6
```

The Action packs the exact package with `--ignore-scripts`, runs `probe dsh-matrix`, exposes `probe-result`, and fails with the probe's exit code when the result is `incompatible` or `unknown`. This extra step downloads and loads the DSH bundle in temporary profiles; it is a compatibility signal, not a security sandbox or a capability test.

For a runnable consumer example using the real [`dsh-cloudflare-browser-run@0.1.1`](examples/github-actions/consumer/upstream-radar.config.json) graph, see the [consumer smoke README](examples/github-actions/consumer/README.md) and its [copyable workflow](examples/github-actions/consumer/upstream-radar.yml).

Run the same released Action locally from this repository with:

```bash
pnpm run try:consumer
```

For a local or self-hosted DSH machine, omit `--frozen` so Radar refreshes the selected profile before each cycle. Use `--fail-on` or `--fail-on-compatibility` only with `radar check`, `radar status`, or `radar watch --once`; a long-running watch should continue routing incidents instead of terminating on the first one.

## How the loop works

1. Read the project inventory and exact installed npm graph.
2. Query OSV with every installed `name@version` pair.
3. Watch npm releases for the installed plugin and DSH/Cordis packages.
4. Create or update one durable incident with the exact dependency path.
5. Persist a constrained analysis task before delivery.
6. Route a plugin-originated follow-up to the DSH root whose session workspace matches the project.
7. Record the exact DSH message/session delivery and accept only the matching model response with strict JSON.
8. Keep the task on disk when no Agent is available; cancel stale work and conclusions when the incident resolves or changes.

For a local process or a scheduled runner, the same loop is available as:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch ./upstream-radar.config.json --interval 1800
```

Use `radar check --frozen --state :memory: --fail-on high --fail-on-compatibility breaking --json` for a machine-enforced CI check against a reviewed graph. The local DSH path continues to use `radar watch`, which refreshes the selected profile before each cycle.

The handoff uses `ctx.agents.roots()[0].followup(...)` with:

```json
{
  "kind": "plugin",
  "plugin": "upstream-radar",
  "form": "notice"
}
```

It is a native DSH lifecycle integration—not a chat bridge or a remote-control bot.

## Why package-name alerts are not enough

Given this installed graph:

```text
plugin@1.0.0
├── framework@2.4.7
│   ├── parser@3.2.1
│   └── archive@1.8.0
└── logger@4.0.2
    └── parser@2.9.0
```

an advisory affecting `parser@2.9.0` matches only the `plugin -> logger -> parser` branch. The unaffected `parser@3.2.1` remains a distinct physical node instead of becoming a package-name false positive.

## Vulnerabilities are only half the upstream problem

Upstream Radar also watches candidate releases for compatibility boundaries that matter to DSH plugins:

- Node.js engine exclusions;
- incompatible `@deepseek-ai/dsh-*` or `@deepseek-ai/cordis` peer ranges;
- changed `main`, `exports`, or DSH bundle patch paths;
- removed dependencies;
- major and pre-1.0 breaking version boundaries;
- publisher-declared breaking changes in supplied release notes, including public GitHub Release notes attached to the candidate version when npm points to a GitHub repository.

These are signals for project analysis, not automatic claims that an upgrade is broken.

## The model gets judgment, not control of the facts

Upstream Radar determines facts that a model must not guess:

```text
parser@2.9.0 is reported as affected
plugin -> logger -> parser is the installed path
the project runs Node.js 22
the candidate requires Node.js >=24
the installed DSH peer is outside the candidate range
```

The DSH Agent answers the repository-specific questions:

```text
is the vulnerable feature reachable here?
can attacker-controlled input reach it?
which API or Cordis configuration would the upgrade disturb?
what is the least disruptive project-specific action?
```

When one DSH runtime release changes several `@deepseek-ai/dsh-*` packages, Radar keeps each package as an independent state record but combines the same project's notices into one Agent analysis. You get one coherent upgrade question without losing the exact package evidence needed for later resolution. The resulting conclusion is copied back to each still-current incident only after the grouped model response passes the same strict validation.

Advisories, release notes, links, package names, and repository strings remain untrusted data. The generated task requires read-only analysis, project evidence, explicit uncertainty, and a fixed [result schema](schemas/analysis-result.schema.json).

## What works today

- installed DSH `node_modules` graphs and npm lockfile graphs with duplicate versions and bounded dependency paths;
- DSH shared host-runtime dependency resolution discovered from the running DSH process, with profile and `dsh-host` packages kept distinct in both graphs and alerts;
- exact-version OSV vulnerability and malicious-package matching;
- npm release monitoring for plugins and DSH/Cordis packages, accepting only a candidate newer than the installed exact version (a regressed `latest` dist-tag is not a breaking update), with public GitHub Release notes attached when an exact candidate tag is available;
- bounded transitive dependency graph checks for the earliest candidate versions, exact OSV matching for every resolved node, vulnerable path evidence, and explicit incomplete/unavailable coverage;
- durable incident state with current-task replacement and resolution;
- strict DSH result writeback bound to the exact message, session, task, and event, with stale-result rejection;
- native DSH bundle installation, startup polling, `agent/created` retry, and plugin-source attribution;
- optional provider-neutral HTTPS webhook delivery for changed events, with endpoint-safe deduplication and retry;
- read-only pnpm v6/v9 lockfile graph extraction, including project-root importers and explicit ambiguous peer references;
- automatic selection of the only DSH profile with third-party bundles, plus a network-free `radar status` snapshot;
- commit-friendly `init` output that records the project workspace as `.` by default;
- a reusable GitHub Action that turns the reviewed graph into a two-step, frozen CI gate;
- an opt-in GitHub Action DSH load matrix for exact published plugin versions and exact DSH versions;
- a real DSH plugin consumer smoke that runs the published Action against 18 exact package versions;
- an actionable, network-free `radar status` summary with exact active paths, candidate signals, and next steps;
- a network-free `doctor` command that checks local DSH registration, overlay/config alignment, state readability, and dependency coverage;
- compatibility signals for Node.js, peers, exports, entrypoints, bundle paths, dependencies, and version boundaries;
- an opt-in CI gate for confirmed/strong (`breaking`) or all (`any`) active compatibility changes;
- an offline `benchmark compatibility` command that locks the deterministic rule and gate behavior into six reviewable contracts;
- disposable `probe dsh-load` and `probe dsh-matrix` commands that check one exact DSH version or a bounded exact-version matrix against one bundle and return `compatible`, `incompatible`, or `unknown`;
- network-free Radar and real DSH runtime showcases.

The bounded pre-install scanner remains available as a supporting collector:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar scan /path/to/dsh-plugin
pnpm dlx --package=upstream-radar@latest upstream-radar inspect npm:dsh-cloudflare-browser-run@0.1.1 --deep
```

## Current boundaries

- `init` discovers the only DSH profile with third-party bundles when `--profile` is omitted; multiple candidates still require an explicit profile. By default it follows the installed DSH `node_modules` tree, so pnpm overrides and local resolution choices are included. `--dsh-patch <path>` writes an explicit DSH overlay so first startup needs no environment variables and preserves an explicitly selected registry. `graph pnpm-lock` is a separate pre-install/CI collector; it does not itself query OSV or create a Radar config.
- A graph with unresolved required dependency declarations is marked as incomplete coverage; optional packages that are not installed for the current platform remain visible but do not create a false required-dependency alert. Missing `@deepseek-ai/dsh-*` and Cordis peers are called out separately as unobserved DSH host dependencies because Radar cannot query a version it was never shown.
- Candidate upgrade graphs are resolved only for a bounded earliest prefix. A candidate with an incomplete or unavailable graph is not recommended; later unqueried candidates remain visibly unchecked. Pass `--no-deep-candidates` to opt out of this extra registry work.
- Compatibility CI gating is opt-in: `--fail-on-compatibility breaking` fails on confirmed or strong incompatibility signals, while `any` fails on every active compatibility event; neither setting claims that a candidate is safe.
- `probe dsh-load` is intentionally narrower than a security scan: a successful load proves only that the selected DSH profile accepted the bundle configuration. It does not execute plugin actions, compare capabilities, or grant admission to an unreviewed package.
- `probe dsh-matrix` is intentionally sequential and bounded to eight versions. An incomplete matrix is not green: `unknown` propagates to the aggregate result until every selected DSH version has a reliable load result.
- `radar check/watch --frozen` intentionally uses the graph committed in the config for CI; it does not prove that the installed DSH profile has not changed. Without `--frozen`, native DSH and CLI polling refresh the selected profile first.
- `radar status` is a local snapshot only: it does not refresh OSV/npm/GitHub data, and it cannot prove that a source is current until a check has completed. It does show whether a captured DSH host plane came from the running process or a profile fallback. Its next steps are guidance, not an automatic upgrade or safety decision.
- `doctor` checks local wiring only; it cannot prove that a running DSH process has delivered a task to a model or that upstream feeds are current.
- npm and pnpm lock graphs are supported; Yarn graph extraction is not implemented.
- OSV, npm `latest`, and public GitHub Release notes are live sources; changelog, comparison-diff, and migration-guide ingestion are deferred.
- A failed OSV check preserves confirmed matches and returns a visible source warning; source health is durable and routed through DSH after three consecutive failures, while source-claim conflict handling and external health destinations are not implemented yet.
- `radar watch` is a CLI monitoring fallback; it does not deliver tasks into DSH by itself.
- Delivery uses one root Agent as the simple default; when several roots exist, it requires an exact project-workspace match and leaves ambiguous tasks queued instead of guessing.
- DSH result writeback accepts only the exact six-field JSON contract from the matching model session; it does not infer conclusions from ordinary chat or tool output. The result is advisory and never changes deterministic incident state.
- No Issue, branch, Pull Request, dependency override, or merge is created automatically.

Upstream Radar is alpha software built for the developer-preview DSH ecosystem. Event schemas and adapter boundaries can change.

## Project guide

- [Architecture](docs/architecture.md)
- [DSH headless showcase](examples/dsh/README.md)
- [Radar showcase walkthrough](docs/showcase.md)
- [Product vision（中文）](docs/vision.zh-CN.md)
- [Checks and evidence（中文）](docs/checks.zh-CN.md)
- [Threat model](docs/threat-model.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Release process](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

If DSH plugins are part of your stack, star the repository to follow the upstream safety loop as it grows. Start with the [reproducible DSH handoff showcase](https://github.com/MicroMilo/upstream-radar/discussions/11), then share questions and design feedback in [GitHub Discussions](https://github.com/MicroMilo/upstream-radar/discussions).

<sub>Community project for DeepSeek Harness. Not an official DeepSeek product. Apache-2.0 licensed.</sub>
