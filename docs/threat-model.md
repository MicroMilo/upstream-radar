# Threat model

## Protected decision

Plugin Notary protects one decision: whether an exact agent-extension artifact may be installed and loaded under a stated policy.

## Assets

- developer credentials, source trees, sessions, and local files;
- DSH profiles and their dependency graphs;
- integrity of review evidence and signed receipts;
- reviewer signing identities and revocation state;
- availability of the installation and loading workflow.

## Adversaries and failure modes

1. A malicious package author publishes intentionally harmful code.
2. A legitimate maintainer or registry account is compromised.
3. A repository tag, branch, release asset, or transitive dependency changes after review.
4. Published files differ from the declared source commit or build recipe.
5. Lifecycle scripts execute before an admission decision.
6. A dependency resolver selects different bytes between scan and install.
7. A user or another process bypasses the installer and modifies an installed plugin.
8. An artifact attempts to escape the scanner through symlinks, oversized inputs, parser abuse, native code, or network callbacks.
9. The review service, signing key, policy, or revocation feed is compromised.

## Trust boundaries

- **Untrusted:** package source, tarballs, Git repositories, lockfiles supplied by the target, lifecycle scripts, native binaries, and network destinations.
- **Conditionally trusted:** registries, source hosts, CI builders, provenance issuers, and vulnerability feeds. Their evidence must be verified rather than accepted by name.
- **Trusted computing base:** the local verifier, policy evaluator, isolated scan worker, receipt verification key set, and the DSH admission integration.

## Security invariants

1. Unknown plugin code is never executed in the reviewer host context.
2. Resolution, scanning and installation remain bound to cryptographic digests.
3. A receipt identifies the complete resolved graph, scanner version, policy version, coverage and expiry.
4. Missing or failed checks cannot be represented as passed.
5. Loading verifies current bytes even when installation was bypassed.
6. Review credentials and user secrets are never mounted into a detonation environment.
7. Public reports redact local paths, credentials and proprietary source.
8. High-risk allow decisions require attributable human approval.

## Out of scope

- plugin usefulness, task success, latency, cost, and model/tool selection;
- proving that an artifact contains no malicious behavior;
- vulnerabilities in DSH itself unless they invalidate the admission boundary;
- runtime authorization of each tool call after an admitted plugin is loaded;
- protecting users who explicitly disable or bypass all enforcement points.

## Current prototype limitations

The v0.1 scanner only inspects a local directory. It does not yet resolve a dependency graph, verify registry signatures or provenance, compare source with a published artifact, run sandbox detonation, sign receipts, consume revocations, or integrate with DSH installation and boot.
