# DSH headless Agent review

Updated: 2026-08-26T07:32:46.100Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

- Current review set: 14
- Agent-reviewed: 14
- Agent failures awaiting retry: 0

| Case | Previous evidence | Agent action | Classification | Retained build policy |
| --- | --- | --- | --- | --- |
| `better-sidebar-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer contract requires @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots, which are not resolved by the DSH runtime. The observed result is peer-contract-incompatible with runtime-import-observed for the missing primitives package. No build packages are required, so a retry cannot resolve the missing peer dependencies. The issue is a headless contract mismatch, not a build approval problem. |
| `dsh-agency-agents-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots@^0.1.0-rc.5 is missing in the runtime graph, and the plugin declares a web client platform with inject requirements. The headless profile cannot satisfy the web UI contract, and no build packages are required or approved. |
| `dsh-archive-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and requires @deepseek-ai/dsh-client-ui-primitives, which is not resolved by the headless DSH runtime. The missing peer is a UI primitive, indicating the plugin needs a Web/TUI plane not available in the headless profile. No build packages are required, so a retry cannot resolve the missing peer. |
| `dsh-codex-connect-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin installed and loaded, but the DSH runtime did not resolve @deepseek-ai/dsh-client-ui-primitives@0.1.1-rc.2, a required peer dependency. The failure is a runtime resolution issue, not a build approval issue. No build packages are required, and the headless profile cannot resolve the missing peer dependency. The plugin declares a web platform and injects client UI modules, which may require a Web/TUI plane not available in the headless profile. |
| `dsh-codex-subscription-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin requires a web client platform and injects UI components, but the headless DSH profile cannot provide the required web/TUI plane. The observed failure is due to missing peer dependencies (@deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots) that are part of the web client runtime, not build packages. No build approval can resolve this. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a web profile and injects client UI slots, but the headless DSH runtime cannot resolve the peer dependency @deepseek-ai/dsh-client-ui-slots. The observed result is peer-contract-incompatible with no build packages required, so a retry cannot fix the missing peer. The plugin's README explicitly states it is not intended for headless profiles. |
| `dsh-remote-node22` | `unknown` | `stop-headless` | `different-plane` | approve `cpu-features`, `node-pty`, `ssh2` |
|  |  |  |  | The runtime graph has 2 unresolved peer dependencies from dsh-better-sidebar (@deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots) that are not build packages but missing peer packages. The plugin's own peer dependencies are all satisfied. The unresolved edges are due to version mismatches between dsh-better-sidebar's peer requirements (^0.1.0-rc.8) and the installed DSH packages (0.1.1-rc.2), which cannot be fixed by approving build packages. This requires a different plane (e.g., updating dsh-better-sidebar or aligning versions) and is not addressable by headless retry. |
| `dsh-skills-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin declares a web platform and injects client UI slots. The headless profile cannot satisfy this web-specific peer contract, and no build packages are required or approved. Retrying headless would not resolve the missing peer dependency. |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and the observed result is peer-contract-incompatible. No build packages are required or approved, and the issue is a missing peer dependency that cannot be resolved by approving builds. The headless profile cannot add the missing package or change the runtime environment. |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and requires @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots as peer dependencies, which are not resolved in the headless runtime. The missing peer is used at runtime, indicating the plugin expects a Web UI plane. No build packages are required, so a retry cannot resolve the missing peer dependencies. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-tools is pinned to 0.1.0-rc.6, but the headless DSH runtime provides 0.1.1-rc.2, causing a runtime-import mismatch. No build packages are required, and the mismatch is a version contract issue that cannot be resolved by approving builds. The headless profile cannot change the runtime version, so retrying is not justified. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the runtime graph, and react-dom is mismatched (resolved 19.2.8 vs required ^18.2.0). The missing peer is a type-only reference, indicating a headless contract issue: the DSH runtime does not provide the required UI slots package. No build packages are required, so a retry cannot resolve the missing peer. The issue is not a build approval problem. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, but the plugin does not statically reference it (no-literal-reference-observed). The missing peer is a host-provided dependency that the headless DSH profile does not supply, and the plugin's own build requires no packages. A retry cannot resolve this because the headless profile cannot add host packages or change the runtime contract. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency @deepseek-ai/dsh-client-ui-slots is missing in the headless runtime, and the plugin declares a web client platform with UI slots that cannot be satisfied in the headless environment. No build packages are required, so a retry cannot resolve the missing peer contract. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
