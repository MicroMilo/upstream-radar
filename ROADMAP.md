# Roadmap

## Milestone 0 — first vertical slice

- [x] Preserve exact dependency nodes, edges, duplicate versions, and root-to-node paths.
- [x] Query OSV for exact installed npm versions.
- [x] Emit only new, materially updated, and resolved vulnerability events.
- [x] Recognize malicious-package records.
- [x] Route every event to a project, owner, and configured channel.
- [x] Persist pending DSH Agent analysis tasks before delivery.
- [x] Bind DSH model results to the exact message, session, task, and event; reject ordinary chat and stale conclusions.
- [x] Ship an installable DSH bundle with a bounded fixed polling interval.
- [x] Ship a one-command CLI watch loop for demos, CI, and local diagnosis.
- [x] Provide a deterministic vulnerability and breaking-change showcase.
- [x] Provide a packaged, network-free demo that shows the exact path and constrained DSH handoff before a user installs anything.
- [x] Prove bundle installation, plugin-source attribution, Session persistence, and Agent delivery in a real DSH headless profile.
- [x] Validate the beginner-facing setup path against a real published DSH plugin in a disposable profile without starting DSH or executing plugin business actions.
- [x] Generate an explicit DSH `--patch` overlay so first use does not require environment variables.
- [x] Auto-select the only DSH profile with third-party bundles and provide a network-free first-run status snapshot.
- [x] Provide a network-free doctor command for DSH bundle registration, overlay/config alignment, state readability, and dependency coverage.
- [x] Show bounded active-incident paths, candidate signals, and next-step guidance in the network-free status command.
- [x] Order active status incidents by known exploitation, EPSS, and advisory severity while keeping missing signals explicit.
- [x] Make the generated project workspace portable by default so the reviewed inventory can be committed and reused.
- [x] Provide one explicit DSH setup command that installs the exact Radar version, generates wiring, and runs the network-free doctor check.
- [x] Make the first-use CLI self-explaining with command-specific help, a read-only `quickstart` path selector, and actionable admission next steps.
- [x] Provide a one-command, read-only `radar next` handoff from the highest-priority incident to DSH task inspection or the next check.
- [x] Show verified DSH urgency, recommendation, and bounded evidence inline in the `radar next` handoff.

## Milestone 1 — compatibility radar

- [x] Monitor npm `latest` for installed plugin releases and DSH packages.
- [x] Detect Node.js, entrypoint, export-map, bundle, peer-range, and pre-1.0 DSH changes.
- [x] Separate compatibility facts from model conclusions.
- [x] Track compatibility incidents through new, updated, and resolved states.
- [x] Replace stale queued analysis when an incident changes and cancel it when resolved.
- [x] Keep a text/JSON task export as a debugging surface for the DSH outbox.
- [x] Expose verified analysis results through `radar status` and `analysis list/show`.
- [x] Read the exact public GitHub Release notes for a candidate version; changelogs, comparison diffs, and migration guides remain deferred.
- [x] Track the exact `@deepseek-ai/dsh` executable plus its reachable DSH/Cordis host dependency closure as a coordinated host-runtime release surface; keep per-package evidence and group same-round changes into one DSH Agent notice.
- [x] Coalesce one shared DSH host-runtime vulnerability across all affected plugin roots, retaining the complete bounded path set and migrating legacy per-plugin host alerts.
- [x] Group pending same-project DSH runtime compatibility tasks into one native Agent notice without merging state incidents.
- [x] Resolve the first newer plugin candidate without a deterministic blocker or known OSV vulnerability, while leaving final compatibility to DSH project analysis.
- [x] Resolve a bounded prefix of each candidate's transitive dependency graph with lifecycle scripts disabled, query graph nodes against OSV, and withhold candidates whose graph is incomplete or unavailable.
- [x] Parse the native pnpm v6/v9 lockfile for pre-install and CI inspection, including importer roots and peer-context ambiguity.
- [x] Turn a pnpm lockfile graph into a static Radar config and prove the lockfile-to-OSV event path before DSH installation.
- [x] Provide a copyable GitHub Action mode that builds the static config from pnpm lockfile input before the frozen gate.
- [x] Discover a named DSH profile's installed third-party bundles and generate a reviewable inventory.
- [x] Auto-select the only DSH profile with third-party bundles when `--profile` is omitted.
- [x] Use the selected profile's installed `node_modules` tree as the source of truth, including unresolved-edge visibility.
- [x] Refresh generated native DSH inventories from the current installed profile before each poll.
- [x] Keep CLI `radar check/watch` aligned with the refreshed native DSH profile path.
- [x] Run a plugin bundle-load probe in a disposable DSH profile for one explicit DSH version.
- [x] Record `compatible`, `incompatible`, and `unknown` against an explicit DSH version matrix.

## Milestone 2 — reliable project routing

