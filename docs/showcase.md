# Showcase

The showcase demonstrates four distinct outcomes without ever executing fixture plugin code.

```bash
pnpm showcase
```

Generate committed-ready JSON and text evidence under `examples/reports/` with:

```bash
pnpm showcase:reports
```

The first case uses the immutable public release `dsh-cloudflare-browser-run@0.1.1`. Plugin Notary:

1. resolves the exact npm version;
2. downloads the registry-declared tarball;
3. verifies its SHA-512 subresource integrity;
4. verifies the npm ECDSA registry signature;
5. parses the tar archive under file, byte and path budgets;
6. recognizes its DSH bundle manifest;
7. resolves dependencies with lifecycle scripts disabled;
8. asks the official npm verifier to validate registry signatures and SLSA provenance;
9. extracts the signed source repository, commit and build workflow;
10. computes a digest for the resolved graph and reports known vulnerabilities.

Expected chain-of-custody evidence:

```text
Target: dsh-cloudflare-browser-run@0.1.1
Artifact: sha256:27fe660b2fe40b15b70a206310b883ca15722d8ffaacab63232b71128d28701f
DSH bundle: yes (./cordis.patch.yml)
Admission verdict: REVIEW
Risk verdict: ALLOW
Coverage verdict: INCOMPLETE

npm chain of custody:
  tarball integrity: verified (sha512)
  registry signature: verified
  provenance: verified
  dependency audit: verified
  resolved packages: 18
  source repository: https://github.com/RealAlexandreAI/dsh-cloudflare-browser-run
  source commit: f85ec677f77665640315d89aebe876b4877995bd
  build workflow: .github/workflows/publish.yml
  known vulnerabilities: 0 total (0 critical, 0 high)
```

The final admission result deliberately remains `REVIEW`: source-to-artifact rebuilding and isolated install/load detonation have not run. A clean implemented check is not silently promoted into complete coverage.

The tarball digest and signed source identity are fixed for this exact release. The dependency graph is resolved at demonstration time; its digest can change if a declared dependency range later selects different transitive bytes. The report records that graph so the observation remains explicit.

The remaining cases are deterministic local fixtures:

- `clean-dsh-plugin`: `riskVerdict=allow`, but incomplete evidence keeps admission at `review`;
- `review-install-script`: a `prepare` script makes `riskVerdict=review`;
- `block-remote-shell`: `curl ... | sh` makes both risk and admission `block`.

For a network-free demonstration:

```bash
pnpm showcase -- --offline
```

The deep npm path uses a fresh temporary project, a scrubbed environment, controlled npm/Git configuration and `ignore-scripts=true`. It is an evidence collector, not yet the stronger microVM detonation planned for a later milestone.
