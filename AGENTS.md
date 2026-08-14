# Agent guidance

## Domain language

- **artifact**: the exact bytes proposed for installation, identified by a cryptographic digest;
- **evidence**: a bounded observation produced by a collector or analyzer;
- **finding**: security-relevant evidence requiring policy consideration;
- **coverage**: what was and was not inspected;
- **policy decision**: `allow`, `warn`, `review`, or `block` for stated evidence;
- **receipt**: a signed binding between artifact identity, evidence, coverage, policy and validity period;
- **admission**: the install-time and load-time enforcement decision;
- **benchmark**: plugin usefulness or behavioral quality evaluation, explicitly out of scope.

## Engineering invariants

1. Never execute target-controlled code in the host scanner process.
2. Never follow target-controlled symlinks.
3. Bound files, bytes, time, decompression and report output.
4. Treat parser errors and missing checks as incomplete coverage, never pass.
5. Keep evidence collection separate from policy decisions.
6. Bind every reusable conclusion to exact artifact and dependency-graph digests.
7. Keep the scanner free of runtime dependencies unless the security tradeoff is documented and approved.
8. Add tests before expanding any parser or admission behavior.
