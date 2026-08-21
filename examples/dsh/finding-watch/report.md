# DSH known finding watch

Checked: 2026-08-21T03:07:08.515Z

This report watches previously reported supply-chain findings on both the public source repository and the exact npm artifact. `unknown` means the check could not establish a current result; it is never treated as `resolved`.

## Summary

- targets: 7
- baseline: 0
- changed: 0
- unchanged: 7
- unknown: 0
- transitions: {"added":0,"resolved":0,"changed":0,"persisting":42}

## Current status

| Plugin | Overall | Source | Exact npm artifact |
| --- | --- | --- | --- |
| [anan-thermal-monitor](https://github.com/AmeKrance/anan-thermal-monitor) | unchanged | unchanged: anan-thermal-monitor@1.0.4 | unchanged: npm:anan-thermal-monitor@1.0.4 |
| [dsh-hdc-bridge](https://github.com/1na-ko/dsh-hdc-bridge) | unchanged | unchanged: dsh-hdc-bridge@0.7.2 | unchanged: npm:dsh-hdc-bridge@0.7.2 |
| [dsh-msg-hub](https://github.com/AbcdefgXW/dsh-msg-hub) | unchanged | unchanged: dsh-msg-hub@0.1.8 | unchanged: npm:dsh-msg-hub@0.1.8 |
| [dsh-spotlight](https://github.com/0xsline/dsh-spotlight) | unchanged | unchanged: @0xsline/dsh-spotlight@0.0.2 | unchanged: npm:@0xsline/dsh-spotlight@0.0.2 |
| [dsh-verification-receipt](https://github.com/030611/dsh-verification-receipt) | unchanged | unchanged: dsh-verification-receipt@0.1.0 | unchanged: npm:dsh-verification-receipt@0.1.0 |
| [dsh-voice](https://github.com/3274375092/dsh-voice) | unchanged | unchanged: @nn12138/dsh-voice@0.2.5 | unchanged: npm:@nn12138/dsh-voice@0.2.5 |
| [dsh-wsl-workspace](https://github.com/6Mikao9/dsh-wsl-workspace) | unchanged | unchanged: dsh-wsl-workspace@0.2.3 | unchanged: npm:dsh-wsl-workspace@0.2.3 |

## Details

### anan-thermal-monitor

- repository: https://github.com/AmeKrance/anan-thermal-monitor
- overall: **unchanged**
- source: unchanged — anan-thermal-monitor@1.0.4
- exact npm artifact: unchanged — npm:anan-thermal-monitor@1.0.4
- source active finding: `native-binary-present` (high) × 39 — Native artifacts cannot be fully explained by JavaScript source review and require provenance or sandbox analysis.
  - evidence: `{"path":"assets/LibreHardwareMonitor/ja/Microsoft.Win32.TaskScheduler.resources.dll","sha256":"e282404035693502882bca0b88e988fe0bff8ace799ce67582bbb1485751b5dd","size":10240}`
  - evidence: `{"path":"assets/LibreHardwareMonitor/Aga.Controls.dll","sha256":"e9f4eb385359a6d51fcf88153c597e3d75b6e64d5f1c3766eaa2deee739e855f","size":145920}`
  - evidence: `{"path":"assets/LibreHardwareMonitor/System.Text.Encodings.Web.dll","sha256":"43e6dfb4aa333848be5066dcb3d490afc417d0f896aada2f17b5db5fcbb819fc","size":87816}`
  - 36 more evidence records are in the machine report
- artifact active finding: `npm-archive-invalid` (critical) × 1 — unsupported PAX size override
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

### dsh-hdc-bridge

- repository: https://github.com/1na-ko/dsh-hdc-bridge
- overall: **unchanged**
- source: unchanged — dsh-hdc-bridge@0.7.2
- exact npm artifact: unchanged — npm:dsh-hdc-bridge@0.7.2
- source active finding: `custom-registry-config` (medium) × 1 — Dependency provenance depends on a registry selected by package-local configuration.
  - evidence: `{"path":".npmrc"}`
- source active finding: `dependency-graph-unlocked` (medium) × 1 — A future resolution of the same manifest may select different transitive artifacts.
  - evidence: `{"runtimeDependencyCount":1}`
- artifact active finding: `dependency-install-script-present` (high) × 1 — The exact npm lockfile marks one or more reachable dependencies as having an install-time lifecycle script. Scripts were disabled during this review; a normal DSH installation may execute or stop on these scripts.
  - evidence: `{"packages":["@deveco/deveco-cli@1.3.0"],"scripts":["@deveco/deveco-cli@1.3.0 postinstall: node scripts/postinstall.mjs","@deveco/deveco-cli@1.3.0 prepare: husky"]}`
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

### dsh-msg-hub

- repository: https://github.com/AbcdefgXW/dsh-msg-hub
- overall: **unchanged**
- source: unchanged — dsh-msg-hub@0.1.8
- exact npm artifact: unchanged — npm:dsh-msg-hub@0.1.8
- source active watched findings: none
- artifact active finding: `dependency-install-script-present` (high) × 1 — The exact npm lockfile marks one or more reachable dependencies as having an install-time lifecycle script. Scripts were disabled during this review; a normal DSH installation may execute or stop on these scripts.
  - evidence: `{"packages":["protobufjs@7.6.5"],"scripts":["protobufjs@7.6.5 postinstall: node scripts/postinstall"]}`
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

### dsh-spotlight

- repository: https://github.com/0xsline/dsh-spotlight
- overall: **unchanged**
- source: unchanged — @0xsline/dsh-spotlight@0.0.2
- exact npm artifact: unchanged — npm:@0xsline/dsh-spotlight@0.0.2
- source active finding: `lifecycle-script-present` (high) × 1 — Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.
  - evidence: `{"script":"prepare","command":"node scripts/prepare.mjs"}`
- artifact active finding: `lifecycle-script-present` (high) × 1 — Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.
  - evidence: `{"script":"prepare","command":"node scripts/prepare.mjs"}`
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

### dsh-verification-receipt

- repository: https://github.com/030611/dsh-verification-receipt
- overall: **unchanged**
- source: unchanged — dsh-verification-receipt@0.1.0
- exact npm artifact: unchanged — npm:dsh-verification-receipt@0.1.0
- source active finding: `lifecycle-script-present` (high) × 1 — Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.
  - evidence: `{"script":"prepare","command":"pnpm run build"}`
- artifact active finding: `lifecycle-script-present` (high) × 1 — Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.
  - evidence: `{"script":"prepare","command":"pnpm run build"}`
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

### dsh-voice

- repository: https://github.com/3274375092/dsh-voice
- overall: **unchanged**
- source: unchanged — @nn12138/dsh-voice@0.2.5
- exact npm artifact: unchanged — npm:@nn12138/dsh-voice@0.2.5
- source active finding: `lifecycle-script-present` (high) × 1 — Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.
  - evidence: `{"script":"prepare","command":"npm run build"}`
- artifact active finding: `lifecycle-script-present` (high) × 1 — Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.
  - evidence: `{"script":"prepare","command":"npm run build"}`
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

### dsh-wsl-workspace

- repository: https://github.com/6Mikao9/dsh-wsl-workspace
- overall: **unchanged**
- source: unchanged — dsh-wsl-workspace@0.2.3
- exact npm artifact: unchanged — npm:dsh-wsl-workspace@0.2.3
- source active finding: `dependency-graph-unlocked` (medium) × 1 — A future resolution of the same manifest may select different transitive artifacts.
  - evidence: `{"runtimeDependencyCount":6}`
- source active finding: `floating-dependency-spec` (medium) × 6 — The same manifest can resolve to a different artifact without a source change.
  - evidence: `{"dependency":"@deepseek-ai/dsh-timeout","scope":"peerDependency","spec":"*"}`
  - evidence: `{"dependency":"@deepseek-ai/dsh-fs-local","scope":"peerDependency","spec":"*"}`
  - evidence: `{"dependency":"@deepseek-ai/dsh-fs","scope":"peerDependency","spec":"*"}`
  - 3 more evidence records are in the machine report
- artifact active finding: `dependency-install-script-present` (high) × 1 — The exact npm lockfile marks one or more reachable dependencies as having an install-time lifecycle script. Scripts were disabled during this review; a normal DSH installation may execute or stop on these scripts.
  - evidence: `{"packages":["koffi@3.1.6"],"scripts":["koffi@3.1.6 install: node ./cnoke.cjs -P . -D src/koffi --prebuild --release"]}`
- artifact active finding: `floating-dependency-spec` (medium) × 6 — The same manifest can resolve to a different artifact without a source change.
  - evidence: `{"dependency":"@deepseek-ai/dsh-timeout","scope":"peerDependency","spec":"*"}`
  - evidence: `{"dependency":"@deepseek-ai/dsh-fs-local","scope":"peerDependency","spec":"*"}`
  - evidence: `{"dependency":"@deepseek-ai/dsh-fs","scope":"peerDependency","spec":"*"}`
  - 3 more evidence records are in the machine report
- artifact active finding: `npm-provenance-missing` (medium) × 1 — The published bytes are not cryptographically linked to a declared source commit and build workflow.

## Interpretation

These are bounded static and exact-artifact observations. An install script, native binary, missing provenance record, or floating dependency is not automatically malicious; each item tells the plugin author what to review or fix. A source fix can land before the npm artifact is republished, so the two sides remain separate.
