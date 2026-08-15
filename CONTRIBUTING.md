# Contributing

Upstream Radar is in an early design phase. Changes should preserve the invariants in `docs/threat-model.md` and include tests for new sources, parsers, matching rules, state transitions, or DSH delivery behavior.

## Development

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run scan:self
pnpm run showcase:radar
```

To try the DSH-first setup against a disposable profile, install a bundle and generate the inventory:

```bash
dsh plugin --profile contributor-qa add dsh-cloudflare-browser-run@0.1.1
pnpm dlx upstream-radar@latest init \
  --profile contributor-qa \
  --project-name "Contributor QA" \
  --workspace "$PWD" \
  --output ./upstream-radar.config.json
```

The default generated graph is a reviewable view of the profile's installed `node_modules` tree. A profile that has unresolved declarations keeps them as incomplete coverage; this includes peer packages supplied by a DSH host outside the profile. Pass `--registry <url>` only when you intentionally want to compare against public npm resolution.

The repository intentionally denies dependency lifecycle scripts through `.npmrc` and keeps zero runtime dependencies. A proposal to add a runtime dependency should explain why a small audited implementation or platform primitive is insufficient.

## Event and finding design

- Match exact versions deterministically; do not delegate applicability to a model.
- Treat every feed and release string as untrusted data.
- Emit state transitions, not the same active condition on every poll.
- Preserve project, plugin and dependency-path attribution.
- Label compatibility heuristics as `needs-analysis`.
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
