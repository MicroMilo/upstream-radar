# Upstream observer example

This example is the new upstream-change loop for DSH plugins:

```text
targets.yml
  ↓
GitHub commit + npm package metadata + auto-detected or explicit lockfile
  ↓
observations.json
  ↓
old → new comparison
  ↓
only meaningful changes review the exact artifact and optionally load it across DSH releases
  ↓
DSH Agent task
```

The sample target points at the real public DSH/Feishu plugin
[`PlutoKeating/dsh-lark-bot`](https://github.com/PlutoKeating/dsh-lark-bot), so a
first run produces a real dependency graph instead of a synthetic fixture.
Replace it with the repositories your team depends on.

For one repository, the shortest path skips YAML and lockfile configuration entirely:

```bash
npx --yes upstream-radar@0.42.0 observe \
  https://github.com/PlutoKeating/dsh-lark-bot \
  --state /tmp/upstream-radar-observations.json \
  --report /tmp/upstream-radar-observer.md
```

Radar automatically chooses the committed `pnpm-lock.yaml` or
`package-lock.json`. This public example has a different npm package name, so
the explicit form below adds `--package`:

```bash
npx --yes upstream-radar@0.42.0 observe \
  https://github.com/PlutoKeating/dsh-lark-bot \
  --package dsh-feishu-bot \
  --lockfile pnpm-lock.yaml --lockfile-type pnpm \
  --state /tmp/upstream-radar-observations.json \
  --report /tmp/upstream-radar-observer.md
```

The first run creates the baseline. Re-run the same command from a scheduled
job to compare the latest `main` commit. For a DSH repository, Radar looks up
to three directory levels deep for one DSH bundle or one `@deepseek-ai/dsh`
package; use `--package-path` when the repository is ambiguous, `--package`
when its npm name differs from `package.json`, and `--ref` when replaying a
specific commit. See the [official DSH one-command case](reports/dsh-core-auto-discovery-2026-08-18.md).

For a real end-to-end replay against a public DSH/Feishu plugin, see
[`cases/dsh-feishu-bot.md`](cases/dsh-feishu-bot.md). It demonstrates baseline →
real upstream commit → dependency graph diff → pending DSH task without a DSH
LLM configuration.

The latest replay with the available issue-locator `.env` is recorded in
[`reports/dsh-feishu-bot-model-replay-2026-08-18.md`](reports/dsh-feishu-bot-model-replay-2026-08-18.md).
It shows the exact author-review output and records the model endpoint failure
without treating the pending task as a successful analysis.

Every observation also emits an upstream/downstream alignment IR. It compares
the Git source coordinate, the observed npm coordinate, and the lockfile graph
root before an Agent is involved. The live target is intentionally useful here:
the source says `dsh-lark-bot@0.15.8`, npm publishes
`dsh-feishu-bot@0.15.8`, and the graph root follows the source name. Radar
reports `mismatch` with an author-facing mapping fix; it does not call this
malware or pretend that the bundle is incompatible. A missing lockfile is
reported as `unknown`, never as a clean dependency graph.

## Route upstream changes to downstream plugins

Build one index from saved DSH plugin scan/review/config JSON, then give it to
the observer:

```bash
npx --yes upstream-radar@0.42.0 graph reverse ./plugin-reports \
  --output ./reverse-dependency-index.json
npx --yes upstream-radar@0.42.0 observe ./targets.yml \
  --reverse-index ./reverse-dependency-index.json \
  --state /tmp/upstream-radar-observations.json \
  --report /tmp/upstream-radar-observer.md
```

The match is by package name, so an upstream `parser@1.0.0` → `parser@2.0.0`
change can find plugins that still use `parser@1.0.0`. The report includes the
exact downstream path and whether that plugin's graph was complete. It is a
static impact signal, not a claim that the plugin is already broken.

This repository also contains the first real 50-plugin DSH corpus collected
from the public plugin registry. It has 50 source scans, 30 exact npm artifact
reviews, and a checked-in reverse index for the 37 plugins whose graphs could
be reconstructed. The 13 skipped targets remain visible as missing evidence,
not clean results. See [`../dsh/first-batch/README.md`](../dsh/first-batch/README.md)
and run `pnpm run showcase:observer` to replay a real
`@deepseek-ai/cordis` old → new route against that index.

The scheduled workflow uses the checked-in index directly:

```bash
npx --yes upstream-radar@0.42.0 observe ./targets.yml \
  --reverse-index ../dsh/first-batch/reverse-dependency-index.json \
  --state /tmp/upstream-radar-observations.json \
  --report /tmp/upstream-radar-observer.md
```

The deterministic closed-loop result is recorded in
[`reports/dsh-feishu-bot-artifact-review-2026-08-18.md`](reports/dsh-feishu-bot-artifact-review-2026-08-18.md):
the same old → new run now reviews `dsh-feishu-bot@0.15.8`, finds its reachable
`protobufjs@7.6.5` install script, and keeps the DSH task pending because no
DSH LLM is configured.

The checked-in DSH target now sets `dshVersions` to `0.1.0-rc.7` and
`0.1.0-rc.8`. On a meaningful change, the observer loads the same exact npm
artifact in both disposable profiles and writes the matrix into the same
report. The linked historical replay loaded rc.6 and rc.7 successfully (`2/2`);
that remains a bundle-load compatibility result, not a safety certificate.

To replay the complete state machine without network access, run
`pnpm run showcase:observer`. It prints a baseline alignment mismatch, one
meaningful old → new change with one Agent call, the downstream `parser`
impact, and a quiet third run with no new task.

Run it from any directory with the published CLI:

```bash
export GITHUB_TOKEN='a read-only token with repository metadata access'
npx --yes upstream-radar@0.42.0 observe \
  /path/to/targets.yml \
  --state /tmp/upstream-radar-observations.json \
  --report /tmp/upstream-radar-observer.md
```

For the checked-in public target, replace `/path/to/targets.yml` with
`examples/upstream-observer/targets.yml`. Contributors can use `pnpm run build`
and `node dist/src/cli.js observe` instead.

The first run creates a baseline. Later runs compare the source commit, npm
version/integrity, package manifest, and the auto-detected or explicit lockfile
graph. A change
limited to README/docs/tests advances the observation point without creating a
DSH task. A runtime, DSH bundle, package entry, lockfile, dependency, or npm
integrity change creates one. When that change has a published npm version, the
same run performs a deep static review of the exact artifact: it resolves the
dependency graph with lifecycle scripts disabled, checks known vulnerabilities,
and records reachable
install-time scripts and unresolved edges in the report and pending task. The
scheduled workflow also uses
`--retry-pending`, so a task left behind by a temporarily unavailable Agent is
retried on the next run without needing a new upstream commit.

Targets observe npm's `latest` dist-tag by default. Set `package-tag: next` (or
another explicit lowercase dist-tag) when the upstream publishes the channel
you maintain outside `latest`. The checked-in DSH runtime target uses `next` so
`0.1.1-rc.1` is not silently replaced by the older `latest` value
`0.1.0-rc.7`. The selected tag is persisted with the exact package coordinate.
If all evidence is unchanged, the durable snapshot keeps its prior timestamp;
the run report still has a fresh check time, but cron does not create a noise
commit or re-report an unchanged drift condition.

