# Threat model

## Protected outcomes

Upstream Radar protects two connected outcomes:

1. an upstream vulnerability or release change is matched to the correct installed package, dependency path, project, and owner without being lost or repeated indefinitely;
2. DSH receives the upstream material as untrusted data and produces a project-specific analysis without obeying instructions embedded in that material.

The supporting pre-install scanner additionally protects exact-artifact evidence collection.

## Assets

- project source, credentials, sessions, local files, and DSH tool authority;
- project/plugin inventories and exact dependency paths;
- active vulnerability state, active compatibility incidents, and pending analysis tasks;
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
10. A flood of advisories, dependency nodes, package releases, or pending tasks exhausts memory, disk, network, model quota, or user attention.
11. A malicious package attacks the supporting static scanner through archives, paths, links, parsers, lifecycle scripts, or native code.

## Trust boundaries

- **Untrusted data:** advisories, release notes, references, registry metadata, package manifests, plugin source, project repository content, lockfiles, and every string derived from them.
- **Deterministic trusted plane:** bounded parsers, exact-version queries, graph traversal, state-transition calculation, and atomic state writer.
- **Model analysis plane:** DSH and its tools. It may interpret project context but may not redefine the deterministic match.
- **Operator configuration:** project locations, owners, channels, polling interval, and alternate OSV endpoint. Configuration errors fail visibly.

## Security invariants

1. A model never decides whether an exact version is affected.
2. Distinct physical dependency nodes are preserved even when names match.
3. Every alert names the project, installed plugin, affected package, and bounded path.
4. Feed and release prose is framed as untrusted data, never instructions.
5. Every DSH Agent analysis defaults to read-only and requires project evidence.
6. New tasks are persisted before synchronous Agent admission.
7. Unchanged matches do not emit another event.
8. Missing, malformed, or failed source/state checks cannot silently become clean.
9. Compatibility heuristics retain their confidence class.
10. Network bodies, graph sizes, path counts, state size, text length, and time are bounded.
11. Target-controlled package code and lifecycle scripts are not executed during collection.

## Delivery semantics

Delivery is at-least-once. The state/outbox write happens before `Agent.followup`. After synchronous admission, the task is removed with a second atomic write. A crash in that narrow interval can duplicate the task; stable event/task ids allow future adapters to suppress duplicates. The design prefers a duplicate over a silently lost security event.

## Out of scope

- proving that a package or project contains no exploitable behavior;
- plugin usefulness, task success, cost, or benchmark quality;
- automatically granting write authority to a model;
- preventing a user from deleting state or disabling the plugin;
- exactly-once delivery across all future external notification systems;
- automatically merging a generated security fix.

## Current limitations

- The graph collector currently parses npm lock graphs; pnpm and Yarn adapters are absent.
- OSV is the only live vulnerability source; npm `latest` and bounded public GitHub Release notes are the automatic release sources.
- GitHub comparison diffs, changelogs, and migration guides are not fetched automatically.
- One live root DSH Agent acts as the security inbox; project-session selection is not implemented.
- The prompt establishes a read-only contract, but enforcement still depends on the DSH Agent's configured tools and permission policy.
- Feed failures are reported by the cycle; OSV failures preserve the last confirmed matches and pending tasks, while durable per-source health history and health alerts remain future work.
- The scanner uses the host npm CLI with scripts disabled; it is not a microVM detonation boundary.
