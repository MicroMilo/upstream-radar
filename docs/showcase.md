# Upstream Radar Showcase

Run the deterministic, network-free product demonstration:

```bash
pnpm run showcase:radar
```

Write the JSON events and exact DSH Agent task prompts under `examples/radar/reports/`:

```bash
pnpm run showcase:radar:reports
```

## Scene 1 — clean baseline

The project uses this graph:

```text
plugin@1.0.0
├── framework@2.4.7
│   ├── parser@3.2.1
│   └── archive@1.8.0
└── logger@4.0.2
    └── parser@2.9.0
```

The first feed snapshot contains no match. Radar stores a clean baseline and emits no alert.

## Scene 2 — a new vulnerability arrives

The simulated OSV update affects exactly `parser@2.9.0`. Radar does not flag `parser@3.2.1`; it emits:

```text
[HIGH][NEW] Dependency vulnerability
Project: Payments API (payments-api)
Plugin: plugin@1.0.0
Affected: parser@2.9.0
Paths:
  plugin@1.0.0 -> logger@4.0.2 -> parser@2.9.0
Fixed versions: 3.0.0
Route: payments-platform via feishu:payments-security
```

Running the same unchanged feed again produces no event. A changed advisory produces `updated`; removing the match produces `resolved`.

## Scene 3 — wake DSH

Radar creates a plugin-originated task containing:

- the exact project and workspace;
- the affected plugin and dependency path;
- the advisory as explicitly untrusted data;
- a read-only instruction to inspect reachability and input flow;
- a fixed JSON output contract with confidence and project evidence.

The example project deliberately calls the affected feature from `examples/radar/project/src/import-logs.ts`, giving a live DSH Agent concrete evidence to find.

## Scene 4 — breaking-change risk

The candidate `plugin@2.0.0` changes:

- major version;
- package entrypoint;
- DSH bundle patch;
- Node requirement from 22 to 24;
- DSH Agent peer requirement from `^0.1.0-rc.5` to `^0.2.0`;
- the exact public GitHub Release notes that explicitly say `BREAKING CHANGE`.

Radar identifies the mathematically incompatible environment and peer range, labels structural changes as needing analysis, and creates a separate DSH compatibility task.

The same npm metadata also contains `plugin@1.1.0`, `plugin@1.2.0`, and `plugin@1.3.0`. Radar checks those exact candidate versions against OSV without installing them, then checks their bounded transitive graphs with lifecycle scripts disabled. `1.1.0` is blocked because its graph contains `logger@4.1.0 -> parser@2.9.0` with a known advisory, `1.2.0` by the Node.js requirement, and `1.3.0` becomes the first checked version worth handing to DSH. That wording is deliberate: it is a candidate for project analysis, not a safety certificate.

```text
First candidate without a deterministic blocker: plugin@1.3.0 (still requires project analysis)
Candidate OSV check: complete
Candidate dependency graph check: complete
Upgrade candidates evaluated: 4; deterministic blockers: 3
Blocked candidate samples:
  plugin@1.1.0: candidate-dependency-vulnerability
  plugin@1.2.0: node-runtime-incompatible
  plugin@2.0.0: breaking-version-boundary, publisher-declared-breaking-change, node-runtime-incompatible, dsh-peer-incompatible
```

## Scene 5 — one DSH runtime change, one Agent notice

If one DSH runtime release changes several `@deepseek-ai/dsh-*` packages, Radar keeps the package-level incidents separate in durable state but groups the pending native DSH delivery:

```text
Deterministic compatibility incidents kept in state: 2
DSH Agent notices: 1
```

The Agent receives one project-level upgrade question containing both package facts. If one package later resolves while another remains risky, their state and follow-up lifecycle still remain independent.

## Scene 6 — one current task per incident

The always-on state machine then observes three transitions for the same stable `incidentId`:

```text
NEW: 2.0.0; queued tasks for incident: 1
UPDATED: 3.0.0; queued tasks for incident: 1
RESOLVED: project caught up; queued tasks for incident: 0
```

The update replaces the older offline task instead of accumulating two analyses. Resolution removes the task before DSH can receive stale work. The exact transition evidence is saved as `examples/radar/reports/06-incident-lifecycle.json`.

## Scene 7 — a source outage is not a clean result

The showcase then simulates an OSV timeout. Radar emits no new or resolved vulnerability event, keeps the previously confirmed match, keeps the pending DSH task, and returns a visible `sourceErrors: osv` warning. The evidence is saved as `examples/radar/reports/07-source-outage.json`.

