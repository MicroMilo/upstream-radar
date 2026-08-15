<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>面向 DeepSeek Harness 插件的常驻依赖雷达：精确路径、破坏性更新信号，以及带项目证据的 Agent 跟进。</strong></p>

<p align="center">
  <a href="../README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm 版本" src="https://img.shields.io/npm/v/upstream-radar?style=flat-square&color=2563eb"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/MicroMilo/upstream-radar?style=flat-square&color=f59e0b"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/MicroMilo/upstream-radar/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="../examples/dsh/README.md"><img alt="已使用 DSH 0.1.0-rc.6 验证" src="https://img.shields.io/badge/tested_with_DSH-0.1.0--rc.6-5b5bd6?style=flat-square"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/MicroMilo/upstream-radar?style=flat-square"></a>
  <a href="../LICENSE"><img alt="Apache-2.0 许可证" src="https://img.shields.io/badge/license-Apache--2.0-0f766e?style=flat-square"></a>
</p>

## 60 秒开始

使用一个已经安装至少一个第三方 bundle 的 DSH profile。如果 DSH 中只有一个这样的 profile，初始化命令可以自动找到它：

```bash
dsh plugin --profile web add upstream-radar@latest
pnpm dlx --package=upstream-radar@latest upstream-radar init \
  --project-name "我的 DSH 项目" \
  --workspace "$PWD" \
  --output ./upstream-radar.config.json \
  --dsh-patch ./upstream-radar.dsh.yml
dsh --profile web --patch ./upstream-radar.dsh.yml
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

初始化命令会写出可审查的清单和 DSH overlay。检查两个文件后，用 `--patch` 启动，再用 `radar status` 在不重新请求网络的情况下确认第一次运行。如果有多个 DSH profile 含第三方 bundle，就显式传入 `--profile <name>`。完整的状态文件、兼容的旧环境变量方式、profile 边界和真实运行证明见[完整 DSH 配置](#安装到-dsh)。

如果只想先试跑一次监控，而不启动 DSH profile，可以使用同一份清单：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch ./upstream-radar.config.json --once
```

去掉 `--once` 就会持续运行。这个入口适合演示、CI 和排查；需要把任务交给在线 Agent 时，仍然应该安装 DSH bundle。

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="assets/upstream-radar-hero-mobile.jpg">
    <img src="assets/upstream-radar-hero.jpg" alt="Upstream Radar 监控依赖图，只高亮真正受影响的路径，并把一个信号交给 DSH Agent。" width="100%">
  </picture>
</p>

---

普通漏洞源到“某个包有问题”就结束了。Upstream Radar 会继续找到实际安装的依赖路径，维护一个可持续更新的事件，再把带有项目证据的调查任务交给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent。

```text
OSV 漏洞公告或 npm 新版本
  -> 真正命中的插件依赖路径
  -> new / updated / resolved 事件
  -> 面向具体项目的 DSH Agent 分析任务
```

**没有命中实际安装路径，就不会唤醒 Agent。** 版本匹配和兼容性事实由程序计算；模型只负责结合仓库做判断。

## 先看一个真实事件

同一个插件里安装了两个 `parser` 版本，而公告只影响其中一个时，Radar 会报告真正命中的路径：

```text
[HIGH][NEW] Dependency vulnerability
Project: Payments API (payments-api)
Plugin: plugin@1.0.0
Affected: parser@2.9.0
Origin: plugin profile
Advisory: GHSA-demo-2026-parser / CVE-2026-1234
Paths:
  plugin@1.0.0 -> logger@4.0.2 -> parser@2.9.0
Fixed versions: 3.0.0
Route: payments-platform via feishu:payments-security
```

这个事件会成为带有插件身份的 DSH notice，而不是被复制进一段泛泛的聊天提示词。

| 上游信号 | Radar 用程序确定 | DSH Agent 结合项目调查 |
| --- | --- | --- |
| 漏洞或恶意软件包 | 受影响的精确版本、每条安装路径、修复版本和事件状态 | 项目是否调用、攻击者输入能否到达、代价最低的修复办法 |
| npm 候选版本 | 版本边界，以及 Node、peer、exports、入口、bundle 和依赖变化 | 哪些 API 或 Cordis 配置会受影响、应该如何迁移 |

