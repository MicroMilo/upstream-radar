# DSH headless Agent plans

Updated: 2026-08-24T03:00:23.226Z

The Agent reads bounded repository evidence and the latest isolated headless result. There is no static environment-planning fallback. Only an exact observed build-package name can reach the no-secret retry runner.

| Case | Previous evidence | Agent action | Classification | Headless delta |
| --- | --- | --- | --- | --- |
| `better-sidebar-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web platform and requires @deepseek-ai/dsh-client-ui-primitives@^0.1.0-rc.8 as a peer dependency, which the headless DSH runtime does not resolve. The observed failure is a runtime import issue, not a build approval issue. No build packages are required, so a retry cannot fix the problem. |
| `dsh-agency-agents-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and injects client UI packages, but the headless DSH profile cannot provide the required @deepseek-ai/dsh-client-ui-slots peer dependency. The observed failure is a peer-contract incompatibility with no build packages required, so a retry cannot resolve it. |
| `dsh-archive-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin declares a web client platform and injects client UI packages, but the available execution plane is the headless DSH profile. The observed failure is a runtime peer-contract incompatibility for @deepseek-ai/dsh-client-ui-primitives, which is a web UI dependency not resolvable in the headless runtime. No build packages are required, so a retry cannot address the mismatch. |
| `dsh-awiki-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and requires @deepseek-ai/dsh-client-ui-primitives at runtime, but the headless DSH profile cannot resolve or provide that UI package. The observed failure is a runtime import of a UI primitive, which is outside the headless execution contract. No build packages are required, so a retry cannot fix the incompatibility. |
| `dsh-codex-connect-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a web platform and client injection, which is outside the headless DSH profile contract. The observed peer-contract-incompatible result is due to a type-only reference mismatch with @deepseek-ai/dsh-agent, and no build packages are required or approved. |
| `dsh-codex-subscription-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and injects UI components, which cannot be satisfied by the headless DSH profile. The observed failure is a runtime peer contract mismatch for @deepseek-ai/dsh-client-ui-primitives, but the root cause is that the plugin requires a web/TUI plane not available in headless mode. |
| `dsh-coding-subscription-oauth-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a Web/TUI plane (client inject, settings page, local API gateway) and its peer dependency @deepseek-ai/dsh-atomic-write@0.1.0-rc.6 is not satisfied by the installed 0.1.1-rc.2, which is a runtime-import-observed incompatibility. No build packages are required, so a retry cannot resolve the peer mismatch. The headless profile cannot provide the required Web plane. |
| `dsh-commandcode-provider-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and requires UI primitives that the headless DSH runtime does not resolve. No build packages are required, so a retry cannot fix the runtime-import incompatibility. |
| `dsh-config-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and requires @deepseek-ai/dsh-client-ui-slots which the headless DSH runtime does not resolve. The headless profile cannot satisfy the plugin's peer contract, and no build packages are required for retry. |
| `dsh-free-vision-node22` | `build-approval-required` | `retry-headless` | `build-approval` | approve `dsh-free-vision`, `sharp` |
|  |  |  |  | The plugin requires sharp for image processing, which is a legitimate dependency. The repository evidence shows sharp is used for image handling, and the build approval is required. Retrying with sharp approved is appropriate. |
| `dsh-full-remote-node22` | `peer-contract-incompatible` | `stop-headless` | `different-plane` | none |
|  |  |  |  | The plugin requires a web profile and depends on @deepseek-ai/dsh-client-ui-slots, which is not resolved by the headless DSH runtime. The observed failure is a peer-contract incompatibility, not a build approval issue. No build packages are required, and the headless plane cannot satisfy the plugin's web client dependencies. |
| `dsh-mnemon-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web platform client with UI primitives peer dependency that the headless DSH runtime cannot resolve. The observed failure is a peer-contract incompatibility, not a build approval issue. No build packages are required, and the headless profile cannot satisfy the web-only client contract. |
| `dsh-pet-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a Web/TUI plane (dsh.client.platform: web) and peer dependencies that the headless DSH profile cannot resolve. The observed failure is a peer-contract-incompatible due to @deepseek-ai/dsh-client-ui-slots not being resolved by the DSH runtime, which is a headless contract limitation, not a build approval issue. No build packages are required, so retry-headless is not applicable. |
| `dsh-skills-manager-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and injects client UI packages, but the headless DSH profile cannot resolve @deepseek-ai/dsh-client-ui-slots. The observed failure is a peer-contract incompatibility with the headless runtime, not a build approval issue. No build packages are required, so a retry cannot resolve the missing UI slot dependency. |
| `dsh-thirteen-bg-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a Web/TUI plane (client inject with platform web) and peer dependencies that the headless DSH runtime cannot resolve. No build packages are required, so a retry cannot fix the incompatibility. |
| `dsh-univer-office-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and requires a browser-based Gateway and Viewer, which cannot be satisfied by the headless DSH profile. The observed peer-contract-incompatible failure is due to a version mismatch in @deepseek-ai/dsh-attachment, but the plugin's architecture fundamentally requires a web/TUI plane that is not available in this milestone. |
| `dsh-vision-proxy-node22` | `build-approval-required` | `retry-headless` | `build-approval` | approve `dsh-vision-proxy`, `sharp` |
|  |  |  |  | The plugin requires sharp as an optional dependency for image downsampling. The package.json explicitly lists sharp in pnpm.onlyBuiltDependencies, and the README instructs approving both dsh-vision-proxy and sharp. Since sharp is a well-known native module requiring build scripts, and the repository evidence supports approving it, retry with sharp added to the approval list. |
| `dsh-vision-toolkit-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and injects UI packages, but the observed failure is a runtime import of @deepseek-ai/dsh-client-ui-primitives that the headless DSH runtime does not resolve. No build packages are required, so a retry cannot fix the missing runtime dependency. |
| `dsh-wallpaper-engine-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires @deepseek-ai/dsh-client-ui-slots@ =0.1.0-rc.6 which is not resolved by the DSH runtime in the headless profile. The plugin's client injects @deepseek-ai/dsh-client-runtime and targets the web platform, which is outside the headless contract. No build packages are required, so a retry cannot resolve the peer incompatibility. |
| `dshscan-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin's peer dependency requires @deepseek-ai/dsh-tools@0.1.0-rc.6, but the installed DSH runtime provides 0.1.1-rc.2, which does not satisfy the peer range. This is a runtime-import-observed incompatibility, not a build approval issue. No build packages are required, and the headless profile cannot alter the DSH runtime version or peer dependency resolution. |
| `graphflow-node22` | `build-approval-required` | `retry-headless` | `build-approval` | approve `@roarpeng/graphflow`, `better-sqlite3`, `onnxruntime-node`, `protobufjs`, `sharp` |
|  |  |  |  | The plugin requires native/optional dependencies that need build approval. The observed manifest lists better-sqlite3 as an optionalDependency, and the plugin's dependencies include @huggingface/transformers which may pull onnxruntime-node and protobufjs, while sharp is a common transitive dependency. The repository evidence supports approving these exact packages for a headless retry. |
| `openpencil-node24` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin declares a web client platform and injects UI packages, but the observed failure is a peer-contract-incompatible: the DSH runtime did not resolve @deepseek-ai/dsh-client-ui-slots@^0.1.0-rc.6, which is a peer dependency. The plugin's manifest requires a web platform and UI slot injection, which is outside the headless DSH profile's contract. No build packages are required, so a retry cannot resolve the peer mismatch. |
| `sanqi-market-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a web client platform and peer dependencies that are not provided by the headless DSH profile. The observed failure is a peer-contract-incompatible due to missing @deepseek-ai/dsh-client-ui-slots, which is a host dependency only available in a web environment. No build packages are required, so a retry cannot resolve the issue. |
| `whale-on-desk-node22` | `peer-contract-incompatible` | `stop-headless` | `headless-contract` | none |
|  |  |  |  | The plugin requires a web client UI slot and injects @deepseek-ai/dsh-client-runtime, which is not available in the headless DSH profile. The observed failure is a peer-contract incompatibility due to missing UI slot resolution, not a build approval issue. |

A stopped plan is not a compatibility failure. It means this headless-only milestone has no Agent-supported retry to execute.
