# DSH execution-plane observer

This cohort closes two evidence gaps left by a headless profile:

- `dsh-univer-office` runs in the official DSH Web profile under Chromium. Radar requires the page root, boot-manifest row, exact client bundle, and materialized module.
- `@deepseek-harness-tui/dsh-tui` runs in a real pseudo-terminal. Radar requires a rendered frame, bounded input, and the documented double-Ctrl-C shutdown.

The planner derives the exact plugin artifact, DSH version, and Node major from `compatibility-ledger.json`. A report from another artifact or execution plane cannot satisfy the cell. The scheduled workflow runs each cell in a fresh GitHub-hosted VM and restricted container without repository or model secrets.
