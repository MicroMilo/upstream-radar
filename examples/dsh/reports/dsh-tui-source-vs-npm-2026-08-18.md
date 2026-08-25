# DSH-TUI source tree vs published npm artifact

Date: 2026-08-18

This is a real comparison for
[`ccch1mneyyy/dsh-TUI`](https://github.com/ccch1mneyyy/dsh-TUI), current source
commit [`2143ce1`](https://github.com/ccch1mneyyy/dsh-TUI/commit/2143ce17b3c2a538d6bceebb20901ff270ed3a9c),
and the exact published package
[`@deepseek-harness-tui/dsh-tui@0.8.0`](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui/v/0.8.0).

No DSH profile, plugin code, lifecycle script, or LLM was started.

## Commands

```bash
npx --yes upstream-radar@0.43.5 scan \
  https://github.com/ccch1mneyyy/dsh-TUI \
  --fail-on never

npx --yes upstream-radar@0.43.5 inspect \
  npm:@deepseek-harness-tui/dsh-tui@0.8.0 \
  --deep --fail-on never
```

The source scan used the current Radar branch, including the pnpm explicit-key
parser fix. Before that fix, Radar incorrectly treated the valid pnpm lockfile
as unavailable; pnpm 11 accepted the same lockfile with
`pnpm install --lockfile-only --ignore-scripts --frozen-lockfile`.

## Source repository result

- DSH bundle: detected.
- Lockfile: `pnpm-lock.yaml` parsed successfully.
- Dependency graph: 363 nodes, 1,497 edges, 2 unresolved optional edges.
- Install-time script: `prepare: npm run compile`.
- No vulnerability conclusion was made from this source-only scan.

The two unresolved edges are optional `ws` platform packages, not a confirmed
vulnerability. The source result is `REVIEW / INCOMPLETE` because the package
contains an install-time build hook and the graph has optional coverage gaps.

## Published npm result

- Exact artifact integrity: verified.
- npm registry signature: verified.
- npm provenance: verified.
- Lifecycle scripts in the tarball: none.
- Dependency resolution: verified, 120 packages.
- Known vulnerabilities from the implemented checks: 0.
- Source/artifact match: not checked.

The published artifact is `REVIEW / INCOMPLETE` only because the artifact-level
coverage does not prove source/artifact identity and retains optional dependency
coverage gaps. It is not reported as vulnerable.

## What this proves

Scanning only the Git repository would overstate the risk of the package users
actually install: the source `prepare` hook is absent from the npm tarball.
Scanning only npm would miss the repository's lockfile and build-process change.
Upstream Radar keeps both observations separate so an author can investigate the
right release boundary instead of receiving a generic “plugin unsafe” label.