## 安装到 DSH

Upstream Radar 发布的是已经构建好的 npm bundle，不需要开放安装期构建权限：

```bash
dsh plugin --profile web add upstream-radar@latest
```

不用手写依赖图，可以直接从 DSH profile 生成项目清单：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar init \
  --project-name "我的 DSH 项目" \
  --workspace "$PWD" \
  --output ./upstream-radar.config.json \
  --dsh-patch ./upstream-radar.dsh.yml
```

初始化命令会读取 profile 中实际安装的第三方 bundle，并沿着该 profile 暴露的 `node_modules` 目录构建依赖图，包括重复版本、override 和本地 package-manager 选择。它只读取 manifest，不会导入插件代码、运行 lifecycle scripts、启动 DSH 或开启轮询。检查生成文件后，直接运行：

```bash
dsh --profile web --patch ./upstream-radar.dsh.yml --dump-config
dsh --profile web --patch ./upstream-radar.dsh.yml
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

`radar status` 只读取本地配置和状态，不会刷新 OSV/npm/GitHub；它会告诉你是否已经完成检查、依赖覆盖是否完整、哪个数据源异常、当前事件和待处理的 DSH 任务。如果不使用 `--dsh-patch`，仍可以使用原来的 `UPSTREAM_RADAR_CONFIG`、`UPSTREAM_RADAR_STATE` 和 `UPSTREAM_RADAR_INTERVAL_SECONDS` 环境变量方式。

生成的依赖图对应 profile 当前实际安装的树。DSH 还会在 `profiles/node_modules` 维护一层共享的宿主运行时依赖；Radar 会把从这里解析到的包纳入漏洞查询，并明确标成 `dsh-host`，不会和插件自己带的依赖混在一起。如果一个必需依赖在 profile 和宿主依赖平面中都找不到，它会保留为“覆盖不完整”，不会被当成安全或不存在。当前平台没有安装的可选原生包仍会记录，但不会制造“必需依赖缺失”的假警报。显式传入 `--registry <url>` 才会使用公共 npm artifact 图，适合和 registry 解析结果做比较，但不是默认路径。

如果需要手写配置或制作 CI fixture，可以参考[示例清单](../examples/radar/config.json)。如果既没有 `--patch` overlay，也没有设置 `UPSTREAM_RADAR_CONFIG`，插件会保持休眠，不发起轮询。

启动后，Radar 会轮询 OSV 与 npm，先把事件状态持久化，再把有变化的事件交给第一个在线的根 DSH Agent。

## 在真实 DSH 中运行证明

```bash
git clone https://github.com/MicroMilo/upstream-radar.git
cd upstream-radar
corepack enable
pnpm install --frozen-lockfile
pnpm run try:dsh
```

这个命令会把打包后的 bundle 安装进全新的 DSH `headless` profile。只有付费模型端点被本地确定性 stub 替代；Cordis loader、DSH Agent、Session、持久化和插件投递都是真实组件。

验证不满足以下四项就会失败：

```json
{
  "bundleInstalled": true,
  "radarTaskReachedModel": true,
  "pluginSourcePreserved": true,
  "pendingTasksAfterDelivery": 0
}
```

运行 `pnpm run try:dsh:live`，可以在 DSH 投递前加入一次当前 OSV 与 npm 数据轮询。

## 闭环如何工作

1. 读取项目清单和实际安装的 npm 依赖图。
2. 用每一个精确 `name@version` 查询 OSV。
3. 监听已安装插件和 DSH/Cordis 包的 npm 新版本。
4. 用真实依赖路径创建或更新一个持久事件。
5. 先把受约束的分析任务落盘，再尝试投递。
6. 通过 `ctx.agents.roots()[0].followup(...)` 唤醒在线 DSH Agent。
7. Agent 不在线时保留任务；事件解决后撤销过期任务。

