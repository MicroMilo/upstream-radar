<div align="center">

# Upstream Radar

**Know which upstream changes actually matter to your coding-agent projects.**

[![CI](https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](ROADMAP.md)

Always-on vulnerability and breaking-change impact monitoring for DeepSeek Harness plugins, with a native DSH adapter and a vendor-neutral task bridge for Codex, Claude Code, and other coding agents.

</div>

---

Vulnerability scanners tell you that a package is affected. Release bots tell you that a new version exists. They usually do not tell you:

- which plugin brought that package into a project;
- which exact dependency path is affected when multiple versions coexist;
- whether the vulnerable feature is reachable in this repository;
- whether the available upgrade breaks Node.js, DSH, the plugin entrypoint, or its bundle;
- which coding agent should investigate, and how to avoid handing untrusted advisory text control of that agent.

Upstream Radar closes that gap.

```mermaid
flowchart LR
    feeds["OSV advisories<br/>npm releases"] --> match["Exact name@version match"]
    match --> graph["Installed dependency path"]
    graph --> incident["Project-specific incident<br/>new · updated · resolved"]
    incident --> dsh["Native DSH follow-up"]
    incident --> outbox["Durable task outbox"]
    outbox --> codex["Codex"]
    outbox --> claude["Claude Code"]
    outbox --> other["Other coding agents"]
```

## See it in 60 seconds

```bash
git clone https://github.com/MicroMilo/upstream-radar.git
cd upstream-radar
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run showcase:radar
```

The `upstream-radar` commands below refer to the package binary. From an unlinked source checkout, run the equivalent command as `node dist/src/cli.js ...` after `pnpm build`.

The network-free showcase starts from this installed graph:

```text
plugin@1.0.0
├── framework@2.4.7
│   ├── parser@3.2.1
│   └── archive@1.8.0
└── logger@4.0.2
    └── parser@2.9.0
```

When a new advisory affects only `parser@2.9.0`, the result is routed through the exact path:

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

The same showcase detects that `plugin@2.0.0` requires Node.js 24, excludes the installed DSH Agent peer version, changes its entrypoint and DSH bundle, and declares a breaking change.

Incidents remain current even while an agent is offline:

```text
NEW:      2.0.0  queued tasks: 1
UPDATED:  3.0.0  queued tasks: 1
RESOLVED: caught up  queued tasks: 0
```

Inspect the generated [vulnerability event](examples/radar/reports/02-vulnerability-alert.json), [constrained agent task](examples/radar/reports/03-vulnerability-dsh-task.txt), [compatibility event](examples/radar/reports/04-compatibility-alert.json), and [incident lifecycle](examples/radar/reports/06-incident-lifecycle.json).

## What works today

### Deterministic monitoring

- Preserves physical dependency nodes, edges, duplicate versions, and bounded root-to-package paths.
- Queries OSV for exact installed npm `name@version` pairs.
- Recognizes vulnerability and malicious-package records.
- Monitors npm releases for installed plugins and pre-1.0 DSH packages.
- Detects version compatibility boundaries, Node.js exclusions, DSH/Cordis peer exclusions, entrypoint and export-map changes, bundle changes, and removed dependencies.
- Emits only meaningful `new`, `updated`, and `resolved` transitions.
- Keeps one current queued task per stable incident; updates replace stale work and resolution cancels it.

### Coding-agent integrations

| Agent | Works now | Delivery model |
| --- | --- | --- |
| DeepSeek Harness | **Native** | Installable `upstream-radar/dsh` bundle; automatic polling and durable follow-up to a live Agent |
| Codex CLI | **CLI bridge** | Render one constrained task to stdin for `codex exec` in a read-only sandbox |
| Claude Code | **CLI bridge** | Render one constrained task to stdin for non-interactive `claude -p` in plan mode |
| Other agents / CI | **Generic bridge** | Consume the task as bounded text or canonical JSON |

List and render the durable outbox:

```bash
upstream-radar task list /absolute/path/radar-state.json
upstream-radar task show /absolute/path/radar-state.json analysis-abc123
```

Send the task to Codex:

```bash
upstream-radar task show /absolute/path/codex-state.json analysis-abc123 \
  | codex exec -C /absolute/path/to/project --sandbox read-only \
      --output-schema /absolute/path/to/upstream-radar/schemas/analysis-result.schema.json -
```

Or Claude Code:

```bash
cd /absolute/path/to/project
upstream-radar task show /absolute/path/claude-state.json analysis-abc123 \
  | claude -p "Analyze the Upstream Radar task supplied on stdin." --permission-mode plan
```

After the consumer accepts the task:

```bash
upstream-radar task ack /absolute/path/radar-state.json analysis-abc123
```

These are deliberately generic one-shot bridges, not native Codex or Claude Code plugins. Use one state file per dispatcher. See [coding-agent integrations](docs/agent-integrations.md) for the exact boundary and official CLI references.

## Run one live cycle

Build an inventory shaped like [examples/radar/config.json](examples/radar/config.json), then query OSV and npm while retaining durable incident state:

```bash
pnpm build
node dist/src/cli.js radar check /absolute/path/radar-config.json \
  --state /absolute/path/radar-state.json
```

Compare two supplied manifests without installing or executing either release:

```bash
node dist/src/cli.js radar compare \
  examples/radar/config.json \
  examples/radar/plugin-before.json \
  examples/radar/plugin-candidate.json \
  --notes examples/radar/release-notes.txt
```

## Install into DSH

Upstream Radar is currently installed from a checkout or packed tarball:

```bash
pnpm build

export UPSTREAM_RADAR_CONFIG=/absolute/path/radar-config.json
export UPSTREAM_RADAR_STATE=/absolute/path/radar-state.json
export UPSTREAM_RADAR_INTERVAL_SECONDS=1800

dsh plugin --profile web add /absolute/path/upstream-radar
dsh --profile web
```

Without `UPSTREAM_RADAR_CONFIG`, the bundle is dormant. While DSH is running, it polls at a bounded interval, persists matched tasks before delivery, and submits a plugin-originated follow-up to the first live root Agent. With no live Agent, work remains queued on disk.

## Program facts vs. agent judgment

The program establishes facts that must not be guessed:

```text
parser@2.9.0 is reported as affected
plugin -> logger -> parser is the installed path
the project runs Node.js 22
the candidate requires Node.js >=24
the installed DSH peer is outside the candidate range
```

The coding agent investigates questions that require repository context:

```text
is the vulnerable feature reachable here?
can attacker-controlled input reach it?
which API or configuration would the upgrade disturb?
what is the least disruptive project-specific action?
```

Every advisory, release note, URL, package name, and repository string is treated as untrusted data. The generated task is read-only, requires project evidence, preserves uncertainty, and has a published [result JSON Schema](schemas/analysis-result.schema.json). Model reasoning cannot rewrite the deterministic match.

## Supporting pre-install evidence

The original bounded scanner remains available as a supporting collector:

```bash
node dist/src/cli.js scan /path/to/dsh-plugin
node dist/src/cli.js inspect npm:dsh-cloudflare-browser-run@0.1.1 --deep
```

It verifies exact npm bytes, registry signatures and provenance when available, statically inspects package risks, and resolves the dependency graph with lifecycle scripts disabled. It does not claim that a package is safe merely because implemented checks found nothing.

## Current boundaries

- npm lock graphs are supported; pnpm and Yarn graph adapters are not implemented.
- OSV and npm `latest` are the live sources; automatic GitHub release and migration-guide ingestion is deferred.
- Compatibility signals identify changes requiring analysis; they do not prove runtime breakage.
- DSH currently routes to the first live root Agent rather than a project-specific session.
- Codex and Claude Code use manual one-shot dispatch; no background wakeup or result ingestion exists for them yet.
- Do not let two dispatchers write the same state file concurrently.
- No Issue, branch, Pull Request, dependency override, or merge is created automatically.

Upstream Radar is alpha software built against a developer-preview DSH ecosystem. Event schemas and adapter boundaries can still change.

## Project guide

- [Architecture](docs/architecture.md)
- [Showcase walkthrough](docs/showcase.md)
- [Coding-agent integrations](docs/agent-integrations.md)
- [Product vision（中文）](docs/vision.zh-CN.md)
- [Checks and evidence（中文）](docs/checks.zh-CN.md)
- [Threat model](docs/threat-model.md)
- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

Apache-2.0 licensed.
