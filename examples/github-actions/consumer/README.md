# Consumer smoke: a real DSH plugin in GitHub Actions

This directory is a copyable consumer example for a DSH plugin project. It uses the real published `dsh-cloudflare-browser-run@0.1.1` package and its resolved dependency graph, rather than a fictional package name.

## Run the example

Copy these two files into a repository that has reviewed the corresponding DSH plugin graph:

- [`upstream-radar.config.json`](upstream-radar.config.json)
- [`upstream-radar.yml`](upstream-radar.yml) into `.github/workflows/`

The workflow runs on demand or weekly. It checks the committed graph against OSV and npm, and fails when an active high-or-higher vulnerability is present. It does not install the plugin, run lifecycle scripts, start DSH, or modify the repository.

To also fail when a confirmed or strong DSH/plugin compatibility break is found, add this input to the Action step:

```yaml
fail-on-compatibility: breaking
```

To test the published plugin bundle across exact DSH releases as well, add:

```yaml
probe-package: dsh-cloudflare-browser-run@0.1.1
probe-dsh-versions: 0.1.0-rc.3,0.1.0-rc.6
```

The optional probe is load-only. It packs with `--ignore-scripts`, uses a temporary profile per DSH version, and fails on `incompatible` or `unknown`; it does not prove package safety or plugin capability.

## Generate your own graph

For your project, generate the config from the actual DSH profile instead of copying this package's snapshot:

```bash
pnpm dlx --package=upstream-radar@0.28.0 upstream-radar init \
  --profile <dsh-profile> \
  --project-id <project-id> \
  --project-name "Your project" \
  --output ./upstream-radar.config.json \
  --dsh-patch ./upstream-radar.dsh.yml
```

Review the generated graph, commit the config, and then use the Action. The config is an evidence snapshot, not a safety certificate; the native DSH bundle remains the always-on path that refreshes the installed profile and routes model analysis. The compatibility gate is opt-in and does not replace that project-specific model analysis.

## What success means

The first run should show an independent frozen check with no DSH profile required on the runner. A source outage is a failed check, not a clean result. If the plugin or a transitive dependency becomes vulnerable, the workflow exits non-zero and preserves the exact package path in the JSON report.
