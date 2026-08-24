<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>Find the DeepSeek Harness plugins that need attention when the ecosystem moves.</strong></p>

<p align="center">
  <a href="README-zh-CN.md">简体中文</a> ·
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm" src="https://img.shields.io/npm/v/upstream-radar"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/MicroMilo/upstream-radar"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

Upstream Radar continuously checks the relationship between an exact published
DSH plugin, its DSH host, and its dependency graph. When a DSH or plugin release
changes that relationship, Radar shows what changed, what was actually observed,
and what a maintainer can fix.

It is built for the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
plugin ecosystem. A static review is evidence about a package; an isolated
runtime review is evidence about one exact `plugin × DSH × Node/profile` pair.
Neither is presented as a timeless compatibility badge or a security certificate.

## The problem

A source repository can be green while the package users install is not ready
for the current DSH host:

- the README advertises a version that was never published;
- a plugin imports a newer DSH package than its peer range allows;
- `package.json` and the lockfile describe different releases;
- an install-time build or dependency script needs tools the user does not have;
- a DSH host dependency is missing, so the dependency graph cannot be completed.

These are ecosystem relationship problems. They are easy to miss when the two
repositories are checked separately.

## What Radar does

1. **Pin the real inputs.** Read the exact npm artifact, DSH version, Node
   runtime, profile, lockfile, and dependency paths.
2. **Compare the relationship.** Detect upstream changes, package/release drift,
   incomplete graphs, and DSH contract mismatches.
3. **Observe when execution matters.** In a fresh, secret-free runner, install,
   register, and load the exact artifact; record the result and its boundary.
4. **Close the loop.** Produce bounded evidence, route meaningful changes to an
   optional DSH Agent, and update or close one maintainer-facing issue after a
   clean retest.

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

## Try a real check

No local DSH profile is needed for this first check. It reviews one exact
published artifact without executing plugin code:

```bash
npx --yes upstream-radar@0.43.4 inspect \
  @sanqi-normal/dsh-webui-market-plugin@0.5.4 \
  --deep --fail-on never
```

This historical DSH plugin release returns `review / incomplete` because its
published host dependency chain reaches an unavailable package. That is a
useful, reproducible release/host-contract report—not a claim of malicious
behavior. See the [full evidence report](examples/dsh/reports/sanqi-market-plugin-dependency-resolution.md).

To review your own public repository without installing it:

```bash
npx --yes upstream-radar@0.43.4 scan \
  https://github.com/owner/dsh-plugin \
  --fail-on never
```

The repository scan reads source manifests, DSH metadata, and lockfiles. It does
not install dependencies, run lifecycle scripts, load the plugin, start DSH, or
call an LLM.

## Run it on every change

Copy one of the maintained workflows into your repository:

- [Review one exact plugin across DSH versions](examples/github-actions/dsh-plugin-review-minimal.yml)
  — a manual check with artifact evidence and an isolated load matrix.
- [Observe one plugin repository every day](examples/github-actions/upstream-observer-minimal.yml)
  — compares commits, published versions, manifests, and dependency graphs, then
  wakes an Agent only when there is a meaningful change.
- [Run the dependency gate in CI](examples/github-actions/upstream-radar.yml)
  — checks the lockfile or reviewed Radar configuration before merge.

The [isolated observer workflow](.github/workflows/observe-dsh-plugin-install.yml)
uses a fresh GitHub-hosted runner for code-executing checks. The runner is not
your workstation and does not receive project secrets.

## Upstream reports now closed

We opened the following reports; their upstream maintainers have now closed
them:

- [Sanqi-normal/dsh-webui-market-plugin#5](https://github.com/Sanqi-normal/dsh-webui-market-plugin/issues/5)
- [1na-ko/dsh-hdc-bridge#3](https://github.com/1na-ko/dsh-hdc-bridge/issues/3)
- [6Mikao9/dsh-wsl-workspace#6](https://github.com/6Mikao9/dsh-wsl-workspace/issues/6)
- [3274375092/dsh-voice#2](https://github.com/3274375092/dsh-voice/issues/2)

The [full domain report index](docs/domain-reports.md) keeps the open reports,
validation level, and the boundary between a confirmed runtime failure and a
maintainer-confirmation request.

<p align="center">
  <strong>If Upstream Radar helps the DSH ecosystem stay compatible, <a href="https://github.com/MicroMilo/upstream-radar">please give it a Star</a> ⭐</strong>
</p>
