# DSH headless Agent review

Updated: 2026-09-03T11:43:03.206Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 25
- Agent-reviewed: 0
- Agent failures awaiting retry: 25

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `better-sidebar-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `deepseek-harness-acp-node22` | `unknown` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-auto-memory-node22` | `build-approval-required` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-auxiliary-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-awiki-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-catppuccin-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-client-auto-continue-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-codex-connect-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-coding-subscription-oauth-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-git-worktree-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-history-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-pet-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-plugin-writing-guard-node22` | `build-approval-required` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-remote-node22` | `unknown` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-tavern-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-univer-office-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-update-checker-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-web-ui-all-node22` | `unknown` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dshscan-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `openpencil-node24` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `sanqi-market-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
