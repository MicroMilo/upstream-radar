# Real DSH plugin change: author-review output

This is a fresh replay of the public `PlutoKeating/dsh-lark-bot` change using
the exact observer command and the issue-locator `.env` file supplied locally.
The repository and package were not installed or executed.

## Result

```text
Source: 43f0e65... → c2f8cf7...
Graph: 242 nodes, 378 edges, 7 unresolved → 242 nodes, 380 edges, 7 unresolved
Meaningful change: yes
DSH task: upstream-task-c6134ba72fae177456a80d27
```

The newly added runtime edges are:

```text
dsh-lark-bot@<root> → @deepseek-ai/cordis@4.0.1
dsh-lark-bot@<root> → @deepseek-ai/dsh-tools@0.1.0-rc.6
```

The changed runtime surface includes `package.json`, `pnpm-lock.yaml`, the DSH
runtime adapters, the Feishu bridge, notification commands, and the notify
server. The source manifest is `dsh-lark-bot@0.5.1`, while the published npm
target is `dsh-feishu-bot@0.15.8`; Radar keeps that naming/version drift visible
instead of silently treating the source and artifact as the same thing.

The exact next check emitted for the author is:

```text
npx --yes upstream-radar@latest inspect npm:dsh-feishu-bot@0.15.8 --deep
```

Because 7 graph edges remain unresolved, an empty vulnerability list would be
incomplete. The author-facing action is therefore to review the two new DSH
runtime edges, resolve the missing graph edges, and compare the exact published
artifact before calling the change safe.

## Model truth

The `.env` file was found and loaded: model configuration was present. The
OpenAI-compatible request was attempted once, but every known endpoint returned
HTTP 404:

```text
https://llm-center.ali.modelbest.cn/llm/v1/chat/completions
https://llm-center.ali.modelbest.cn/llm/openai/v1/chat/completions
```

No model conclusion is claimed. The task remains pending for a later retry.
The static dependency-change result above is still valid and independently
actionable.
