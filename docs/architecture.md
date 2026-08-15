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
 candidate dependency graphs ─┤                         │
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

For a real DSH profile, initialization follows the installed `node_modules` resolution tree exposed by that profile without importing package code or running lifecycle scripts. This captures duplicate versions and profile-local overrides. DSH also maintains a shared `profiles/node_modules` fallback for its own runtime closure; Radar follows that same fallback, marks those physical nodes as `dsh-host`, and includes their exact versions in OSV matching. A required edge that is absent from both places stays explicit and makes coverage incomplete. Optional packages that are not installed for the current platform stay visible as optional gaps without being promoted to a required coverage failure. The public npm deep collector remains available for explicit registry comparisons; it resolves in a temporary project with lifecycle scripts disabled and parses `package-lock.json`. In both paths, an unresolved edge stays explicit; it is never silently counted as checked.

## Vulnerability cycle

1. Deduplicate all installed npm `name@version` pairs.
2. Submit them to OSV `querybatch`.
3. Fetch full details only for returned advisory ids.
4. Match each result back to physical graph nodes and paths, retaining whether the affected node came from the plugin profile or the DSH host runtime.
5. Compare the current match set with durable state.
6. Emit `new`, `updated`, or `resolved` only when state changes.
7. Add new and updated events to the durable DSH analysis outbox.

If OSV is unavailable, the cycle records a source warning, keeps the last confirmed vulnerability matches, emits no false `resolved` events, and still proceeds to deliver already-persisted DSH tasks. A failed source is never treated as a clean result.

The same cycle persists `lastAttemptedAt`, `lastSucceededAt`, consecutive failures, and a bounded error for each attempted source. Three consecutive failures create one project-routed `source-health` event in the same outbox; a successful check resolves it.

The active-match key binds project, plugin version, affected package version, and advisory id. An unchanged advisory does not create another event.

## Compatibility cycle

The release source reads npm metadata; it does not install the candidate. A `latest` dist-tag that points to the same or an older exact version is not treated as an upgrade; an older tag also does not resolve an already active compatibility incident because a registry tag rollback is not evidence that the project changed. When the candidate manifest points to a public `github.com` repository, a second read-only source looks up the exact `v<version>` or `<version>` GitHub Release tag. Its body and link are untrusted evidence. The current and candidate manifests are compared for:

- a major compatibility boundary, or a minor boundary while below 1.0;
- package entrypoint and export-map changes;
- DSH bundle declaration changes;
- Node.js engine changes and definite runtime exclusion;
- DSH/Cordis peer-range changes and definite installed-version exclusion;
- pre-1.0 DSH package updates;
- publisher-declared breaking language in the exact public GitHub Release notes when available.

These are signals for project analysis. Only an explicit publisher statement or a mathematically incompatible version range is treated as confirmed/strong evidence. Other changes remain `needs-analysis`.

The npm packument also contains older releases. When the latest candidate is blocked, Radar evaluates newer intermediate manifests in ascending order and checks every exact candidate version against OSV. A known active vulnerability is a confirmed blocker. Radar records the first candidate without a confirmed/strong compatibility blocker or known vulnerability. This is a starting point for DSH analysis, not a claim that the version is safe; the Agent still has to inspect the project's code and configuration. If the candidate OSV check fails, no candidate is recommended. The event keeps only a small sample of blocked versions so the notice stays actionable.

For the earliest bounded prefix of those candidates, Radar also runs npm's resolver in a temporary project with `--package-lock-only --ignore-scripts`. It does not import the candidate or execute lifecycle code. Every resolved node is queried against OSV, and matches are attached to the candidate with root-to-node paths. A required unresolved edge makes that candidate's dependency coverage incomplete; a resolver or OSV failure makes it unavailable. A partial prefix may still identify the earliest checked candidate, but later candidates remain explicitly unchecked and cannot be described as clean.

Compatibility findings use the same lifecycle as vulnerabilities. A stable `incidentId` identifies the project, installed plugin, and changed package while individual event ids identify each `new`, `updated`, or `resolved` transition. A newer candidate replaces the queued analysis for the same incident; when the project catches up or the signal disappears, the unresolved task is removed.

## DSH Agent handoff

An analysis task includes the deterministic event, project location, route, and a fixed output contract. Its prompt says that every advisory, release note, link, package name, and repository string is untrusted data. It requests read-only investigation and requires file, symbol, configuration, or runtime evidence. DSH consumes it natively as a plugin-originated notice. Text and JSON export remain debugging surfaces, not a second product integration.

Compatibility incidents for one project's DSH runtime packages remain separate in durable state, but the native DSH adapter groups them into one Agent notice when they are pending together. Grouping changes delivery noise, not evidence or incident identity.

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

When a generated inventory is used, the native DSH adapter and CLI `radar check/watch` first rebuild the installed graph from the selected DSH profile. This refresh is manifest-only and never executes plugin code. A failed refresh aborts that cycle before state replacement, so an unreadable or half-updated profile cannot be reported as clean. Read-only `status` and explicit-file `compare` do not refresh.

CLI-generated inventories record the project workspace as `.` by default. This keeps the graph and Agent context reviewable in version control without embedding the creator's absolute home path; the DSH process is expected to start from the project root. `--workspace <absolute-path>` remains available when that launch arrangement is not possible.

The delivery boundary is intentionally at-least-once. A crash after follow-up admission but before the second state write can repeat a task; it cannot silently erase it. Event and task ids allow later delivery adapters to deduplicate.

The `doctor` command is a separate local diagnosis plane. It parses the config and state, reads the selected DSH profile manifest, checks the generated overlay's paths, and reuses the network-free status snapshot. It never polls an upstream source and never loads a plugin, so a `READY` result means “the wiring is locally coherent,” not “the feeds are current” or “the model has completed an analysis.”

The same local plane renders a bounded action summary from durable state. It preserves the exact first dependency path for a vulnerability, the first checked candidate and strongest compatibility signal for an upgrade, or the failing source for a health incident. Its suggested next step is explicitly guidance; it never upgrades a package or converts incomplete coverage into a safe result.

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
