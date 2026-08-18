# Official DSH CLI: one-command observer case

This is a real baseline against
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
It was run from the Upstream Radar branch containing the automatic DSH package
discovery change. No `--package`, `--package-path`, or `--lockfile` was passed.

```bash
GITHUB_TOKEN='a read-only GitHub token' node dist/src/cli.js observe \
  https://github.com/deepseek-ai/deepseek-harness \
  --ref master \
  --state ./dsh-core-observations.json \
  --report ./dsh-core-observer.md
```

## Result

- Source commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Automatically selected package: `apps/cli/package.json`
- Package: `@deepseek-ai/dsh@0.1.0-rc.7`
- Automatically selected lockfile: `pnpm-lock.yaml`
- Dependency graph: 32 nodes, 40 edges
- Unresolved evidence: 70 local workspace edges
- First run: baseline created, no Agent or LLM call
- Errors: none

The important result is not the node count. It is that a user can point Radar
at the official DSH repository and get the CLI's real workspace importer rather
than silently monitoring the repository root. Local `workspace:` links remain
explicitly unresolved; Radar does not guess their published versions.

This report was produced by the current branch, not the already published
`upstream-radar@0.36.0`. Review the Draft PR before using the auto-discovery
path from npm.
