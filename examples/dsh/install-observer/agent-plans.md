# DSH headless Agent review

Updated: 2026-09-03T11:43:03.206Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 8
- Agent-reviewed: 7
- Agent failures awaiting retry: 1

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `dsh-auxiliary-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin artifact installed and loaded, but the runtime could not resolve the required peer dependency @dsh-plugin/dsh-loader@^1.3.0. The observed result is peer-contract-incompatible with no build packages required or approved. The failure is due to the headless runtime not providing the peer dependency, which is outside the scope of build approvals. A retry cannot resolve this missing peer dependency. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `agent-failed` | `unknown` | none |
|  |  |  |  | Agent endpoint returned HTTP 402: https://api.deepseek.com/chat/completions |
| `dsh-notifier-node22` | `build-approval-required` | `stop-headless` | `insufficient-evidence` | none |
|  |  |  |  | The observed result is build-approval-required for protobufjs, but the repository evidence does not support approving this package. The plugin declares zero runtime dependencies and only optional dependencies, none of which include protobufjs. The lockfile shows unresolved optional dependencies but no protobufjs. The build approval request appears to be spurious or from an untrusted source, and there is no evidence that protobufjs is a legitimate build dependency for this plugin. |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the required version range is unsatisfiable in the current DSH runtime. No build packages are required, so a retry cannot resolve the missing peer. The issue is a headless contract mismatch: the plugin expects a UI slots package that the headless runtime does not provide. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-tools requires exactly 0.1.0-rc.6, but the headless DSH runtime provides 0.1.1-rc.2, causing a runtime-import-observed mismatch. No build packages are required, and the mismatch is a version contract issue that cannot be resolved by approving builds. The headless profile cannot change the runtime version, so retrying would not help. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the plugin declares a web client platform with inject list that does not include this package. The headless profile cannot resolve this peer contract because it is a type-only reference and the package is not provided by the DSH runtime. No build packages are required, so a retry cannot fix the missing peer. The issue is a headless contract limitation. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin declares a web client platform and requires a web UI slots package that the headless DSH profile cannot provide. The missing peer is a UI slots contract, not a build approval issue. No build packages are required, so retrying headless cannot resolve the missing peer dependency. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is not resolved by the DSH runtime, and the plugin declares a web client platform with injection of @deepseek-ai/dsh-client-runtime. The headless profile cannot satisfy the missing UI slots peer, and no build packages are required or approved. Retrying headless would not resolve the missing peer contract. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
