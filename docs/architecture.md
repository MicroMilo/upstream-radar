# Architecture

## Product boundary

Upstream Radar has three responsibilities:

1. determine which exact installed package versions are affected by an upstream fact;
2. create a bounded, project-specific analysis task;
3. route the resulting decision to the project that can act on it.

The model never decides whether a version range matches.

```text
                  deterministic plane

 npm lock graph ───────────────┐
                               ├─> match + paths ─> durable event/outbox
 OSV exact-version results ────┤                         │
 npm candidate manifests ─────┐                         │
 public GitHub Release notes ─┘                         │
                                                         v
                     DSH Agent analysis plane

             advisory/release material (untrusted data)
                              + project workspace
                                        │
                                        v
                          exposure / migration analysis
                                        │
                                        v
                         owner + configured channel
```

## Dependency graph

Every physical package location is a node. Two copies of `parser` with different versions remain separate:

```text
plugin@1.0.0
├── framework@2.4.7
│   └── parser@3.2.1
└── logger@4.0.2
    └── parser@2.9.0
```

Edges retain whether they are runtime, development, optional, or peer dependencies. A vulnerability event contains every bounded root-to-node path, so the alert explains which plugin introduced the package.

The npm deep collector resolves in a temporary project with lifecycle scripts disabled and parses `package-lock.json`. An unresolved edge stays explicit; it is never silently counted as checked.

## Vulnerability cycle

1. Deduplicate all installed npm `name@version` pairs.
2. Submit them to OSV `querybatch`.
3. Fetch full details only for returned advisory ids.
4. Match each result back to physical graph nodes and paths.
5. Compare the current match set with durable state.
6. Emit `new`, `updated`, or `resolved` only when state changes.
7. Add new and updated events to the durable DSH analysis outbox.

If OSV is unavailable, the cycle records a source warning, keeps the last confirmed vulnerability matches, emits no false `resolved` events, and still proceeds to deliver already-persisted DSH tasks. A failed source is never treated as a clean result.

The active-match key binds project, plugin version, affected package version, and advisory id. An unchanged advisory does not create another event.

## Compatibility cycle

The release source reads npm metadata; it does not install the candidate. When the candidate manifest points to a public `github.com` repository, a second read-only source looks up the exact `v<version>` or `<version>` GitHub Release tag. Its body and link are untrusted evidence. The current and candidate manifests are compared for:

- a major compatibility boundary, or a minor boundary while below 1.0;
- package entrypoint and export-map changes;
- DSH bundle declaration changes;
- Node.js engine changes and definite runtime exclusion;
- DSH/Cordis peer-range changes and definite installed-version exclusion;
- pre-1.0 DSH package updates;
- publisher-declared breaking language in the exact public GitHub Release notes when available.

These are signals for project analysis. Only an explicit publisher statement or a mathematically incompatible version range is treated as confirmed/strong evidence. Other changes remain `needs-analysis`.

Compatibility findings use the same lifecycle as vulnerabilities. A stable `incidentId` identifies the project, installed plugin, and changed package while individual event ids identify each `new`, `updated`, or `resolved` transition. A newer candidate replaces the queued analysis for the same incident; when the project catches up or the signal disappears, the unresolved task is removed.

## DSH Agent handoff

An analysis task includes the deterministic event, project location, route, and a fixed output contract. Its prompt says that every advisory, release note, link, package name, and repository string is untrusted data. It requests read-only investigation and requires file, symbol, configuration, or runtime evidence. DSH consumes it natively as a plugin-originated notice. Text and JSON export remain debugging surfaces, not a second product integration.

The DSH bundle performs this transaction:

```text
poll sources
  -> calculate state changes
  -> replace stale tasks and cancel resolved incidents
  -> atomically save active matches and pending tasks
  -> select a live root Agent
  -> submit plugin-originated follow-up
  -> atomically remove synchronously accepted tasks from the outbox
```

The delivery boundary is intentionally at-least-once. A crash after follow-up admission but before the second state write can repeat a task; it cannot silently erase it. Event and task ids allow later delivery adapters to deduplicate.

## Failure isolation

- Target plugin code is never imported to build a graph.
- npm lifecycle scripts remain disabled during dependency resolution.
- Network responses have byte, item, and timeout limits.
- Invalid state/configuration fails visibly instead of resetting history.
- Feed prose cannot become model instructions.
- A DSH process without a configured inventory is dormant.
- A process without a live Agent retains pending tasks on disk.

## Current DSH boundary

The adapter uses only the small Cordis surface needed for lifecycle cleanup, root-Agent discovery, and `followup`. It intentionally does not depend on the session-local Schedule plugin. A local timer performs fixed polling while the DSH process is alive; durable state provides restart recovery.

Today, the first live root Agent acts as a security inbox. A later adapter will select or create the project-specific session named by each event.

## Supporting pre-install collector

The original artifact scanner still verifies exact npm bytes, signatures, provenance, static package risks, and bounded archive parsing. Its dependency resolution now produces the graph consumed by Radar. Admission receipts and artifact fingerprints are supporting evidence, not the primary product surface.
