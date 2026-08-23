# awesome-dsh-plugin monitored cohort

This directory binds an operational 100-plugin cohort to one immutable snapshot of
the public [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
catalog. The catalog is a discovery source, not a security review or an install
instruction.

## What was imported

[`cohort.json`](cohort.json) records the exact catalog commit and 100 selected
repositories across all 21 catalog categories. Every executable entry was
included only after its catalog URL, source package name, npm package name and
npm repository metadata agreed:

| Monitoring lane | Count | Targets |
| --- | ---: | --- |
| Source + npm coordinate + dependency graph + isolated install/load | 96 | Exact npm artifacts selected for adoption and category coverage |
| Source + dependency graph only | 4 | dsh-browser, Aegis, Ouroboros DSH integration, API Relay Audit |

The four source-only targets are not evidence gaps accidentally presented as
npm packages. Their cataloged install paths are GitHub or repository-specific;
`dsh-browser` also has a private bridge package, while the unscoped `aegis` npm
name belongs to another project. Radar records their commits and graphs but
never substitutes an unrelated npm artifact.

The cohort is adoption-stratified, not simply the first 100 directory rows. It
prioritizes downloads and Stars, limits one entry per repository, eight per
category and four per owner, and still covers every category. The second 50
were accepted only when the catalog URL, source `package.json`, npm package
name and npm `repository` metadata all pointed to the same project.

The expansion is reproducible. Given the catalog's checked-out commit and its
generated `plugins.json`, this command fills the bounded cohort without
executing target code:

```bash
GITHUB_TOKEN=... pnpm expand:dsh-cohort -- \
  /path/to/plugins.json /path/to/awesome-dsh-plugin 100
```

It rejects identity drift, archived repositories, missing DSH contracts,
non-exact versions and Node requirements outside the maintained runtimes
before writing any target files.

## How the loop closes

```text
pinned catalog entry
  -> examples/upstream-observer/targets.yml
  -> daily source, npm and lockfile observation
  -> persisted old -> new coordinate
  -> exact affected target selection
  -> one secret-free hosted VM per npm plugin
  -> install/register/load report against the changed DSH release
```

Every daily pass reconciles the current matrix, not only repository diffs.
Missing, stale or statically invalidated npm cells are scheduled even when no
new release appeared. A new exact DSH release invalidates every executable
cell; a new plugin publication invalidates only its mapped cell. Source-only
commits remain static analysis tasks. A run with fresh unchanged evidence
schedules no VM.

## Consumer feed

The maintained ledger is joined back to the pinned catalog identities as a
[machine-readable compatibility feed](../../../feeds/dsh-plugin-compatibility.json)
and a [human-readable snapshot](../../../feeds/dsh-plugin-compatibility.md).
The feed preserves exact plugin, DSH, Node, profile, artifact digest and expiry
instead of stamping a timeless pass/fail badge onto a repository. A headless
peer-contract gap is explicitly `needs-review`, not an author defect, until its
intended web execution plane has also been observed.
