# Upstream Radar

[![CI](https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/MicroMilo/upstream-radar/actions)
[![npm](https://img.shields.io/npm/v/upstream-radar)](https://www.npmjs.com/package/upstream-radar)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Dependency evidence and upstream-change monitoring for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugins.**

Upstream Radar answers a practical question before a plugin enters a DSH profile:

> Which exact dependency versions does this plugin bring in, which vulnerability or upstream release changed them, and which other plugins will be affected?

It reads source trees, lockfiles, exact npm artifacts, saved DSH reports, and public advisory feeds. It does not install a plugin or execute its business code during static review.

## Try it in 60 seconds

```bash
# No DSH profile, API key, or network state required
npx --yes upstream-radar@0.34.0 demo

# Scan a public DSH plugin repository without installing it
npx --yes upstream-radar@0.34.0 scan \
  https://github.com/PlutoKeating/dsh-lark-bot \
  --fail-on never

# Review the exact package users would install, then check two DSH releases
npx --yes upstream-radar@0.34.0 review dsh-plugin dsh-feishu-bot@0.15.8 \
  --dsh-version 0.1.0-rc.6,0.1.0-rc.7
```

The important output is evidence, not a green badge: exact package identity, dependency paths, unresolved edges, install-time scripts, npm integrity/signature/provenance, advisory matches, and DSH load results.

## What we have already found

These are real, reproducible cases in this repository—not synthetic “vulnerable package” demos.

| Case | Finding | Why it matters |
| --- | --- | --- |
| [50-plugin batch](examples/dsh/reports/dsh-batch-50-2026-08-17.md) | 0 confirmed runtime dependency vulnerabilities; 3 lockfile root-version mismatches | Monitoring can be wrong even when the vulnerability count is zero. |
| [`dsh-feishu-bot@0.15.8`](examples/dsh/reports/dsh-feishu-bot-0.15.8-review-2026-08-18.md) | 89-package graph, 12 unresolved optional edges, reachable `protobufjs` `postinstall`, DSH rc.6/rc.7 compatible | “No known CVE” is not the same as “no installation trust boundary.” |
| [DSH-TUI source vs npm](examples/dsh/reports/dsh-tui-source-vs-npm-2026-08-18.md) | Source has `prepare`; published artifact does not | Source-only and artifact-only reviews answer different questions. |
| [dsh-composer-expand](examples/dsh/reports/dsh-composer-expand-lockfile-feedback.md) | Committed lockfile root says `0.1.0` while source says `0.1.2` | A small author-fix can restore the identity of the monitored graph. |

We report a confirmed vulnerability only when the affected exact version and runtime path are supported by the available evidence. Development-only hits, missing data, and advisory-source outages remain visibly different states.

## The core workflow

```text
DSH plugin source / npm artifact
          ↓
exact dependency graph + DSH compatibility evidence
          ↓
saved observation point
          ↓
upstream commit, package, or advisory changes
          ↓
affected-plugin paths and author-facing next action
          ↓
optional DSH Agent analysis only when a meaningful change exists
```

For a collection of saved reports, build the reverse index that turns an upstream package update into affected plugins:

```bash
npx --yes upstream-radar@0.34.0 graph reverse ./reports \
  --output reverse-dependency-index.json

# Ask: which plugins currently depend on this exact package?
npx --yes upstream-radar@0.34.0 graph reverse ./reports \
  --package parser@2.9.0
```

The generated JSON preserves exact paths such as:

```text
plugin@1.0.0 → logger@4.0.2 → parser@2.9.0
```

It also preserves whether the graph is complete or has unresolved optional/peer edges. A later website can visualize this index; the index and evidence remain the product foundation.

## GitHub Action

The repository already contains a reusable, composite Action in [`action.yml`](action.yml). It runs the same frozen Radar check in CI and writes a short Job Summary.

```yaml
- uses: MicroMilo/upstream-radar@v0.34.0
  with:
    config: upstream-radar.config.json
    fail-on: high
```

See the [consumer workflow](examples/github-actions/consumer/README.md) for config and lockfile examples. The GitHub Marketplace prompt is a distribution opportunity, not a separate scanning engine: the Action listing should follow a reviewed stable release, while exact tags remain copyable and auditable.

## What it does—and does not do

| It does | It does not claim |
| --- | --- |
| Reconstruct exact npm/pnpm dependency paths | An empty finding list is a safety certificate |
| Query OSV and GitHub Advisory evidence for exact versions | A missing provenance statement proves maliciousness |
| Compare source and published artifact evidence | Static review replaces sandboxing or runtime testing |
| Check DSH bundle/profile compatibility without business execution | “Compatible” means the plugin is secure |
| Monitor old → new upstream observations | An LLM can repair evidence that was never collected |

## Install and connect to DSH

```bash
pnpm add upstream-radar

# Generate a reviewable DSH profile inventory from the installed profile
npx --yes upstream-radar@0.34.0 setup
```

For Feishu/webhook routing, DSH Agent handoff, observer state, report schemas, and troubleshooting, use the [full Chinese guide](docs/README.zh-CN.md). The [architecture notes](docs/architecture.md) explain the boundaries and evidence model.

## Development

```bash
pnpm install
pnpm test
pnpm run release:check
```

The project is Apache-2.0 licensed. Contributions that improve a real DSH plugin report, dependency resolution, advisory matching, or reproducible author feedback are especially welcome.
