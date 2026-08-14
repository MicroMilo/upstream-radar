# Security policy

Plugin Notary is security-sensitive software. Please do not publish exploit details for a vulnerability that could let a scanned artifact escape isolation, forge evidence, bypass policy, or reuse a receipt for different bytes.

Until a private reporting channel is configured, open a minimal GitHub issue that asks the maintainers for a private contact path and omit sensitive details. This file will be updated before the repository is published.

## Report scope

High-priority issues include:

- execution of target-controlled code during a supposedly static scan;
- filesystem traversal or symlink escape;
- scan/install digest mismatch or other time-of-check/time-of-use gaps;
- receipt signature, canonicalization, expiry or revocation bypass;
- secrets included in public reports or logs;
- fail-open behavior after scanner or policy errors.

## Scanner claims

A report is bounded evidence, not a guarantee that an artifact is safe. Coverage fields are security-relevant and must remain explicit. An unavailable check must report `not-checked`, `not-run`, `incomplete`, or an error; it must never become a pass.