- [x] Add the pnpm lock graph adapter; Yarn remains a separate future adapter.
- [ ] Maintain one durable project registry across multiple machines.
- [x] Deliver to the correct DSH project session instead of one security-inbox Agent.
- [x] Offer an explicit `setup --start` shortcut while keeping the review-first default.
- [x] Add provider-neutral HTTPS webhook delivery with durable event acknowledgement and retry.
- [x] Add direct Feishu/Lark V2 custom-bot text delivery with optional environment-only signature generation; keep generic webhook acknowledgement state.
- [x] Route webhook events to project-specific environment endpoints with independent endpoint outboxes while preserving the global broadcast-compatible path.
- [ ] Add suppression, ownership, maintenance-window, and dev-only rules.
  - [x] Add per-project minimum vulnerability severity and timezone-aware quiet hours as delivery-only controls.
  - [x] Keep held DSH tasks and webhook events durable so policy changes do not lose evidence.
  - [x] Expose the common notification controls through `setup` and every `init` mode without requiring manual JSON edits.
  - [x] Add bounded per-incident delivery mutes with explicit expiry, exact event-version matching, and an immediate `unmute` command.
  - [x] Add per-incident follow-up status, owner, and handoff note bound to the exact event version; keep it separate from delivery suppression and resolution.
  - [x] Add optional per-incident deadlines and render overdue follow-ups in the read-only status and next-action views.
  - [ ] Add explicit owner routing and maintenance-window/dev-only scopes beyond quiet hours.
- [x] Keep a bounded local transition history for new, updated, and resolved/source-health states, with a read-only `radar history` query.

## Milestone 3 — richer vulnerability intelligence

- [x] Ingest GitHub Security Advisories as an independent exact-version source with optional API-token support.
- [x] Enrich matched CVEs with CISA KEV and EPSS, while treating both as prioritization evidence rather than safety verdicts.
- [x] Deduplicate OSV and GitHub Advisory GHSA/CVE aliases while retaining one durable primary incident and merged fix versions.
- [x] Preserve advisory source provenance in events, state, CLI output, and webhook payloads so cross-source confirmation is visible.
- [x] Surface severity and fixed-version disagreements as source conflicts, while preserving the last confirmed incident during partial source outages.
- [x] Detect when a previously unavailable fixed version is published and re-open the project analysis task.
- [x] Calculate whether a top-level plugin update actually removes every affected path, while keeping incomplete or DSH host-runtime evidence unknown.
- [x] Persist per-source health, alert after three consecutive failures, and resolve the alert when the source recovers without asking the model to decide version applicability.
- [x] Detect conflicting source claims without asking the model to decide version applicability.
- [x] Preserve confirmed vulnerability state and pending DSH tasks when OSV is temporarily unavailable; surface the failure to CLI and DSH logs.

## Milestone 4 — GitHub execution arm

- [x] Provide a frozen one-shot CI check with severity exit codes and a copyable GitHub Actions workflow.
- [x] Publish a reusable composite GitHub Action for the frozen deterministic CI gate.
- [x] Write an escaped, human-readable GitHub Job Summary alongside the Action's raw JSON result.
- [x] Auto-detect one pnpm or npm lockfile in GitHub Actions when no reviewed config is present, while failing clearly for ambiguous or missing inputs.
- [x] Verify the published Action with a real DSH plugin consumer snapshot and a dogfood workflow.
- [x] Add an opt-in Action input that packs one exact plugin release and runs the bounded DSH load matrix.
- [x] Add an opt-in Action input that deeply inspects one exact npm plugin artifact before installation and writes its admission result to the Job Summary.
- [x] Add an opt-in compatibility-change gate for breaking DSH/plugin updates.
- [x] Provide an offline compatibility-rule benchmark covering deterministic and analysis-only outcomes.
- [x] Add a DSH-first upstream observer for GitHub commits, npm package metadata, manifests, and optional lockfile graphs.
- [x] Persist one observation point per target and generate old → new tasks only for meaningful changes.
- [x] Keep docs/tests-only changes quiet and route meaningful tasks through an explicit, no-shell DSH Agent adapter.
- [x] Emit an upstream/downstream alignment IR for source identity, published package identity, graph root, and dependency coverage; surface baseline mismatches without waking the Agent every day.
- [x] Build a reverse dependency index and route upstream package-name version changes to affected downstream plugins with exact paths and coverage status.
- [ ] Connect the adapter to the official DSH headless invocation once that interface is stable and documented.
- [ ] Re-check the installed and proposed graph in GitHub Actions.
- [ ] Attach project evidence to a GitHub Issue only after routing policy permits it.
- [ ] Generate an upgrade branch or Pull Request behind explicit approval.
- [ ] Run tests against the old and candidate DSH/plugin combinations.
- [ ] Report residual paths and avoid claiming a partial upgrade fixed the alert.

## Supporting work

The pre-install scanner remains useful for collecting manifests and exact graphs. Signature, provenance, artifact identity, isolated detonation, and admission receipts are secondary tracks; they must not delay continuous vulnerability and compatibility monitoring.

Plugin runtime usefulness, task success, cost, and latency benchmarks remain out of scope. The repository does include an offline compatibility-rule contract benchmark; it is a regression surface for deterministic Radar behavior, not a plugin capability score.
