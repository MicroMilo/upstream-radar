# DSH headless Agent review

Updated: 2026-08-28T19:08:23.015Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 11
- Agent-reviewed: 11
- Agent failures awaiting retry: 0

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `dsh-config-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve @deepseek-ai/dsh-client-ui-slots, which the plugin imports at runtime. The headless profile cannot provide this missing peer dependency because it is not a build package and no build approval can add it. The issue is a runtime contract mismatch, not a build approval problem. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a web profile and injects client UI slots, but the headless DSH runtime cannot resolve the peer dependency @deepseek-ai/dsh-client-ui-slots. The observed result is peer-contract-incompatible with no build packages required, so a retry cannot fix the missing peer. The plugin's README explicitly states it is not intended for headless profiles. |
| `dsh-pet-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, but the plugin declares a web client platform and injects client runtime/connection. The missing peer is likely a client-side UI slots module that cannot be resolved in the headless environment. No build packages are required, and the issue is not a build approval problem. |
| `dsh-remote-node22` | `unknown` | `stop-headless` | `different-plane` | approve `cpu-features`, `node-pty`, `ssh2` |
|  |  |  |  | The plugin artifact installed and loaded, but the runtime graph has 2 unresolved peer dependencies from dsh-better-sidebar (@deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots). These are peer dependencies of a dependency, not build packages, and cannot be resolved by approving native builds. The issue is a version mismatch between dsh-better-sidebar's peer requirements (^0.1.0-rc.8) and the available DSH packages (0.1.1-rc.2), which is a plugin compatibility problem requiring a different plane (e.g., updating the plugin or its dependencies). |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the observed result is peer-contract-incompatible. No build packages are required or approved, and the issue is a missing peer dependency that cannot be resolved by approving builds. The headless profile cannot add the missing package or change the runtime environment. |
| `dsh-univer-office-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependencies require exact versions (0.1.0-rc.8) of DSH packages, but the headless DSH profile provides 0.1.1-rc.2, causing mismatches. No build packages are required, so a retry cannot resolve the version incompatibility. |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a Web platform (dsh.client.platform: web) and injects client UI modules, but the headless profile cannot provide the missing @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots peer dependencies. No build packages are required, so a retry cannot resolve the runtime import failure. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-tools is pinned to 0.1.0-rc.6, but the headless DSH runtime provides 0.1.1-rc.2, causing a runtime-import mismatch. No build packages are required, and the mismatch is a version contract issue that cannot be resolved by approving builds. The headless profile cannot change the runtime version, so retrying is not justified. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the plugin declares a web client platform with client injection, which cannot be satisfied by the headless DSH profile. The observed result is peer-contract-incompatible due to a missing peer, not a build approval issue. No build packages are required, and retrying headless cannot resolve the missing peer or the web platform requirement. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin does not statically reference it (no-literal-reference-observed). The missing peer is a host-provided dependency that the headless DSH profile does not supply, and the plugin's own build requires no packages. A retry cannot resolve this because the headless profile cannot add host packages or change the runtime contract. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, and the plugin declares a web client platform with UI slots that cannot be satisfied in the headless environment. No build packages are required, so a retry cannot resolve the missing peer contract. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