如果需要在本地进程或定时任务里运行同一套监控，也可以使用：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch ./upstream-radar.config.json --interval 1800
```

CI 中使用 `--once --json`。它复用同一个状态文件，只输出新建、变化和恢复的事件。

投递消息保留明确的插件身份：

```json
{
  "kind": "plugin",
  "plugin": "upstream-radar",
  "form": "notice"
}
```

这是 DSH 原生生命周期集成，不是聊天机器人，也不是远程控制入口。

## 为什么只按包名告警不够

```text
plugin@1.0.0
├── framework@2.4.7
│   ├── parser@3.2.1
│   └── archive@1.8.0
└── logger@4.0.2
    └── parser@2.9.0
```

如果公告只影响 `parser@2.9.0`，它只会命中 `plugin -> logger -> parser` 这条分支。不受影响的 `parser@3.2.1` 仍然是独立的物理节点，不会变成按包名产生的误报。

## 不只监控漏洞，也监控 breaking changes

Radar 还会识别与 DSH 插件直接相关的升级边界：

- Node.js 版本不兼容；
- `@deepseek-ai/dsh-*` 或 `@deepseek-ai/cordis` peer 范围不兼容；
- `main`、`exports` 或 DSH bundle patch 路径变化；
- 依赖被移除；
- major 和 1.0 前的破坏性版本边界；
- 发布者在 release notes 中明确声明 breaking change；如果 npm 元数据指向公开 GitHub 仓库，Radar 还会按候选版本读取对应的 GitHub Release 说明。

这些是交给项目分析的信号，不会被包装成“已经确认升级会坏”。

## 安全边界

版本是否命中、依赖路径和兼容边界由程序确定。漏洞公告、release notes、链接、包名和仓库文字始终是不可信数据。

DSH Agent 收到的任务要求：只读分析、引用项目证据、保留不确定性，并返回固定的[结果结构](../schemas/analysis-result.schema.json)。模型无法改写程序已经确认的匹配事实。

## 当前能力与边界

已经支持：DSH profile 实际安装树和 npm lock 依赖图、重复版本路径、未解析依赖的覆盖提示、OSV 精确版本匹配、恶意包记录、npm release 监听、公开 GitHub Release 说明、OSV 故障时保留已确认状态、连续失败后的 source-health DSH notice、持久事件、DSH 原生投递，以及 Node/peer/exports/入口/bundle/版本边界检查。

`init` 在省略 `--profile` 时可以自动选择唯一一个含第三方 bundle 的 DSH profile；多个候选仍要求显式指定。默认读取实际安装树，因此 pnpm override 和本地解析选择会被纳入；原生解析 pnpm lockfile 以支持安装前/CI 检查仍未实现。加上 `--dsh-patch <path>` 可以生成不依赖环境变量的 DSH overlay。`radar status` 提供离线的首次运行检查，但不会替你刷新漏洞源。暂未支持 Yarn 图适配、changelog/比较 diff/迁移文档源、项目级 Session 精确路由、把 Agent 结论写回事件，以及自动创建 Issue 或 PR。

`radar watch` 是 CLI 监控入口，本身不会把任务投递给 DSH；需要 Agent 分析时应使用原生 DSH bundle。

Upstream Radar 目前是面向 DSH developer preview 生态的 alpha 软件，事件结构和适配边界仍可能变化。

## 项目文档

- [架构](architecture.md)
- [真实 DSH showcase](../examples/dsh/README.md)
- [产品愿景](vision.zh-CN.md)
- [检查项与证据](checks.zh-CN.md)
- [威胁模型](threat-model.md)
- [Roadmap](../ROADMAP.md)
- [Changelog](../CHANGELOG.md)
- [发布流程](releasing.md)
- [贡献指南](../CONTRIBUTING.md)
- [安全策略](../SECURITY.md)

如果 DSH 插件已经进入你的技术栈，欢迎 Star 并在 [GitHub Discussions](https://github.com/MicroMilo/upstream-radar/discussions) 里讨论真实场景。

<sub>DeepSeek Harness 社区项目，并非 DeepSeek 官方产品。Apache-2.0 许可。</sub>
