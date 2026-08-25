# DSH headless Agent review

Updated: 2026-08-25T04:02:20.951Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 14
- Agent-reviewed: 14
- Agent failures awaiting retry: 0

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `better-sidebar-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve two peer dependencies (@deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots) that the plugin imports at runtime. This is a runtime contract mismatch, not a build approval issue. No build packages are required, so a retry cannot fix the missing peer resolution. |
| `dsh-awiki-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve two peer dependencies: @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots. The missing primitives are required at runtime (runtime-import-observed) and are part of the DSH client UI contract. The headless profile cannot provide these UI packages, and no build approval can fix the runtime resolution. The issue is a headless environment limitation, not a build approval problem. |
| `dsh-coding-subscription-oauth-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependencies require @deepseek-ai/dsh-atomic-write@0.1.0-rc.6, but the headless DSH profile resolves 0.1.1-rc.2, causing a runtime-import mismatch. No build packages are required, and the mismatch is due to the headless environment's fixed dependency versions, not a build approval issue. |
| `dsh-commandcode-provider-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-primitives is missing at runtime, but the plugin declares a web platform and requires UI primitives that are not available in the headless DSH profile. The missing package is a peer dependency, not a build artifact, so approving builds cannot resolve it. The headless environment cannot satisfy the plugin's web UI contract. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin requires a web profile and client UI slots that are not available in the headless DSH runtime. The observed peer-contract-incompatible result is due to missing @deepseek-ai/dsh-client-ui-slots and react-dom mismatch, which cannot be resolved by approving builds in the headless plane. |
| `dsh-mnemon-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin declares a WebUI client platform and injects @deepseek-ai/dsh-client-* packages, but the headless DSH runtime cannot resolve the required @deepseek-ai/dsh-client-ui-primitives peer dependency. The observed failure is a peer contract mismatch in the headless plane, not a build approval issue. No build packages are required, and the repository evidence indicates the plugin is designed for the Web plane, not headless. |
| `dsh-pet-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, but the plugin declares it as a peer dependency and the runtime does not provide it. The observed result is peer-contract-incompatible with no build packages required. The issue is a missing peer dependency that cannot be resolved by approving builds; it requires the DSH runtime to provide the missing package, which is outside the headless build approval scope. |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the observed result is peer-contract-incompatible. No build packages are required or approved, and the issue is a missing peer dependency that cannot be resolved by approving builds. The headless profile cannot add the missing package or change the runtime environment. |
| `dsh-univer-office-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependencies require @deepseek-ai/dsh-* packages at 0.1.0-rc.8, but the headless DSH profile provides 0.1.1-rc.2, causing a version mismatch. No build packages are required, so a retry cannot resolve the incompatibility. |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve two peer dependencies: @deepseek-ai/dsh-client-ui-primitives (runtime-import-observed) and @deepseek-ai/dsh-client-ui-slots (type-only-reference-observed). The observed result is peer-contract-incompatible, not build-approval-required. No build packages are required or approved, so a retry cannot change the outcome. The missing peers are part of the DSH runtime contract and cannot be added via the pnpm dependency-build approval list. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-tools is pinned to 0.1.0-rc.6, but the headless DSH runtime provides 0.1.1-rc.2, causing a runtime-import mismatch. No build packages are required, and the mismatch is a version contract issue that cannot be resolved by approving builds. The headless profile cannot change the runtime version, so retrying is not justified. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the observed result is peer-contract-incompatible. No build packages are required, and the issue is a runtime resolution contract, not a build approval. Retrying headless cannot resolve the missing peer dependency. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin does not statically reference it (no-literal-reference-observed). The missing peer is a host-provided dependency that the headless DSH profile does not supply, and the plugin's own build requires no packages. A retry cannot resolve this because the headless profile cannot add host packages or change the runtime contract. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, and the plugin declares a web client platform with UI slots that cannot be satisfied in the headless environment. No build packages are required, so a retry cannot resolve the missing peer contract. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
