# DSH headless Agent review

Updated: 2026-08-24T04:58:50.917Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 14
- Agent-reviewed: 14
- Agent failures awaiting retry: 0

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `better-sidebar-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer contract requires @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots, which are not resolved by the DSH runtime. The observed result is peer-contract-incompatible, and the build packages required are none. The issue is a runtime dependency resolution failure, not a build approval issue. Retrying headless would not resolve missing peer dependencies because the headless profile cannot add or modify peer dependencies; it can only approve build scripts. Therefore, stop-headless is appropriate. |
| `dsh-awiki-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve two peer dependencies: @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots. The manifest declares these as peer dependencies and the plugin's client injects several UI packages, but the headless profile cannot provide the required Web UI runtime. The missing packages are UI primitives and slots, which are part of the Web client layer, not build-time dependencies. No build packages are required, and the issue is a runtime contract mismatch with the headless environment, not a build approval problem. |
| `dsh-coding-subscription-oauth-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependencies require @deepseek-ai/dsh-atomic-write@0.1.0-rc.6, but the headless DSH profile resolves 0.1.1-rc.2, causing a runtime-import mismatch. No build packages are required, and the mismatch is due to the headless environment's fixed dependency versions, not a build approval issue. |
| `dsh-commandcode-provider-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web platform and injects client UI modules, but the headless DSH profile cannot resolve @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots. No build packages are required, so a retry cannot fix the missing peer dependencies. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin requires a web profile and client UI slots that are not available in the headless DSH runtime. The observed peer-contract-incompatible result stems from missing @deepseek-ai/dsh-client-ui-slots and react-dom version mismatch, which cannot be resolved by approving build packages in the headless plane. |
| `dsh-mnemon-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web platform client and requires @deepseek-ai/dsh-client-ui-primitives as a peer dependency, which is not resolved by the headless DSH runtime. The observed result is peer-contract-incompatible due to a missing runtime import, not a build approval issue. No build packages are required, so a retry cannot resolve the missing peer contract. |
| `dsh-pet-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is not resolved by the DSH runtime, and the plugin does not reference it in code (no-literal-reference-observed). This indicates a headless contract mismatch: the plugin expects a UI slots module that the headless runtime does not provide. No build packages are required, so a retry cannot resolve this issue. |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the observed result is peer-contract-incompatible. No build packages are required or approved, and the issue is a missing peer dependency that cannot be resolved by approving builds. The headless profile cannot add the missing package or change the runtime environment. |
| `dsh-univer-office-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependencies require exact versions (0.1.0-rc.8) of DSH packages, but the headless environment resolves 0.1.1-rc.2, causing mismatches. No build packages are required, so a retry cannot fix the version mismatch. The issue is a contract incompatibility between the plugin's peer dependency spec and the headless runtime's provided versions, not a build approval problem. |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer contract requires @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots, which are not provided by the headless DSH runtime. The missing primitives are used at runtime (runtime-import-observed), indicating a hard dependency on the Web UI plane. No build packages are required, so a retry cannot resolve the missing peer dependencies. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-tools is pinned to 0.1.0-rc.6, but the headless DSH runtime provides 0.1.1-rc.2, causing a runtime-import mismatch. No build packages are required, and the mismatch is a version contract issue that cannot be resolved by approving builds. The headless profile cannot change the runtime version, so retrying is not justified. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer contract requires @deepseek-ai/dsh-client-ui-slots@^0.1.0-rc.6, which is missing from the runtime graph. The observed result is peer-contract-incompatible due to a missing peer dependency, not a build approval issue. No build packages are required, and the headless profile cannot resolve the missing peer because it is a runtime contract mismatch, not a build approval problem. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin does not statically reference it (no-literal-reference-observed). The missing peer is a host-provided dependency that the headless DSH profile does not supply, and the plugin's own build requires no packages. A retry cannot resolve this because the headless profile cannot add host packages or change the runtime contract. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, and the plugin declares a web client platform with UI slots that cannot be satisfied in the headless environment. No build packages are required, so a retry cannot resolve the missing peer contract. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
