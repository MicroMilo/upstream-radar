# DSH headless Agent review

Updated: 2026-08-31T14:26:14.099Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 14
- Agent-reviewed: 14
- Agent failures awaiting retry: 0

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `better-sidebar-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer contract requires @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots at ^0.1.0-rc.8, but the DSH runtime (0.1.1-rc.2) does not provide them, causing runtime import failure. The manifest declares peerDependencies at ^0.1.2-alpha.2, indicating a version mismatch with the runtime. No build packages are required, so a retry cannot resolve the missing peer dependencies. |
| `dsh-auxiliary-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the runtime could not resolve the required peer dependency @dsh-plugin/dsh-loader@^1.3.0. The headless profile cannot provide this peer dependency, and no build approvals are needed or possible. The issue is a missing runtime peer, not a build approval problem. |
| `dsh-coding-subscription-oauth-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin's peer dependency @earendil-works/pi-ai requires 0.84.2 but the runtime resolved 0.82.1, causing a peer-contract mismatch. The manifest includes an override pinning @earendil-works/pi-ai to 0.84.2, but the headless profile cannot install or update that package because it is not in the build approval list and the runner cannot modify dependencies beyond the explicit approval list. The mismatch is a runtime dependency resolution issue that cannot be fixed by approving build packages, as no build packages are required. The issue stems from the headless environment's inability to satisfy the peer dependency version, which would require a different execution plane (e.g., a full package manager with network access) to resolve. |
| `dsh-commandcode-provider-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-primitives is missing at runtime, and the plugin declares a web client platform with UI injection, which cannot be satisfied by the headless DSH profile. No build packages are required, so a retry cannot resolve the missing peer. |
| `dsh-config-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve @deepseek-ai/dsh-client-ui-slots@^0.1.0-rc.6, which is required as a peer dependency and used via runtime import. The headless profile cannot provide the missing peer package because it is not a build dependency and no build approval can add it. The issue is a runtime contract mismatch, not a build approval problem. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin requires a web profile and injects client UI slots, but the headless DSH profile cannot resolve the peer dependency @deepseek-ai/dsh-client-ui-slots. The observed result is peer-contract-incompatible due to a missing peer, not a build approval issue. No build packages are required, and the failure is due to the headless environment lacking the web client runtime, which cannot be fixed by approving builds. |
| `dsh-notifier-node22` | `build-approval-required` | `stop-headless` | `insufficient-evidence` | none |
|  |  |  |  | The observed result is build-approval-required for protobufjs, but the repository evidence does not support approving this package. The plugin declares zero runtime dependencies and only optional dependencies, none of which include protobufjs. The lockfile shows unresolved optional dependencies but no protobufjs. The build approval request appears to be spurious or from an untrusted source, and there is no evidence that protobufjs is a legitimate build dependency for this plugin. |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the required version range is unsatisfiable in the current DSH runtime. No build packages are required, so a retry cannot resolve the missing peer. The issue is a headless contract mismatch: the plugin expects a UI slots package that the headless runtime does not provide. |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a Web platform (dsh.client.platform: web) and injects client UI modules, but the headless profile cannot provide the missing @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots peer dependencies. No build packages are required, so a retry cannot resolve the runtime import failure. |
| `dsh-wallpaper-engine-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin loaded but the DSH runtime did not resolve the peer dependency @deepseek-ai/dsh-client-ui-slots, which is required by the plugin's manifest. The headless profile cannot provide this UI slot package, and no build packages are required or approved. Retrying headless would not change the missing peer resolution. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-tools requires exactly 0.1.0-rc.6, but the headless DSH runtime provides 0.1.1-rc.2, causing a runtime-import-observed mismatch. No build packages are required, and the mismatch is a version contract issue that cannot be resolved by approving builds. The headless profile cannot change the runtime version, so retrying would not help. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the plugin declares a web client platform with inject list that does not include this package. The headless profile cannot resolve this peer contract because it is a type-only reference and the package is not provided by the DSH runtime. No build packages are required, so a retry cannot fix the missing peer. The issue is a headless contract limitation. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin declares a web client platform and requires a web UI slots package that the headless DSH profile cannot provide. The missing peer is a UI slots contract, not a build approval issue. No build packages are required, so retrying headless cannot resolve the missing peer dependency. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is not resolved by the DSH runtime, and the plugin declares a web client platform with injection of @deepseek-ai/dsh-client-runtime. The headless profile cannot satisfy the missing UI slots peer, and no build packages are required or approved. Retrying headless would not resolve the missing peer contract. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
