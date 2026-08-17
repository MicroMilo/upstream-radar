# DSH Feishu bot: live upstream observation

Run date: 2026-08-18

Repository: [PlutoKeating/dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot)

## What actually ran

The observer replayed the public repository change:

- [`43f0e65`](https://github.com/PlutoKeating/dsh-lark-bot/commit/43f0e65daf5df8b51d101725ff2267ffd6c5e06c)
  → [`c2f8cf7`](https://github.com/PlutoKeating/dsh-lark-bot/commit/c2f8cf77b0ec2cb3ced400da4a4b67dffb27c2ee)
- published package: `dsh-feishu-bot@0.15.4`
- package and lockfile were read from GitHub; the plugin was not installed or executed

The observer found one meaningful upstream change:

```text
dependency graph: 242 nodes, 378 edges, 7 unresolved
             -> 242 nodes, 380 edges, 7 unresolved

added runtime edges:
  dsh-lark-bot@0.5.1 -> @deepseek-ai/cordis@4.0.1
  dsh-lark-bot@0.5.1 -> @deepseek-ai/dsh-tools@0.1.0-rc.6

changed runtime files:
  package.json
  pnpm-lock.yaml
  src/adapters/dsh/*
  src/notify/*
```

The source manifest is named `dsh-lark-bot`, while the published npm package
is named `dsh-feishu-bot`. Radar keeps this as a warning rather than calling it
a vulnerability.

## Model and DSH truth

Two different paths were tested and must not be confused:

1. `observe --llm-env-file /Users/deng/Desktop/work/modelbest/issue-locator/.env`
   attempted the model call directly through the OpenAI-compatible endpoint.
   It is not a DSH-native LLM configuration. The endpoint returned HTTP 404,
   so the DSH analysis task stayed pending.
2. A native DSH headless run without a temporary model stub stopped with
   `MISSING_CREDENTIAL`: no `DEEPSEEK_API_KEY` was configured.

Therefore this live run proves:

- real public DSH plugin change detected: **yes**;
- exact dependency graph and change task built: **yes**;
- model analysis through the configured `.env`: **no, endpoint returned 404**;
- native DSH model analysis: **no, credentials were not configured**.

## Separate DSH handoff proof

The repository also contains a deterministic local-model DSH headless proof for
the real [`dsh-web-ui` issue #71](https://github.com/zhu1090093659/dsh-web-ui/issues/71):

[dsh-web-ui-public-case.json](../../dsh/reports/dsh-web-ui-public-case.json)

That run loaded the packed Radar plugin into `@deepseek-ai/dsh@0.1.0-rc.6`,
delivered the Radar task to DSH, consumed one structured analysis result, and
wrote it back with zero pending tasks. Its model is explicitly a local
deterministic stub, so it proves handoff and persistence only—not real model
quality.

## Honest product conclusion

The static observer path is closed on a real upstream DSH plugin. The real-model
path is not closed yet because the available endpoint is currently unreachable
and native DSH has no credential. No successful DSH model result is claimed by
this report.
