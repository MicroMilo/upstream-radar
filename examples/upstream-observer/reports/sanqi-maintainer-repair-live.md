# Live observer replay: maintainer repair before npm release

This is a real old → new observer run for
`@sanqi-normal/dsh-webui-market-plugin`. It demonstrates the useful case where
the source repository is fixed before the npm artifact is republished.

## Reproduction

The baseline was taken at the commit that produced the published `0.5.4`
artifact, then the same state was checked against the current `master`:

```bash
npx --yes upstream-radar@0.39.0 observe \
  https://github.com/Sanqi-normal/dsh-webui-market-plugin \
  --ref aa5f4efc7827176cce27c73f73a2f42514da1ebf \
  --state observations.json --report baseline.md --json

npx --yes upstream-radar@0.39.0 observe \
  https://github.com/Sanqi-normal/dsh-webui-market-plugin \
  --ref master \
  --state observations.json --report repair.md --json
```

No DSH Agent, model, plugin installation, or plugin execution was used.

## Observed change

```text
Source: aa5f4efc7827176cce27c73f73a2f42514da1ebf
     -> 8b328289ce5268451bd4414fa3ae41ee2f515649
Package: @sanqi-normal/dsh-webui-market-plugin@0.5.4
       -> @sanqi-normal/dsh-webui-market-plugin@0.5.4
Changed files: README.en.md, README.md, package.json
Runtime files: package.json
Reason: package manifest changed: peerDependencies
DSH task: upstream-task-d3a0f7dfce3fccc963472251
```

The repository has no committed npm or pnpm lockfile, so the report correctly
keeps dependency-graph coverage unavailable. It does not turn that missing
coverage into an empty vulnerability result.

The pending task is expected here: the source changed, but the npm version did
not. The observer therefore records the repair as an author-facing task and
waits for the next npm release instead of pretending the published artifact is
already fixed.

## Independent repair check

At commit `8b32828`, a clean resolver with lifecycle scripts disabled selected
`@deepseek-ai/dsh-client-runtime@0.1.0-rc.7`,
`@deepseek-ai/dsh-client-ui-slots@0.1.0-rc.7`, and
`@deepseek-ai/cordis@4.0.1`; it did not pull `@deepseek-ai/dsh-compact`.

I also retried the pending task with the configured issue-locator environment.
The model endpoint returned HTTP 404 on every supported OpenAI-compatible path,
so Radar kept the task pending and wrote no model conclusion. The static result
remains usable without a model; a later scheduled run can retry the same task.

The npm `latest` tag remains `0.5.4`, so the next scheduled observer run will
detect the release separately. This is the intended always-on loop:

```text
maintainer source fix
  → observer records old → new
  → pending DSH task
  → npm release appears
  → exact published artifact is rechecked
```