## Scene 8 — repeated failures become one source-health notice

After three consecutive failed OSV checks, Radar creates one project-routed `source-health` incident and sends it through the same durable DSH outbox. When OSV recovers, the source-health incident resolves and its pending task is removed. The lifecycle is saved as `examples/radar/reports/08-source-health-lifecycle.json`.

## Scene 9 — onboarding without shell state

`setup --profile web --dsh-patch ./upstream-radar.dsh.yml` installs the exact running Radar version through DSH, writes the inventory and a reviewable DSH overlay, and runs the local doctor. The inventory records `project.workspace` as `.` by default, so it can be committed without embedding a creator's home directory; run DSH from the project root. The overlay replaces the bundle's environment-derived paths with explicit config and state files, so the profile can start with one visible command:

```bash
dsh --profile web --patch ./upstream-radar.dsh.yml
```

The setup command does not start DSH or execute plugin business actions; the user still reviews both generated files before launching the profile. Use `--no-install` when the bundle is already present.

## Scene 10 — confirm the first run without another network request

After DSH has started, the read-only status command reads the same config and durable state files:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

It reports whether monitoring has started, the last successful check for OSV/npm/GitHub Releases, active vulnerability and compatibility incidents, source-health incidents, pending DSH analysis tasks, in-flight deliveries, and verified DSH conclusions. When an incident is active, it also shows the exact affected path or candidate signal and one suggested next step. Once the matching model response passes validation, that next step includes the stored exposure/confidence and recommended action:

```text
Attention:
  [HIGH] Payments API: parser@2.9.0 is affected by GHSA-demo-2026-parser via plugin@1.0.0 -> logger@4.0.2 -> parser@2.9.0
    Next: DSH analysis: likely_exposed (medium confidence); Review the call path and run the project tests.
```

For the full structured conclusion, use `upstream-radar analysis show <state.json> <incident-id>`; ordinary chat, a response from another session, malformed JSON, and results for an updated event are not accepted.

It does not poll any upstream source, so it is safe to use for a quick local diagnosis. The next step is guidance; it is not an automatic upgrade or a safety verdict.

The status output also shows `Coverage: incomplete` when the installed profile contains a dependency declaration that DSH cannot currently resolve. Optional peers remain visible without being counted as required gaps. If a required `@deepseek-ai/dsh-*` or Cordis peer is absent from both the profile and the exposed DSH host plane, status calls it out as a DSH host dependency that was not observed; that is a configuration gap, not a clean result.

## Scene 11 — diagnose the wiring before blaming the feeds

The local doctor checks the reviewed config, the selected DSH profile, the generated overlay, the durable state file, and required dependency coverage without contacting OSV, npm, or GitHub:

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar doctor ./upstream-radar.config.json \
  --profile web \
  --patch ./upstream-radar.dsh.yml
```

It reports `READY`, `READY WITH WARNINGS`, or `BLOCKED`. A missing first-run state is a warning; a profile without the Radar bundle, a mismatched overlay, an invalid config, or a corrupt state file is blocked. The same report can be emitted as JSON for CI or a future DSH status surface.

## Scene 12 — the graph follows the installed DSH profile

For a profile containing `dsh-cloudflare-browser-run@0.1.1`, initialization reports the graph source explicitly:

```json
{
  "name": "dsh-cloudflare-browser-run",
  "version": "0.1.1",
  "nodes": 6,
  "edges": 9,
  "source": "installed-node-modules"
}
```

This is intentionally different from resolving the same package in a fresh npm project. A DSH profile may provide peer packages from its host, apply overrides, or leave a declaration unresolved; Radar keeps that difference visible instead of silently replacing it with a registry-generated graph. It also reads npm's optional-peer declaration: a platform package that is absent is shown as optional, while an absent `@deepseek-ai/dsh-*` or Cordis peer is called out as an unobserved DSH host dependency. The latter keeps coverage incomplete because Radar has no exact host version to query.

## Scene 13 — make the reviewed graph a CI gate

For a runner that does not have DSH installed, commit the generated config after review and run one frozen check:

```bash
pnpm dlx --package=upstream-radar@0.31.0 upstream-radar radar check \
  ./upstream-radar.config.json \
  --frozen --state :memory: --fail-on high --json
