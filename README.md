# Plugin Notary

**Know what enters your agent.**

Plugin Notary is a pre-install supply-chain review and admission layer for agent extensions. DeepSeek Harness plugins are the first integration target; MCP servers, skills, and other agent extension formats can reuse the same evidence model later.

The project deliberately separates two questions:

- **Supply-chain trust:** Is this exact artifact traceable, intact, reviewable, and acceptable under policy?
- **Plugin quality:** Does the plugin improve task outcomes? That requires a separate benchmark and is out of scope.

## Status

Early prototype. The CLI can inspect a local directory or fetch an exact public npm release. It never imports plugin code or runs package lifecycle scripts. Deep npm review resolves dependencies in a temporary project with scripts disabled and delegates cryptographic attestation verification to the official npm CLI.

Implemented evidence includes:

- deterministic directory artifact digest;
- install-time lifecycle scripts;
- mutable Git, URL, and floating dependency specifications;
- lockfile presence;
- bundled dependencies;
- native executable artifacts;
- symlinks that escape the reviewed package;
- package-local pnpm hooks and npm credential/configuration risks;
- DSH bundle manifest recognition;
- explicit coverage gaps in every report.

Exact npm inspection additionally provides:

- registry tarball integrity verification;
- npm ECDSA registry-signature verification;
- safe in-memory tar parsing before materialization;
- SLSA provenance verification and source identity extraction in deep mode;
- resolved dependency-graph digest and npm advisory summary in deep mode.

Source-to-tarball rebuilding, sandbox detonation, signed review receipts, and DSH admission integration are planned rather than implied.

## Quick start

Requirements: Node.js 22 or newer and pnpm 11.3.0. Deep inspection also invokes the locally installed npm CLI; a current npm release is recommended so attestation details can be returned.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
node dist/src/cli.js scan /path/to/dsh-plugin
node dist/src/cli.js inspect npm:dsh-cloudflare-browser-run@0.1.1 --deep
```

JSON output for CI or another admission client:

```bash
node dist/src/cli.js scan /path/to/dsh-plugin --json
node dist/src/cli.js inspect npm:dsh-cloudflare-browser-run@0.1.1 --deep --json
```

Run the complete live and deterministic demonstration with `pnpm showcase`. See [the showcase guide](docs/showcase.md).

The default command exits with code `2` when the admission verdict is `review` or `block`. Change the threshold with `--fail-on warn|review|block|never`.

The report carries three separate decisions:

- `riskVerdict`: the highest risk found by checks that actually ran;
- `coverageVerdict`: whether the required supply-chain review is complete;
- `verdict`: the stricter admission result across risk and coverage.

Version 0.2 can verify npm integrity, registry signatures, provenance and the currently resolved dependency graph. It does not yet rebuild the declared source or run isolated install/load detonation, so overall coverage remains `incomplete` and it cannot issue an admission `allow`. A clean implemented scan therefore means `riskVerdict: allow`, `verdict: review`.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `allow` | Required checks completed and policy found no reason to stop admission. |
| `warn` | Evidence should be shown to the installer. |
| `review` | Human or deeper isolated review is required before installation. |
| `block` | Default policy rejects the exact artifact. |

Reports distinguish findings from scan coverage. `not-checked` and `not-run` never mean passed.

`staticSource: complete` means every in-scope file was hashed and all currently implemented static checks ran within budget. It does not mean the source was proved non-malicious; that gap remains visible in the overall coverage and admission verdict.

## Intended DSH flow

```text
dsh plugin add
  -> resolve candidate graph in quarantine
  -> fetch without lifecycle scripts
  -> collect and review supply-chain evidence
  -> apply policy
  -> install the exact reviewed bytes
  -> record a signed receipt
  -> verify the receipt again before plugin load
```

Plugin Notary must eventually integrate before pnpm executes, not merely after DSH activates a bundle.

## Project documents

- [Chinese product vision](docs/vision.zh-CN.md)
- [Chinese check matrix](docs/checks.zh-CN.md)
- [Threat model](docs/threat-model.md)
- [Architecture](docs/architecture.md)
- [Roadmap](ROADMAP.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Design principles

1. Review an exact artifact digest, never a package name in the abstract.
2. Evidence and policy are separate: scanners report facts; organizations decide admission.
3. Missing coverage is explicit and cannot silently become a pass.
4. The bytes scanned must be the bytes installed.
5. Installation and load are both admission boundaries.
6. Deterministic checks make decisions; AI may explain findings but cannot independently issue an allow verdict.
7. The scanner itself keeps zero runtime dependencies.

## License

Apache-2.0.
