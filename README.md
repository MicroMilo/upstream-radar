<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>Know which DeepSeek Harness plugins break after every release—before users do.</strong></p>

<p align="center">
  English · <a href="README-zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm" src="https://img.shields.io/npm/v/upstream-radar"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/MicroMilo/upstream-radar"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

Upstream Radar continuously retests a maintained fleet of exact published
plugins against changing
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
releases in disposable runners. When a pair breaks, it produces a reproducible
issue; when the author ships a fix, it retests and closes the loop.

**100 maintained install/load targets · 13 domain reports filed · 4 closed · 9 open or under watch**

[Latest Agent-driven headless run](https://github.com/MicroMilo/upstream-radar/actions/runs/32684879130):
**96 executable catalog cells observed · 74 compatible · 22 need review · 0 reproduced incompatibilities · 4 source-only**.
Review signals are never advertised as plugin failures.

The first live loop started with 29 review cells. The Agent selected nine
bounded retries; seven became compatible, while two stopped at an explicit Web
client dependency boundary instead of being mislabeled as broken.

In one line: `DSH/plugin change → Agent → disposable headless VM → exact evidence → retest or fixable issue`.

## Why it exists

A healthy repository does not prove that its published plugin still works.
The artifact users install must resolve against a specific DSH host, Node
runtime, profile, and dependency set—and any of them can change overnight.

Upstream Radar checks the relationship, not just the two repositories. A local
pre-publish check asks, “does this plugin pass today?” Radar asks, “which
maintained plugins stopped passing after the ecosystem changed?”

## The loop

```mermaid
flowchart TB
  Change["Schedule / DSH or plugin change"] --> Agent["Agent plans a bounded headless retry"]
  Agent --> Runtime["Disposable VM: install → register → load"]
  Runtime -->|"next observed gate"| Agent
  Runtime -->|"compatible / outside headless"| Evidence["Publish exact evidence"]
  Runtime -->|"reproduced failure"| Issue["Open one fixable issue"]
  Issue -->|"author ships a fix"| Change
```

The Agent interprets repository instructions and the latest runtime evidence,
then chooses whether and how headless should retry. The disposable runner—not
the model—establishes the result. A model cannot invent a build package, execute
inside the target VM, or turn missing evidence into a pass.

## What you get

- An exact result for `plugin version × DSH version × Node/profile`, not a
  timeless “compatible” badge.
- Agent-planned follow-ups joined with real install/register/load evidence from
  the published artifact.
- A maintained result that is retested when DSH or the plugin changes.
- One managed issue that is updated on repeat failures, reopened on regression,
  and closed after a clean retest.

## Domain reports from our loop

These are the 13 maintainer-facing reports filed by Upstream Radar. They are
not all “the plugin is broken”: the first group is runtime compatibility, the
second is the exact package/install boundary, and the third is whether a
dependency graph can be trusted for continuous monitoring.

### DSH host/plugin contract · 2

- **closed** · [Sanqi-normal/dsh-webui-market-plugin#5](https://github.com/Sanqi-normal/dsh-webui-market-plugin/issues/5)
- **open** · [shaoshi20/dshscan#1](https://github.com/shaoshi20/dshscan/issues/1)

### Published artifact and install contract · 7

- **closed** · [1na-ko/dsh-hdc-bridge#3](https://github.com/1na-ko/dsh-hdc-bridge/issues/3)
- **closed** · [6Mikao9/dsh-wsl-workspace#6](https://github.com/6Mikao9/dsh-wsl-workspace/issues/6)
- **closed** · [3274375092/dsh-voice#2](https://github.com/3274375092/dsh-voice/issues/2)
- **open** · [AmeKrance/anan-thermal-monitor#1](https://github.com/AmeKrance/anan-thermal-monitor/issues/1)
- **open** · [AbcdefgXW/dsh-msg-hub#3](https://github.com/AbcdefgXW/dsh-msg-hub/issues/3)
- **open** · [030611/dsh-verification-receipt#3](https://github.com/030611/dsh-verification-receipt/issues/3)
- **open** · [0xsline/dsh-spotlight#5](https://github.com/0xsline/dsh-spotlight/issues/5)

### Dependency graph and source/release alignment · 4

- **open** · [lninghaha/dsh-coding-subscription-oauth#14](https://github.com/lninghaha/dsh-coding-subscription-oauth/issues/14)
- **open** · [AbcdefgXW/dsh-msg-hub#1](https://github.com/AbcdefgXW/dsh-msg-hub/issues/1)
- **open** · [AbcdefgXW/dsh-toolbox-web#1](https://github.com/AbcdefgXW/dsh-toolbox-web/issues/1)
- **open** · [13071301808/dsh-composer-expand#1](https://github.com/13071301808/dsh-composer-expand/issues/1)

The browser/web cases you may remember—[`dsh-web-ui#35`](https://github.com/zhu1090093659/dsh-web-ui/issues/35)
and [`dsh-web-ui#71`](https://github.com/zhu1090093659/dsh-web-ui/issues/71)—are
useful historical compatibility references and are closed, but they were not
filed by Upstream Radar and are therefore not counted above. The maintained
`dsh-browser` entries currently observed compatible are also not findings.

See the [full classification and evidence index](docs/domain-reports.md) for
validation level, impact, and the boundary between a confirmed runtime issue
and a report that only needs maintainer confirmation.

## Run one check

```bash
npx --yes upstream-radar@0.43.4 review dsh-plugin \
  <package>@<version> \
  --dsh-version <dsh-version>
```

For code-executing checks, use the maintained
[isolated observer workflow](.github/workflows/observe-dsh-plugin-install.yml):
each pair receives a fresh, secret-free GitHub-hosted VM and restricted
container.

Inspect the [live compatibility matrix](examples/dsh/install-observer/README.md),
the [directory-consumable evidence feed](feeds/dsh-plugin-compatibility.md),
the [first 50-plugin corpus](examples/dsh/first-batch/README.md), or the
[architecture notes](docs/architecture.md).

<p align="center">
  <strong>If Upstream Radar helps the DSH ecosystem stay compatible, <a href="https://github.com/MicroMilo/upstream-radar">please give it a Star</a> ⭐</strong>
</p>
