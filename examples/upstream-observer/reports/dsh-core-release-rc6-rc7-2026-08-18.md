# Official DSH: source release versus published package

This is a real old → new observation against the official
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
repository. It uses the historical commit that still declared DSH `rc.6` and
the current `master` commit that declares `rc.7`.

The run used no DSH package flags and no LLM configuration:

```bash
GITHUB_TOKEN='a read-only GitHub token' node dist/src/cli.js observe \
  https://github.com/deepseek-ai/deepseek-harness \
  --ref 8822d6744fb1289d85c2e067be9de068bf485860 \
  --state ./dsh-core-release-observations.json \
  --report ./dsh-core-release-before.md

GITHUB_TOKEN='a read-only GitHub token' node dist/src/cli.js observe \
  https://github.com/deepseek-ai/deepseek-harness \
  --ref 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca \
  --state ./dsh-core-release-observations.json \
  --report ./dsh-core-release-after.md
```

## Result

- Source: `8822d6744fb1289d85c2e067be9de068bf485860` → `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Automatically selected importer: `apps/cli/package.json`
- Source manifest: `@deepseek-ai/dsh@0.1.0-rc.6` → `@deepseek-ai/dsh@0.1.0-rc.7`
- Published npm metadata observed at both points: `@deepseek-ai/dsh@0.1.0-rc.7`
- Dependency graph: `32 nodes, 40 edges, 70 unresolved` → `32 nodes, 40 edges, 70 unresolved`
- Normalized dependency diff: no added or removed nodes, edges, or unresolved edges
- Runtime source changed: package manifests under the CLI, web app, root, and workspace packages
- Result: one meaningful pending task, `upstream-task-7b99edc9f280d7a84dc26d28`
- DSH Agent/LLM: not called; this result comes from the static observer only

The useful signal is the mismatch between source and npm history: the source
tree moved from `rc.6` to `rc.7`, while the published metadata was already
`rc.7` when both historical points were inspected. Radar reports the source
change and keeps the task pending; it does not pretend that a model has
explained the change or that a package install was performed.

This replay also caught and fixed a reporting bug. A root package version bump
changes the serialized root node ID, but it does not necessarily change the
dependencies below it. The observer now normalizes the root before comparing
edges, so this case does not falsely list the same five dependency edges as
both added and removed.

The graph still contains 70 local `workspace:`/`link:` edges. They remain
explicitly unresolved evidence and are not silently treated as published
packages.
