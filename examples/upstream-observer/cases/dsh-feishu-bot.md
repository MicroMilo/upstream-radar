# Real DSH plugin upstream case

This is a replay of one real commit from the public DSH/Feishu plugin
repository [PlutoKeating/dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot).
It uses the published npm name `dsh-feishu-bot` and does not install or execute
the plugin.

## Replayed change

- Baseline: [`43f0e65`](https://github.com/PlutoKeating/dsh-lark-bot/commit/43f0e65daf5df8b51d101725ff2267ffd6c5e06c)
- Candidate: [`c2f8cf7`](https://github.com/PlutoKeating/dsh-lark-bot/commit/c2f8cf77b0ec2cb3ced400da4a4b67dffb27c2ee), `feat: outbound mentions and cross-session notifications with a lark_notify dsh tool`

Run the two observations with the same state file:

```bash
export GITHUB_TOKEN='a read-only GitHub token'
npx --yes upstream-radar@0.33.8 observe \
  examples/upstream-observer/cases/dsh-feishu-bot-before.yml \
  --state /tmp/upstream-radar-dsh-feishu-bot.json

npx --yes upstream-radar@0.33.8 observe \
  examples/upstream-observer/cases/dsh-feishu-bot-after.yml \
  --state /tmp/upstream-radar-dsh-feishu-bot.json
```

## Result

The second run produced one meaningful change:

```text
Source: 43f0e65... → c2f8cf7...
Graph: 242 nodes, 378 edges, 7 unresolved → 242 nodes, 380 edges, 7 unresolved
Manifest fields: dependencies
Added runtime dependency edges:
  dsh-lark-bot@0.5.1 -> @deepseek-ai/cordis@4.0.1
  dsh-lark-bot@0.5.1 -> @deepseek-ai/dsh-tools@0.1.0-rc.6
Runtime files include:
  package.json, pnpm-lock.yaml, src/adapters/dsh/*, src/notify/*
DSH task: upstream-task-b958af9ee8c9cc9eac36fb33
Exact artifact check:
  npx --yes upstream-radar@latest inspect npm:dsh-feishu-bot@0.15.3 --deep
Coverage warning: 7 dependency edge(s) are unresolved; an empty vulnerability
list would be incomplete.
```

The observer reported `DSH Agent: not configured` and kept the task pending.
That is intentional: this case proves the static observation and routing path,
not a model analysis that was never configured.

## What an author can fix or verify

The plugin author can review the two newly declared DSH runtime dependencies,
the lockfile update, and the changed DSH runtime files before publishing the
next package. Radar does not call this a vulnerability by itself; it gives the
author an exact upstream change and dependency edges that need verification.

The source manifest is named `dsh-lark-bot` while the published package target
is `dsh-feishu-bot`, so the report also keeps that naming mismatch visible for
the author to confirm. It is a warning, not an automatic failure.
