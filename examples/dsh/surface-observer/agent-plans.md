# DSH execution-plane Agent review

Updated: 2026-08-25T10:06:43.260Z

DeepSeek reviews only dependency-build package names observed in a disposable Web/TUI VM. An approval is bound to the exact plugin bytes, DSH version, Node major, plane, profile and source evidence; the no-secret runner receives only that package list.

- Current review set: 1
- Exact-evidence skips: 0
- Agent failures awaiting retry: 0

| Surface cell | Observed gate | Agent action | Retained build policy |
| --- | --- | --- | --- |
| `better-sidebar-node22-web` | `node-pty` | `retry-surface` | `node-pty` |
|  |  |  | The web profile install failed solely because pnpm ignored the build script for node-pty, which is a direct dependency of dsh-better-sidebar. The README explicitly documents that node-pty requires build approval and provides the exact command to approve it. Approving node-pty is a minimal, evidence-backed change that should allow the install to proceed. |

A stopped plan is an environment-planning boundary, not a plugin incompatibility.