```

`--frozen` prevents the command from looking for a local DSH profile. `--fail-on high` returns exit code `2` when the committed graph has an active high or critical vulnerability (malware is critical), while source or operational failures return `1`. This is a CI gate for deterministic evidence; it does not replace the native DSH Agent analysis or create an upgrade.

## Scene 14 — make the gate two workflow steps

The published Action packages the same frozen check so a DSH plugin project does not need to copy the runner setup or remember the safety flags:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: MicroMilo/upstream-radar@v0.31.0
    with:
      config: upstream-radar.config.json
      fail-on: high
```

The Action checks out no code by itself and does not run DSH or plugin lifecycle scripts. It reads the reviewed graph from the caller's workspace, queries the configured sources, and fails only according to the explicit threshold. The native DSH bundle remains the path for always-on monitoring and model analysis.

To make breaking compatibility changes a CI decision as well as a DSH analysis task, opt in explicitly:

```yaml
with:
  fail-on: high
  fail-on-compatibility: breaking
```

`breaking` fails only when the program has a confirmed or strong incompatibility signal. `any` fails on every active compatibility event; `never` is the default.

The Action also has an opt-in load-only matrix for a published plugin:

```yaml
with:
  probe-package: dsh-cloudflare-browser-run@0.1.1
  probe-dsh-versions: 0.1.0-rc.3,0.1.0-rc.6
```

It packs without lifecycle scripts, runs one temporary DSH profile per version, exposes `probe-result`, and fails on `incompatible` or `unknown`. It does not turn the Action into a security sandbox or a plugin capability test.

## Scene 15 — validate the rule contract offline

The package includes a no-network compatibility benchmark for the deterministic gate itself:

```bash
pnpm dlx --package=upstream-radar@0.31.0 upstream-radar benchmark compatibility
```

It covers a safe patch, analysis-only structural change, DSH peer exclusion, explicit publisher breaking language, a vulnerable candidate dependency, and incomplete candidate coverage. A passing benchmark means the rule contract has not regressed; it does not mean a real plugin is runtime-compatible. The real DSH consumer workflow below remains the integration proof.

## Scene 16 — verify the consumer path with a real DSH plugin

The repository also carries a copyable consumer smoke under [`examples/github-actions/consumer`](../examples/github-actions/consumer/README.md). Its snapshot is built from the published `dsh-cloudflare-browser-run@0.1.1` package and its resolved graph, so the first-run path exercises real npm manifests and real DSH package names. A project should regenerate this snapshot with `radar init` after reviewing its own DSH profile.

## Scene 17 — load a DSH bundle without starting a user's profile

The `probe dsh-load` command gives the compatibility question its own bounded surface. It takes one exact `.tgz`, uses one exact DSH version, and creates a disposable `headless` profile:

```bash
pnpm dlx --package=upstream-radar@0.31.0 upstream-radar probe dsh-load \
  ./dsh-plugin-1.2.3.tgz \
  --dsh-version 0.1.0-rc.6 --json
```

The stages are visible in the JSON report: artifact preflight, DSH startup, bundle installation, profile registration, and configuration loading. `compatible` means only that the last stage passed; `incompatible` means DSH rejected the installed bundle; `unknown` means the probe could not establish a reliable result. Lifecycle scripts are refused before DSH is opened, and the temporary profile is deleted unless `--keep-profile` is requested.

The checked-in showcase runs all three outcomes with local fixtures:

```bash
pnpm run showcase:dsh-probe
```

This is a runtime compatibility proof for one DSH version, not a package-security admission, a plugin capability benchmark, or a test of business actions.

The same showcase also runs the loadable fixture against DSH `0.1.0-rc.3` and `0.1.0-rc.6`. The matrix is green only because both exact versions complete all five stages; if one version timed out or could not be loaded, the aggregate would remain `unknown` rather than silently passing.

## Live sources

The fixture isolates behavior from network timing. Production cycles use:

- OSV `querybatch` plus full advisory records for exact installed versions;
- npm packuments for the latest plugin and DSH package manifests;
- public GitHub Release notes for the exact candidate tag when the package metadata points to GitHub.
- a failed OSV check preserves the last confirmed matches instead of producing false `resolved` events.

The showcase uses a deterministic fake release-notes source, while production cycles use the bounded public GitHub Releases adapter. GitHub comparison diffs, changelogs, and migration guides remain on the roadmap.

## Legacy admission showcase

The original artifact-oriented demonstration remains available:

```bash
pnpm run build
node scripts/showcase.mjs
```

It verifies npm artifact integrity, signatures, provenance, static risks, and bounded archive handling. It is supporting evidence collection rather than the main product demonstration.
