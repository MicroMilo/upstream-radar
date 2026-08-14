<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="docs/assets/upstream-radar-hero-mobile.jpg">
    <img src="docs/assets/upstream-radar-hero.jpg" alt="Upstream Radar watches a dependency graph, highlights one affected path, and routes one signal to a DSH Agent." width="100%">
  </picture>
</p>

<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>Dependency changes that wake your DSH Agent only when your project is actually affected.</strong></p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm version" src="https://img.shields.io/npm/v/upstream-radar?style=flat-square&color=2563eb"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/MicroMilo/upstream-radar/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="examples/dsh/README.md"><img alt="Tested with DSH 0.1.0-rc.6" src="https://img.shields.io/badge/tested_with_DSH-0.1.0--rc.6-5b5bd6?style=flat-square"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/MicroMilo/upstream-radar?style=flat-square"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0f766e?style=flat-square"></a>
</p>

<p align="center">
  <a href="#run-the-proof">Run the proof</a> ·
  <a href="#install-in-dsh">Install in DSH</a> ·
  <a href="#how-the-loop-works">How it works</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

---

A vulnerability feed can tell you that a package is affected. It usually cannot tell you which DSH plugin brought that exact version into your profile, whether the vulnerable path reaches your project, or whether the available upgrade breaks DSH on the way out.

Upstream Radar closes that loop inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **Exact path, not a package-name guess.** It preserves physical dependency nodes, duplicate versions, and the root-to-package path that actually matched.
- **An incident, not alert spam.** It stores `new`, `updated`, and `resolved` state and keeps only the current task for each incident.
- **Program facts before model judgment.** Version matching and compatibility boundaries stay deterministic; the DSH Agent investigates only project-specific reachability and migration impact.

## Run the proof

Boot a real DSH `headless` profile with the packed Upstream Radar bundle installed:

```bash
git clone https://github.com/MicroMilo/upstream-radar.git
cd upstream-radar
corepack enable
pnpm install --frozen-lockfile
pnpm run try:dsh
```

No DeepSeek API key is required. The paid model endpoint is replaced by a deterministic local DeepSeek-compatible stub; the Cordis loader, DSH Agent, Session, persistence stack, bundle installation, and plugin delivery are real.

The command fails unless DSH proves all four facts:

```json
{
  "bundleInstalled": true,
  "radarTaskReachedModel": true,
  "pluginSourcePreserved": true,
  "pendingTasksAfterDelivery": 0
}
```

This proof runs in CI on Node.js 22. See the executable [showcase contract](examples/dsh/README.md) and its checked-in [result](examples/dsh/reports/headless-smoke.json).

To include a current OSV and npm poll before the DSH handoff:

```bash
pnpm run try:dsh:live
```

## Install in DSH

Upstream Radar is an npm-published DSH bundle, so no install-time build permission is required:

```bash
dsh plugin --profile web add upstream-radar@0.4.0
```

Point the bundle at an explicit project inventory, choose a durable state file, then boot the profile:

```bash
export UPSTREAM_RADAR_CONFIG=/absolute/path/radar-config.json
export UPSTREAM_RADAR_STATE=/absolute/path/radar-state.json
export UPSTREAM_RADAR_INTERVAL_SECONDS=1800

dsh --profile web --dump-config
dsh --profile web
```

Start from [the example inventory](examples/radar/config.json). If `UPSTREAM_RADAR_CONFIG` is not set, the bundle stays dormant and performs no polling.

## How the loop works

1. Read the project inventory and exact installed npm graph.
2. Query OSV with every installed `name@version` pair.
3. Watch npm releases for the installed plugin and DSH/Cordis packages.
4. Create or update one durable incident with the exact dependency path.
5. Persist a constrained analysis task before delivery.
6. Send a plugin-originated follow-up to the first live root DSH Agent.
7. Keep the task on disk when no Agent is available; cancel it when the incident resolves.

The handoff uses `ctx.agents.roots()[0].followup(...)` with:

```json
{
  "kind": "plugin",
  "plugin": "upstream-radar",
  "form": "notice"
}
```

