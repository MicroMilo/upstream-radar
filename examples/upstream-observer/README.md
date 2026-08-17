# Upstream observer example

This example is the new upstream-change loop for DSH plugins:

```text
targets.yml
  ↓
GitHub commit + npm package metadata + optional lockfile
  ↓
observations.json
  ↓
old → new comparison
  ↓
only meaningful changes become DSH Agent tasks
```

The sample target points at the public Upstream Radar repository because Radar
is itself a DSH bundle. Replace it with the repositories your team depends on.

Run it locally from the repository root:

```bash
export GITHUB_TOKEN='a read-only token with repository metadata access'
pnpm run build
node dist/src/cli.js observe \
  examples/upstream-observer/targets.yml \
  --state /tmp/upstream-radar-observations.json \
  --report /tmp/upstream-radar-observer.md
```

The first run creates a baseline. Later runs compare the source commit, npm
version/integrity, package manifest, and the optional lockfile graph. A change
limited to README/docs/tests advances the observation point without creating a
DSH task. A runtime, DSH bundle, package entry, lockfile, dependency, or npm
integrity change creates one.

The copyable scheduled workflow is
[`../github-actions/upstream-observer.yml`](../github-actions/upstream-observer.yml).
The checked-in workflow is a dogfood example for the Radar repository itself: it
checks out and builds the local Radar source before running `observe`. For an
external repository, use a released version that contains `observe` and pin that
exact version. The workflow persists only `observations.json`; the report goes to
the GitHub Job Summary, so a quiet run does not create a daily commit.

## DSH Agent adapter

The observer does not guess an undocumented `dsh` CLI subcommand. When you have
a reviewed headless DSH wrapper, pass its executable explicitly:

```bash
node dist/src/cli.js observe examples/upstream-observer/targets.yml \
  --state observations.json \
  --dsh-agent-command /path/to/your-dsh-agent-wrapper \
  --dsh-agent-arg --json
```

Radar writes one read-only task prompt to the wrapper's stdin and expects one
JSON conclusion on stdout. It never invokes a shell, installs the observed
plugin, or executes repository code. Without this option, meaningful tasks stay
in `observations.json` and can be retried later with `--retry-pending`.
