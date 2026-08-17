# DSH core nested-workspace observer case

Date: 2026-08-18

Target: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)

Package: `@deepseek-ai/dsh@0.1.0-rc.7`

Source package path: `apps/cli/package.json`

## The bug this caught

The DSH CLI is a workspace package under `apps/cli`, while its lockfile is at
the repository root. A workspace lockfile has more than one importer:

```text
importers:
  .:
  apps/cli:
```

The old observer always read importer `.`. That could produce a graph for the
repository root while labeling it as `@deepseek-ai/dsh`, which is a wrong
monitoring result.

## Result after the fix

The observer now derives the importer from `packagePath` and reads `apps/cli`:

```text
source commit: 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
package: @deepseek-ai/dsh@0.1.0-rc.7
graph root: pnpm:workspace-root:@deepseek-ai/dsh@0.1.0-rc.7
resolved nodes: 32
resolved edges: 40
unresolved edges: 70
  runtime: 58
  development: 12
graph error: none
```

The unresolved edges are the DSH repository's `workspace:`/`link:` packages,
such as `@deepseek-ai/dsh-base` and the Cordis workspace packages. They remain
visible as unresolved instead of being assigned guessed registry versions.
The external packages in the selected CLI importer are still represented in
the graph, including `commander`, `js-yaml`, `execa`, and
`node-addon-require-builtin`.

## Why this matters

This lets the always-on observer monitor the DSH CLI's actual source package
and its published npm release together, while showing exactly where a
workspace build prevents complete third-party coverage. It does not start DSH,
install workspace packages, execute code, or call an LLM.
