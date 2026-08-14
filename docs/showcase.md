# Upstream Radar Showcase

Run the deterministic, network-free product demonstration:

```bash
pnpm run showcase:radar
```

Write the JSON events and exact coding-agent task prompts under `examples/radar/reports/`:

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
- release notes that explicitly say `BREAKING CHANGE`.

Radar identifies the mathematically incompatible environment and peer range, labels structural changes as needing analysis, and creates a separate DSH compatibility task.

## Scene 5 — one current task per incident

The always-on state machine then observes three transitions for the same stable `incidentId`:

```text
NEW: 2.0.0; queued tasks for incident: 1
UPDATED: 3.0.0; queued tasks for incident: 1
RESOLVED: project caught up; queued tasks for incident: 0
```

The update replaces the older offline task instead of accumulating two analyses. Resolution removes the task before DSH can receive stale work. The exact transition evidence is saved as `examples/radar/reports/06-incident-lifecycle.json`.

## Live sources

The fixture isolates behavior from network timing. Production cycles use:

- OSV `querybatch` plus full advisory records for exact installed versions;
- npm packuments for the latest plugin and DSH package manifests.

Release notes and GitHub diffs are currently accepted by the offline comparison command; automatic GitHub release ingestion is on the roadmap.

## Legacy admission showcase

The original artifact-oriented demonstration remains available:

```bash
pnpm run build
node scripts/showcase.mjs
```

It verifies npm artifact integrity, signatures, provenance, static risks, and bounded archive handling. It is supporting evidence collection rather than the main product demonstration.
