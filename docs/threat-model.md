# Threat model

## Protected outcomes

Upstream Radar protects two connected outcomes:

1. an upstream vulnerability or release change is matched to the correct installed package, dependency path, project, and owner without being lost or repeated indefinitely;
2. DSH receives the upstream material as untrusted data and produces a project-specific analysis without obeying instructions embedded in that material.
3. A model conclusion is written back only when it is tied to the exact Radar delivery and DSH session, is emitted by the model, and matches the fixed JSON result contract.
4. An optional external notification receives only changed events, with delivery failures remaining visible and retryable.

The supporting pre-install scanner additionally protects exact-artifact evidence collection.

## Assets

- project source, credentials, sessions, local files, and DSH tool authority;
- project/plugin inventories and exact dependency paths;
- active vulnerability state, active compatibility incidents, pending analysis tasks, in-flight deliveries, and verified analysis results;
- webhook delivery fingerprints and event ids, without the endpoint URL or token;
- correctness of new, updated, resolved, and compatibility transitions;
- availability and cost of the monitoring and model-analysis loop;
- legacy artifact evidence and policy decisions.

## Adversaries and failure modes

1. A vulnerability advisory, release note, package description, repository file, or linked page contains prompt injection.
2. A malicious registry or compromised maintainer serves oversized, malformed, conflicting, or deceptive metadata.
3. The graph collector silently omits a dependency or merges two distinct installed versions.
4. A matcher treats package names, version ranges, or advisory aliases incorrectly and misses or misroutes an event.
5. An unchanged event is emitted on every poll and trains users to ignore alerts.
6. A crash occurs after a match but before state or Agent delivery, losing the alert.
7. A crash occurs after Agent delivery but before acknowledgement, duplicating work.
8. A compatibility heuristic is presented as proof that an update is broken.
9. A model analysis modifies the repository, installs the candidate, runs advisory-supplied commands, or leaks project data.
10. An ordinary user message, a different DSH session, malformed JSON, or a response for an old event is accepted as a Radar conclusion.
11. A flood of advisories, dependency nodes, package releases, or pending tasks exhausts memory, disk, network, model quota, or user attention.
12. A malicious package attacks the supporting static scanner through archives, paths, links, parsers, lifecycle scripts, or native code.
13. A configured notification endpoint is unavailable, redirects unexpectedly, or receives more data than the operator intended.
14. A long-running monitor grows its local state without bound, or a retry records the same transition repeatedly.

## Trust boundaries

- **Untrusted data:** advisories, release notes, references, registry metadata, package manifests, plugin source, project repository content, lockfiles, and every string derived from them.
- **Deterministic trusted plane:** bounded parsers, exact-version queries, graph traversal, state-transition calculation, and atomic state writer.
- **Model analysis plane:** DSH and its tools. It may interpret project context but may not redefine the deterministic match.
- **Operator configuration:** project locations, owners, channels, polling interval, and alternate OSV endpoint. Configuration errors fail visibly.
- **Notification boundary:** an operator-selected HTTPS endpoint receives bounded event summaries; the endpoint is not trusted to influence Radar state or DSH analysis.

## Security invariants

1. A model never decides whether an exact version is affected.
2. Distinct physical dependency nodes are preserved even when names match.
3. Every alert names the project, installed plugin, affected package, and bounded path.
4. Feed and release prose is framed as untrusted data, never instructions.
5. Every DSH Agent analysis defaults to read-only and requires project evidence.
6. Result writeback checks the plugin-originated task marker, exact delivery/message id, session identity, `assistant/message` + `source.kind = model`, event freshness, and the six-field JSON schema. Failed checks are ignored and do not alter incident state.
7. New tasks are persisted before synchronous Agent admission.
8. Unchanged matches do not emit another event.
9. Missing, malformed, or failed source/state checks cannot silently become clean.
10. Compatibility heuristics retain their confidence class.
11. Network bodies, graph sizes, path counts, state size, text length, and time are bounded.
12. Target-controlled package code and lifecycle scripts are not executed during collection.
13. Webhook URLs must use HTTPS and are read from runtime configuration or an explicit CLI argument; only a SHA-256 fingerprint, delivered event ids, and a bounded copy of waiting event evidence are persisted. A Feishu/Lark V2 signing secret is read only from `UPSTREAM_RADAR_FEISHU_SECRET`, never from config or state.
14. A webhook is sent only for a changed event, and a non-2xx response or notification policy hold does not mark it delivered; delivery is at-least-once across a crash window.
15. The transition ledger is bounded and deduplicated by stable event id; losing old history never changes the active incident state.
16. GitHub Job Summary output escapes report-controlled strings and is only a human-readable view; the raw JSON remains authoritative.

## Delivery semantics

Delivery is at-least-once. The state/outbox write happens before `Agent.followup`. After synchronous admission, the task is removed with a second atomic write and a delivery record is retained until a matching model response is validated. A crash in either narrow interval can duplicate the task or leave a delivery waiting; stable event/task/message ids allow recovery without accepting an unrelated response. The design prefers a duplicate or a visible pending result over a silently lost security event.

The optional webhook follows the same bias: Radar persists the changed incident and a bounded webhook outbox before attempting the POST, records event ids only after an HTTP 2xx response, and leaves failed or policy-held events eligible for the next cycle. A process crash between the receiver's acknowledgement and the ledger write can duplicate a notification; the payload is therefore suitable for idempotent consumers and includes stable `id` and `incidentId` fields.

## Out of scope

- proving that a package or project contains no exploitable behavior;
- plugin usefulness, task success, cost, or benchmark quality;
- automatically granting write authority to a model;
- preventing a user from deleting state or disabling the plugin;
- exactly-once delivery across all future external notification systems;
- automatically merging a generated security fix.

## Current limitations

- The graph collector parses npm and pnpm v6/v9 lock graphs; Yarn graph extraction is not implemented.
- OSV is the only live vulnerability source; npm `latest` and bounded public GitHub Release notes are the automatic release sources.
- GitHub comparison diffs, changelogs, and migration guides are not fetched automatically.
- One live root DSH Agent acts as the security inbox; multiple roots require an exact project-session workspace match.
- The prompt establishes a read-only contract, but enforcement still depends on the DSH Agent's configured tools and permission policy.
- Feed failures are reported by the cycle; OSV failures preserve the last confirmed matches and pending tasks, and three consecutive failures create a durable source-health alert. The local transition ledger is intentionally bounded to the most recent 1,000 events; it is an audit convenience, not a complete historical database. Provider-native Feishu V2 text formatting is supported; the generic endpoint remains the stable JSON contract, and delivery acknowledgement stays endpoint-fingerprint based. Notification policy is currently limited to per-project minimum vulnerability severity and quiet hours; owner routing and dev-only scopes remain future work.
- The scanner uses the host npm CLI with scripts disabled; it is not a microVM detonation boundary.
