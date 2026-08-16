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
- [x] Generate an explicit DSH `--patch` overlay so first use does not require environment variables.
- [x] Auto-select the only DSH profile with third-party bundles and provide a network-free first-run status snapshot.
- [x] Provide a network-free doctor command for DSH bundle registration, overlay/config alignment, state readability, and dependency coverage.
- [x] Show bounded active-incident paths, candidate signals, and next-step guidance in the network-free status command.
- [x] Make the generated project workspace portable by default so the reviewed inventory can be committed and reused.
- [x] Provide one explicit DSH setup command that installs the exact Radar version, generates wiring, and runs the network-free doctor check.

## Milestone 1 — compatibility radar

- [x] Monitor npm `latest` for installed plugin releases and DSH packages.
- [x] Detect Node.js, entrypoint, export-map, bundle, peer-range, and pre-1.0 DSH changes.
- [x] Separate compatibility facts from model conclusions.
- [x] Track compatibility incidents through new, updated, and resolved states.
- [x] Replace stale queued analysis when an incident changes and cancel it when resolved.
- [x] Keep a text/JSON task export as a debugging surface for the DSH outbox.
- [x] Expose verified analysis results through `radar status` and `analysis list/show`.
- [x] Read the exact public GitHub Release notes for a candidate version; changelogs, comparison diffs, and migration guides remain deferred.
- [ ] Track DSH package families as one coordinated release rather than unrelated npm packages.
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
- [x] Add provider-neutral HTTPS webhook delivery with durable event acknowledgement and retry.
- [x] Add direct Feishu/Lark V2 custom-bot text delivery with optional environment-only signature generation; keep generic webhook acknowledgement state.
- [ ] Add suppression, ownership, maintenance-window, and dev-only rules.
- [x] Keep a bounded local transition history for new, updated, and resolved/source-health states, with a read-only `radar history` query.

## Milestone 3 — richer vulnerability intelligence

- [ ] Ingest GitHub Security Advisories incrementally as a second source.
- [ ] Enrich matched CVEs with CISA KEV and EPSS.
- [ ] Deduplicate OSV, GHSA, CVE, and malicious-package aliases.
- [x] Detect when a previously unavailable fixed version is published and re-open the project analysis task.
- [ ] Calculate whether a top-level plugin update actually removes every affected path.
- [x] Persist per-source health, alert after three consecutive failures, and resolve the alert when the source recovers without asking the model to decide version applicability.
- [ ] Detect conflicting source claims without asking the model to decide version applicability.
- [x] Preserve confirmed vulnerability state and pending DSH tasks when OSV is temporarily unavailable; surface the failure to CLI and DSH logs.

## Milestone 4 — GitHub execution arm

- [x] Provide a frozen one-shot CI check with severity exit codes and a copyable GitHub Actions workflow.
- [x] Publish a reusable composite GitHub Action for the frozen deterministic CI gate.
- [x] Write an escaped, human-readable GitHub Job Summary alongside the Action's raw JSON result.
- [x] Verify the published Action with a real DSH plugin consumer snapshot and a dogfood workflow.
- [x] Add an opt-in Action input that packs one exact plugin release and runs the bounded DSH load matrix.
- [x] Add an opt-in compatibility-change gate for breaking DSH/plugin updates.
- [x] Provide an offline compatibility-rule benchmark covering deterministic and analysis-only outcomes.
- [ ] Re-check the installed and proposed graph in GitHub Actions.
- [ ] Attach project evidence to a GitHub Issue only after routing policy permits it.
- [ ] Generate an upgrade branch or Pull Request behind explicit approval.
- [ ] Run tests against the old and candidate DSH/plugin combinations.
- [ ] Report residual paths and avoid claiming a partial upgrade fixed the alert.

## Supporting work

The pre-install scanner remains useful for collecting manifests and exact graphs. Signature, provenance, artifact identity, isolated detonation, and admission receipts are secondary tracks; they must not delay continuous vulnerability and compatibility monitoring.

Plugin runtime usefulness, task success, cost, and latency benchmarks remain out of scope. The repository does include an offline compatibility-rule contract benchmark; it is a regression surface for deterministic Radar behavior, not a plugin capability score.