It is a native DSH lifecycle integration—not a chat bridge or a remote-control bot.

## One vulnerable path, not a false-positive package name

Given this installed graph:

```text
plugin@1.0.0
├── framework@2.4.7
│   ├── parser@3.2.1
│   └── archive@1.8.0
└── logger@4.0.2
    └── parser@2.9.0
```

an advisory affecting only `parser@2.9.0` produces:

```text
[HIGH][NEW] Dependency vulnerability
Project: Payments API (payments-api)
Plugin: plugin@1.0.0
Affected: parser@2.9.0
Path: plugin@1.0.0 -> logger@4.0.2 -> parser@2.9.0
Fixed versions: 3.0.0
```

The unaffected `parser@3.2.1` remains a distinct node.

## Vulnerabilities are only half the upstream problem

Upstream Radar also watches candidate releases for compatibility boundaries that matter to DSH plugins:

- Node.js engine exclusions;
- incompatible `@deepseek-ai/dsh-*` or `@deepseek-ai/cordis` peer ranges;
- changed `main`, `exports`, or DSH bundle patch paths;
- removed dependencies;
- major and pre-1.0 breaking version boundaries;
- publisher-declared breaking changes in supplied release notes.

These are signals for project analysis, not automatic claims that an upgrade is broken.

## The model gets judgment, not control of the facts

Upstream Radar determines facts that a model must not guess:

```text
parser@2.9.0 is reported as affected
plugin -> logger -> parser is the installed path
the project runs Node.js 22
the candidate requires Node.js >=24
the installed DSH peer is outside the candidate range
```

The DSH Agent answers the repository-specific questions:

```text
is the vulnerable feature reachable here?
can attacker-controlled input reach it?
which API or Cordis configuration would the upgrade disturb?
what is the least disruptive project-specific action?
```

Advisories, release notes, links, package names, and repository strings remain untrusted data. The generated task requires read-only analysis, project evidence, explicit uncertainty, and a fixed [result schema](schemas/analysis-result.schema.json).

## What works today

- npm lockfile graphs with duplicate versions and bounded dependency paths;
- exact-version OSV vulnerability and malicious-package matching;
- npm release monitoring for plugins and DSH/Cordis packages;
- durable incident state with current-task replacement and resolution;
- native DSH bundle installation, startup polling, `agent/created` retry, and plugin-source attribution;
- compatibility signals for Node.js, peers, exports, entrypoints, bundle paths, dependencies, and version boundaries;
- network-free Radar and real DSH runtime showcases.

The bounded pre-install scanner remains available as a supporting collector:

```bash
upstream-radar scan /path/to/dsh-plugin
upstream-radar inspect npm:dsh-cloudflare-browser-run@0.1.1 --deep
```

## Current boundaries

- Project inventory is explicit JSON; active DSH profile discovery is not implemented yet.
- npm lock graphs are supported; pnpm and Yarn graph adapters are not implemented.
- OSV and npm `latest` are the live sources; GitHub release and migration-guide ingestion are deferred.
- Delivery currently targets the first live root Agent rather than a project-specific session.
- Agent conclusions stay in the DSH Session; Radar does not ingest them back into incident state yet.
- No Issue, branch, Pull Request, dependency override, or merge is created automatically.

Upstream Radar is alpha software built for the developer-preview DSH ecosystem. Event schemas and adapter boundaries can change.

## Project guide

- [Architecture](docs/architecture.md)
- [DSH headless showcase](examples/dsh/README.md)
- [Radar showcase walkthrough](docs/showcase.md)
- [Product vision（中文）](docs/vision.zh-CN.md)
- [Checks and evidence（中文）](docs/checks.zh-CN.md)
- [Threat model](docs/threat-model.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

If DSH plugins are part of your stack, star the repository to follow the upstream safety loop as it grows. Questions and design feedback are welcome in [GitHub Discussions](https://github.com/MicroMilo/upstream-radar/discussions).

<sub>Community project for DeepSeek Harness. Not an official DeepSeek product. Apache-2.0 licensed.</sub>
