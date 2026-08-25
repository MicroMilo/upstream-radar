# Public GitHub URL case: nested DSH plugin discovery

This is a real end-to-end static scan of a public DSH plugin repository. The
repository root does not contain `package.json`; the plugin is under `plugin/`.
The plugin also commits a pnpm lockfile, so Radar can reconstruct the dependency
graph without installing anything.

## Reproduction

```bash
npx --yes upstream-radar@0.45.0 scan \
  https://github.com/2008924/dsh-progress-viz \
  --fail-on never
```

The command shallow-clones the current public branch into a temporary directory,
finds the unique DSH package within three levels, and scans `plugin/`. It does
not install dependencies, run lifecycle scripts, load plugin code, start DSH,
query an advisory service, or call an LLM.

## Observed result

```text
Reading 2008924/dsh-progress-viz (plugin directory: plugin) without installing dependencies or running code...
Upstream Radar 0.42.0
Target: dsh-progress-viz-plugin@0.1.0
Artifact: sha256:c9b6b2dc31a458b480587f6200772fe72d4af5451b1e71d41594c5017be929c5
DSH bundle: yes (./cordis.patch.yml)
Admission verdict: REVIEW
Risk verdict: ALLOW
Coverage verdict: INCOMPLETE

Dependency graph:
  source: pnpm-lock
  root: dsh-progress-viz-plugin@0.1.0
  nodes: 16
  edges: 35
  unresolved: 2

No findings in the implemented static checks.

Next step: Coverage is incomplete; do not treat an empty finding list as an allow decision.
```

## What this proves

- A user can give Radar a GitHub repository URL without manually cloning it or
  knowing the plugin subdirectory.
- A committed pnpm lockfile becomes a real graph with exact nodes, edges, and
  unresolved optional edges in the same report.
- The scanner correctly separates “no current static finding” from “safe”: the
  graph is complete enough to inspect but coverage remains bounded, so the final
  admission remains `REVIEW`.
- The repository shape is handled without installing or executing untrusted
  code.
