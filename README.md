# Plugin Notary

**Know what enters your agent.**

Plugin Notary is a pre-install supply-chain review and admission layer for agent extensions. DeepSeek Harness plugins are the first integration target; MCP servers, skills, and other agent extension formats can reuse the same evidence model later.

The project deliberately separates two questions:

- **Supply-chain trust:** Is this exact artifact traceable, intact, reviewable, and acceptable under policy?
- **Plugin quality:** Does the plugin improve task outcomes? That requires a separate benchmark and is out of scope.

## Status

Early prototype. The current CLI performs a bounded, read-only static scan of a local package directory. It never imports plugin code, runs lifecycle scripts, or contacts remote services.

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

Provenance verification, source-to-tarball comparison, dependency resolution, sandbox detonation, signed review receipts, and DSH admission integration are planned rather than implied.

## Quick start

Requirements: Node.js 22 or newer and pnpm 11.3.0.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
node dist/src/cli.js scan /path/to/dsh-plugin
```

JSON output for CI or another admission client:

```bash
node dist/src/cli.js scan /path/to/dsh-plugin --json
```

The default command exits with code `2` when the admission verdict is `review` or `block`. Change the threshold with `--fail-on warn|review|block|never`.

The report carries three separate decisions:

- `riskVerdict`: the highest risk found by checks that actually ran;
- `coverageVerdict`: whether the required supply-chain review is complete;
- `verdict`: the stricter admission result across risk and coverage.

Because v0.1 does not yet verify provenance, compare source with a published artifact, or run sandbox detonation, its coverage is always `incomplete` and it cannot issue an admission `allow`. A clean static scan therefore means `riskVerdict: allow`, `verdict: review`.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `allow` | Required checks completed and policy found no reason to stop admission. |
| `warn` | Evidence should be shown to the installer. |
| `review` | Human or deeper isolated review is required before installation. |
| `block` | Default policy rejects the exact artifact. |

Reports distinguish findings from scan coverage. `not-checked` and `not-run` never mean passed.

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