At the time this example was recorded, the target resolved to 242 dependency
nodes and 380 edges. Radar also reported that the source manifest is named
`dsh-lark-bot` while the published package is `dsh-feishu-bot`; it keeps that
fact as a warning instead of silently treating the two names as identical.

The copyable scheduled workflow is
[`../github-actions/upstream-observer.yml`](../github-actions/upstream-observer.yml).
The checked-in workflow runs the local Radar source against this external public
target, so it is both a dogfood workflow and a real plugin example. For a
different external repository, use a released version that contains `observe`
and pin that exact version. The workflow persists only `observations.json`; the
report goes to the GitHub Job Summary, so a quiet run does not create a daily
commit.

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
in `observations.json` and can be retried later with `--retry-pending`. If a
configured model temporarily fails, the static observation still exits
successfully; the report records the failed attempt and keeps the task pending.

If DSH is not configured with an LLM wrapper yet, use the existing
issue-locator/OpenAI-compatible `.env` file as the explicit model entry point:

```bash
node dist/src/cli.js observe examples/upstream-observer/targets.yml \
  --state observations.json \
  --llm-env-file /path/to/issue-locator/.env
```

The observer reads only the endpoint, API key, and model name for the request;
none of them are persisted. It calls the model only for meaningful upstream
changes. If the endpoint fails, the task stays pending and can be retried with
`--retry-pending`.
