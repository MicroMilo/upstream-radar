# Roadmap

## Milestone 0 — first vertical slice

- [x] Preserve exact dependency nodes, edges, duplicate versions, and root-to-node paths.
- [x] Query OSV for exact installed npm versions.
- [x] Emit only new, materially updated, and resolved vulnerability events.
- [x] Recognize malicious-package records.
- [x] Route every event to a project, owner, and configured channel.
- [x] Persist pending DSH Agent analysis tasks before delivery.
- [x] Ship an installable DSH bundle with a bounded fixed polling interval.
- [x] Provide a deterministic vulnerability and breaking-change showcase.
- [x] Prove bundle installation, plugin-source attribution, Session persistence, and Agent delivery in a real DSH headless profile.

## Milestone 1 — compatibility radar

- [x] Monitor npm `latest` for installed plugin releases and DSH packages.
- [x] Detect Node.js, entrypoint, export-map, bundle, peer-range, and pre-1.0 DSH changes.
- [x] Separate compatibility facts from model conclusions.
- [x] Track compatibility incidents through new, updated, and resolved states.
- [x] Replace stale queued analysis when an incident changes and cancel it when resolved.
- [x] Keep a text/JSON task export as a debugging surface for the DSH outbox.
- [ ] Read GitHub releases, changelogs, comparison diffs, and migration guides.
- [ ] Track DSH package families as one coordinated release rather than unrelated npm packages.
- [ ] Resolve the lowest clean plugin upgrade, not merely the latest release.
- [ ] Discover the active DSH profile and its installed lock graph automatically.
- [ ] Run plugin load and representative compatibility probes in a disposable DSH profile.
- [ ] Record `compatible`, `incompatible`, and `unknown` against an explicit DSH version matrix.

## Milestone 2 — reliable project routing

- [ ] Add pnpm and Yarn lock graph adapters.
- [ ] Maintain one durable project registry across multiple machines.
- [ ] Deliver to the correct DSH project session instead of one security-inbox Agent.
- [ ] Add Feishu, Slack, email, and generic webhook delivery with acknowledgement state.
- [ ] Add suppression, ownership, maintenance-window, and dev-only rules.
- [ ] Keep event history for new, updated, acknowledged, fixed, withdrawn, and ignored states.

## Milestone 3 — richer vulnerability intelligence

- [ ] Ingest GitHub Security Advisories incrementally as a second source.
- [ ] Enrich matched CVEs with CISA KEV and EPSS.
- [ ] Deduplicate OSV, GHSA, CVE, and malicious-package aliases.
- [ ] Detect when a previously unavailable fixed version is published.
- [ ] Calculate whether a top-level plugin update actually removes every affected path.
- [ ] Add source reliability and conflict handling without asking the model to decide version applicability.

## Milestone 4 — GitHub execution arm

- [ ] Re-check the installed and proposed graph in GitHub Actions.
- [ ] Attach project evidence to a GitHub Issue only after routing policy permits it.
- [ ] Generate an upgrade branch or Pull Request behind explicit approval.
- [ ] Run tests against the old and candidate DSH/plugin combinations.
- [ ] Report residual paths and avoid claiming a partial upgrade fixed the alert.

## Supporting work

The pre-install scanner remains useful for collecting manifests and exact graphs. Signature, provenance, artifact identity, isolated detonation, and admission receipts are secondary tracks; they must not delay continuous vulnerability and compatibility monitoring.

Plugin usefulness benchmarks remain out of scope.
