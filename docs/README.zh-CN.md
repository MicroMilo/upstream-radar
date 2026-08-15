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

使用一个已经安装至少一个第三方 bundle 的 DSH profile，把 `web` 换成你的 profile 名称：

```bash
dsh plugin --profile web add upstream-radar@latest
pnpm dlx upstream-radar@latest init \
  --profile web \
  --project-name "我的 DSH 项目" \
  --workspace "$PWD" \
  --output ./upstream-radar.config.json
export UPSTREAM_RADAR_CONFIG=$PWD/upstream-radar.config.json
dsh --profile web
```

初始化命令会写出一份可审查的清单；只有设置 `UPSTREAM_RADAR_CONFIG` 后才会开始轮询。完整的状态文件、profile 边界和真实运行证明见[完整 DSH 配置](#安装到-dsh)。

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
pnpm dlx upstream-radar@latest init \
  --profile web \
  --project-name "我的 DSH 项目" \
  --workspace "$PWD" \
  --output ./upstream-radar.config.json
```

初始化命令会读取 profile 中实际安装的第三方 bundle，用禁用 lifecycle scripts 的方式解析每个精确 npm artifact，然后写出一份可审查的配置。它不会自行启动 DSH，也不会自行开启轮询。检查生成文件后，再指定清单、持久化状态文件并启动 profile：

```bash
export UPSTREAM_RADAR_CONFIG=$PWD/upstream-radar.config.json
export UPSTREAM_RADAR_STATE=$PWD/upstream-radar.state.json
export UPSTREAM_RADAR_INTERVAL_SECONDS=1800

dsh --profile web --dump-config
dsh --profile web
```

生成的依赖图对应已安装 bundle 版本的精确公共 npm artifact。如果你的 DSH profile 使用了 package-manager override、patch 或特殊的 peer 解析规则，开启持续监控前仍需要人工检查这些差异。

如果需要手写配置或制作 CI fixture，可以参考[示例清单](../examples/radar/config.json)。如果没有设置 `UPSTREAM_RADAR_CONFIG`，插件会保持休眠，不发起轮询。

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
- 发布者在 release notes 中明确声明 breaking change。

这些是交给项目分析的信号，不会被包装成“已经确认升级会坏”。

## 安全边界

版本是否命中、依赖路径和兼容边界由程序确定。漏洞公告、release notes、链接、包名和仓库文字始终是不可信数据。

DSH Agent 收到的任务要求：只读分析、引用项目证据、保留不确定性，并返回固定的[结果结构](../schemas/analysis-result.schema.json)。模型无法改写程序已经确认的匹配事实。

## 当前能力与边界

已经支持：npm lock 依赖图、重复版本路径、OSV 精确版本匹配、恶意包记录、npm release 监听、持久事件、DSH 原生投递，以及 Node/peer/exports/入口/bundle/版本边界检查。

`init --profile <name>` 已经可以发现指定的 DSH profile 并生成可审查清单；暂未支持自动选择当前 active profile、原生解析 pnpm override/peer 规则、Yarn 图适配、GitHub release 与迁移文档源、项目级 Session 精确路由、把 Agent 结论写回事件，以及自动创建 Issue 或 PR。

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
