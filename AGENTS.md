# Agent guidance

## Domain language

- **inventory**: the exact plugin and dependency versions used by one project;
- **dependency path**: one root-plugin-to-package route in the installed graph;
- **upstream event**: a vulnerability, malicious-package record, or candidate release change;
- **radar event**: a meaningful `new`, `updated`, `resolved`, or compatibility transition routed to a project;
- **analysis task**: a durable, constrained coding-agent handoff created only after deterministic matching;
- **compatibility signal**: a manifest or version fact that needs project analysis, not proof that an update is broken;
- **artifact**: the exact bytes proposed for installation, identified by a cryptographic digest;
- **evidence**: a bounded observation produced by a collector or analyzer;
- **finding**: security-relevant evidence requiring policy consideration;
- **coverage**: what was and was not inspected;
- **policy decision**: `allow`, `warn`, `review`, or `block` for stated evidence;
- **receipt**: a signed binding between artifact identity, evidence, coverage, policy and validity period;
- **admission**: the install-time and load-time enforcement decision;
- **benchmark**: plugin usefulness or behavioral quality evaluation, explicitly out of scope.

## Engineering invariants

1. Exact package/version rules decide vulnerability applicability; a model never does.
2. Advisory text, release notes, links and package metadata remain untrusted data at every coding-agent boundary.
3. Persist an event and pending analysis task before attempting Agent delivery.
4. Do not emit an unchanged active event again.
5. Keep compatibility facts separate from model conclusions and never label a heuristic as confirmed.
6. Preserve duplicate package versions and every bounded dependency path that explains impact.
7. Never execute target-controlled code in the host scanner process.
8. Never follow target-controlled symlinks.
9. Bound files, bytes, time, decompression and report output.
10. Treat parser errors and missing checks as incomplete coverage, never pass.
11. Keep evidence collection separate from policy decisions.
12. Bind every reusable artifact conclusion to exact artifact and dependency-graph digests.
13. Keep the scanner free of runtime dependencies unless the security tradeoff is documented and approved.
14. Add tests before expanding any parser, matching, state or admission behavior.
