# Contributing

Plugin Notary is in an early design phase. Changes should preserve the invariants in `docs/threat-model.md` and include tests for new rules or parsers.

## Development

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run scan:self
```

The repository intentionally denies dependency lifecycle scripts through `.npmrc` and keeps zero runtime dependencies. A proposal to add a runtime dependency should explain why a small audited implementation or platform primitive is insufficient.

## Finding design

- Report observable evidence, not intent.
- Keep finding codes stable and machine-readable.
- Include remediation without claiming that remediation proves safety.
- Distinguish `finding`, `unknown`, and incomplete coverage.
- Avoid popularity, star count, or publisher reputation as a substitute for integrity evidence.

## Pull requests

- Add tests for positive, negative and incomplete-coverage cases.
- Document false-positive and false-negative boundaries.
- Do not include real credentials or live malicious payloads in fixtures.
- Pin workflow actions and development dependencies to reviewed versions.
