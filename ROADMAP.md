# Roadmap

## Milestone 0 — local evidence prototype

- [x] Initialize a zero-runtime-dependency TypeScript CLI.
- [x] Hash a bounded local package tree deterministically.
- [x] Inspect lifecycle scripts, dependency specifications, native artifacts, package-manager hooks and symlinks.
- [x] Recognize a DSH bundle declaration.
- [x] Separate findings, coverage and policy verdict.
- [ ] Validate the prototype against a first corpus of public DSH plugins.

## Milestone 1 — exact published artifacts

- [x] Accept exact npm specs and local directories.
- [x] Download npm tarballs without lifecycle scripts and parse them under archive safety budgets.
- [x] Verify npm tarball integrity and ECDSA registry signatures.
- [x] Verify npm provenance through the official npm CLI in deep mode.
- [x] Resolve a deep-mode graph, compute its digest and summarize npm advisories.
- [ ] Accept Git commits and standalone tarball inputs.
- [ ] Generate CycloneDX SBOMs from the resolved graph.
- [ ] Query vulnerability and malicious-package intelligence.
- [ ] Compare npm tarballs with the declared source commit.
- [ ] Emit SARIF and a canonical JSON evidence bundle.

## Milestone 2 — DSH admission

- [ ] Resolve candidate DSH profile mutations in quarantine.
- [ ] Scan only new and changed artifacts from the candidate lock graph.
- [ ] Install the exact reviewed bytes with lifecycle scripts denied by default.
- [ ] Record `dsh-trust.lock` receipts atomically.
- [ ] Verify installed bytes before DSH profile load.
- [ ] Propose an upstream provider interface for third-party admission engines.

## Milestone 3 — isolation and receipts

- [ ] Run install/load detonation in disposable workers with canary files and controlled egress.
- [ ] Add source-to-build reproducibility evidence.
- [ ] Sign receipts through Sigstore-compatible identities.
- [ ] Support receipt expiry, transparency and revocation.
- [ ] Add policy-as-code and attributable exceptions.

## Milestone 4 — ecosystem service

- [ ] Continuously index public DSH plugins and releases.
- [ ] Publish exact-version reports with honest coverage labels.
- [ ] Add analyst review and coordinated disclosure workflow.
- [ ] Monitor maintainer, workflow, dependency and artifact anomalies.
- [ ] Generalize adapters for MCP servers, skills and other agent extensions.

Plugin quality benchmarks remain an independent concern throughout these milestones.
