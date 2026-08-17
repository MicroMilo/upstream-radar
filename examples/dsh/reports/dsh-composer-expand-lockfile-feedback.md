# Maintainer feedback draft: dsh-composer-expand

Repository: [13071301808/dsh-composer-expand](https://github.com/13071301808/dsh-composer-expand)

This is a quality/monitoring issue, not a vulnerability report.

## Reproduction

At commit [`cb61627`](https://github.com/13071301808/dsh-composer-expand/commit/cb6162753f6f48923b19275008c9d7a87718068a):

```text
package.json                 version: 0.1.2
package-lock.json            root version: 0.1.0
package-lock.json packages[""].version: 0.1.0
pnpm-lock.yaml               present
```

From a clean checkout, the finding is reproducible without installing or
executing the plugin:

```bash
npx --yes upstream-radar@0.33.8 scan . --json
```

The current static scan reports:

```text
Finding: lockfile-root-metadata-stale (info)
Risk verdict: ALLOW
Coverage verdict: INCOMPLETE
```

The published artifact `dsh-composer-expand@0.1.2` has no confirmed known
dependency vulnerability in the checked graph. The finding only says that the
source lockfile metadata does not identify the same release as `package.json`.

## Why it matters to Upstream Radar

When a repository contains a stale root version, an upstream observer can attach
the dependency graph to `0.1.0` while the plugin source and published artifact
are `0.1.2`. That makes later vulnerability and upgrade reports harder to match
to the release a maintainer actually intended to ship.

## Smallest maintainer action

Choose the repository's canonical package manager. If `package-lock.json` is
kept, regenerate it from the current `package.json` with lifecycle scripts
disabled and review the complete diff; its root metadata should become `0.1.2`.
If pnpm is canonical, remove the stale npm lockfile instead of publishing two
competing dependency graphs.

This draft is ready to turn into an upstream issue or PR after maintainer
confirmation. The neutral confirmation issue is now published as
[13071301808/dsh-composer-expand#1](https://github.com/13071301808/dsh-composer-expand/issues/1).
No third-party repository files were modified by this scan.
