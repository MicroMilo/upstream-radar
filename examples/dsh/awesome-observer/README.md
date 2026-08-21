# awesome-dsh-plugin monitored cohort

This directory binds a small operational cohort to one immutable snapshot of
the public [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
catalog. The catalog is a discovery source, not a security review or an install
instruction.

## What was imported

[`cohort.json`](cohort.json) records the exact catalog commit and eight selected
repositories across seven DSH integration surfaces. Selection is intentionally
small enough that every identity can be checked before execution:

| Monitoring lane | Count | Targets |
| --- | ---: | --- |
| Source + npm coordinate + dependency graph + isolated install/load | 6 | Agent Teams, Better Sidebar, Context, Cost Meter, DSH Market, OpenPencil |
| Source + dependency graph only | 2 | dsh-browser, Aegis |

The two source-only targets are not evidence gaps accidentally presented as npm
packages. `dsh-browser` uses a repository-specific installer and its bridge
package is private. Aegis documents a GitHub install while the same unscoped npm
name belongs to another project. Radar therefore records their commits and
graphs but never executes an unrelated npm artifact.

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

The first observation of a repository is a baseline and does not execute code.
After that, a new exact DSH release tests all six npm targets; a new exact plugin
publication tests only its mapped target. Source-only commits remain static
analysis tasks. An unchanged run updates nothing and schedules no VM.

The initial compatibility baseline is dispatched explicitly once, using the
same isolated workflow that later scheduled changes use. Results are checked in
only after their exact DSH/plugin pairs and trace coverage have been reviewed.
