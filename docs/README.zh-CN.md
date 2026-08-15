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

使用一个已经安装至少一个第三方 bundle 的 DSH profile，把 `web` 换成你的 profile 名称。下面的命令分成两个终端，因为 DSH 通常会持续运行：

```bash
# 终端 1
dsh plugin --profile web add upstream-radar@latest
pnpm dlx --package=upstream-radar@latest upstream-radar init \
  --profile web \
  --project-name "我的 DSH 项目" \
  --workspace "$PWD" \
  --output ./upstream-radar.config.json \
  --dsh-patch ./upstream-radar.dsh.yml
pnpm dlx --package=upstream-radar@latest upstream-radar doctor ./upstream-radar.config.json \
  --profile web \
  --patch ./upstream-radar.dsh.yml
dsh --profile web --patch ./upstream-radar.dsh.yml
```

DSH 启动后，在第二个终端执行只读状态检查：

```bash
# 终端 2
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

初始化命令会写出可审查的清单和 DSH overlay。`doctor` 会在 DSH 启动前检查本地接线；`radar status` 会在不重新请求网络的情况下确认第一次完整检查。完整的状态文件、兼容的旧环境变量方式、profile 边界和真实运行证明见[完整 DSH 配置](#安装到-dsh)。

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

## 关键的一层：候选版本的传递依赖图

升级版本自身没有漏洞，不代表升级后的依赖树没有漏洞。Radar 不只看 `plugin@1.3.0` 的 manifest，还会对最早的一小段候选版本解析临时依赖图：

```text
候选 plugin@1.1.0
└── logger@4.1.0
    └── parser@2.9.0  ← OSV 公告
```

解析时使用临时目录、`package-lock-only` 和 `ignore-scripts`，不导入、不执行候选插件代码；随后把图中的每个精确版本交给 OSV，并把漏洞所在的完整路径放入兼容性事件。如果必需依赖无法解析、解析器失败，或者 OSV 查询失败，结果会明确标成“不完整”或“不可用”，不会把“没有查到”说成“安全”。候选版本过多时，后面的版本会标成尚未检查；即使给出第一个候选，也只是交给 DSH 做项目分析的起点，不是升级证书。

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
| npm 候选版本 | 版本边界，以及 Node、peer、exports、入口、bundle 和依赖变化；直接依赖与传递依赖的 OSV 结果 | 哪些 API 或 Cordis 配置会受影响、应该如何迁移；第一个候选永远不是安全证书 |

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

如果启动结果不对，先运行本地接线检查，不需要访问漏洞源：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar doctor ./upstream-radar.config.json \
  --profile web \
  --patch ./upstream-radar.dsh.yml
```

`doctor` 不访问 OSV、npm 或 GitHub，也不执行插件代码。它检查配置是否能解析、选中的 DSH profile 是否真的登记了 `upstream-radar`、overlay 是否指向同一份配置和状态文件、依赖覆盖是否完整，以及状态文件是否可读。只有接线被阻断时才返回非零；第一次还没有状态文件会显示为警告，并给出下一条命令。需要给其他工具读取时加上 `--json`。

生成的 overlay 会记录选中的 profile；如果初始化时传入了 `--registry <url>`，它也会被带入 DSH 运行时，避免后续 release 和候选依赖检查悄悄切回公共 npm。原生 DSH 每次轮询前，以及 CLI 的 `radar check/watch` 每次轮询前，都会重新读取这个 profile 的实际依赖图，因此之后安装、升级、卸载插件，或 DSH 宿主运行时发生变化时，不会继续悄悄监控旧快照；如果重读失败，本轮会停止，不会替换最后一次持久化状态。`radar status` 仍然只读取本地配置和状态，不会刷新 OSV/npm/GitHub；它还会列出最重要的活动事件、精确依赖路径或候选信号，以及建议的下一步。`radar compare` 也只比较你明确提供的文件。如果不使用 `--dsh-patch`，仍可以使用 `UPSTREAM_RADAR_CONFIG`、`UPSTREAM_RADAR_STATE`、`UPSTREAM_RADAR_INTERVAL_SECONDS`、`UPSTREAM_RADAR_REGISTRY` 和 `UPSTREAM_RADAR_DEEP_CANDIDATES` 环境变量方式。

生成的依赖图对应 profile 当前实际安装的树。DSH 还会在 `profiles/node_modules` 维护一层共享的宿主运行时依赖；Radar 会把从这里解析到的包纳入漏洞查询，并明确标成 `dsh-host`，不会和插件自己带的依赖混在一起。如果一个必需依赖在 profile 和宿主依赖平面中都找不到，它会保留为“覆盖不完整”，不会被当成安全或不存在。当前平台没有安装的可选原生包仍会记录，但不会制造“必需依赖缺失”的假警报。显式传入 `--registry <url>` 才会使用公共 npm artifact 图，适合和 registry 解析结果做比较，但不是默认路径。

如果需要手写配置或制作 CI fixture，可以参考[示例清单](../examples/radar/config.json)。如果既没有 `--patch` overlay，也没有设置 `UPSTREAM_RADAR_CONFIG`，插件会保持休眠，不发起轮询。

启动后，Radar 会轮询 OSV 与 npm，先把事件状态持久化，再把有变化的事件交给第一个在线的根 DSH Agent。

每轮发现新版本时，默认还会检查最早的一小段候选依赖图。CLI 可以用 `--no-deep-candidates` 显式关闭；原生 DSH 配置可以设置 `deepCandidates: false`。这项解析在临时目录中运行 `npm install --package-lock-only --ignore-scripts`，只解析 manifest 和 lockfile，不加载或执行候选代码。

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

同一轮 DSH 运行时升级如果同时改动多个 `@deepseek-ai/dsh-*` 包，Radar 仍然逐包保存状态和证据，但交给 Agent 时会合并成一个 notice。用户只需要处理一个整体升级问题，之后每个包仍然可以独立更新或恢复。

## 当前能力与边界

已经支持：DSH profile 实际安装树和 npm lock 依赖图、重复版本路径、未解析依赖的覆盖提示、OSV 精确版本匹配、恶意包记录、npm release 监听（只接受高于当前安装版本的候选；npm 的 `latest` 回退不会制造 breaking 告警；最新版本有确定性阻断时会检查历史候选的 OSV 状态和最早一小段传递依赖图，并筛出第一个没有确定性阻断且没有已知漏洞路径、值得交给 DSH 分析的候选；图不完整、图解析或 OSV 失败时不推荐候选）、公开 GitHub Release 说明、OSV 故障时保留已确认状态、连续失败后的 source-health DSH notice、持久事件、DSH 原生投递，以及 Node/peer/exports/入口/bundle/版本边界检查；还包括不联网的 `doctor` 接线检查。

`init` 在省略 `--profile` 时可以自动选择唯一一个含第三方 bundle 的 DSH profile；多个候选仍要求显式指定。默认读取实际安装树，因此 pnpm override 和本地解析选择会被纳入；原生解析 pnpm lockfile 以支持安装前/CI 检查仍未实现。加上 `--dsh-patch <path>` 可以生成不依赖环境变量的 DSH overlay。`radar status` 提供离线的首次运行检查、活动事件摘要和下一步提示，但不会替你刷新漏洞源，也不会自动升级插件。暂未支持 Yarn 图适配、changelog/比较 diff/迁移文档源、项目级 Session 精确路由、把 Agent 结论写回事件，以及自动创建 Issue 或 PR。

`radar watch` 是 CLI 监控入口，本身不会把任务投递给 DSH；需要 Agent 分析时应使用原生 DSH bundle。

`doctor` 只检查本地接线，不能证明 DSH 进程已经把任务交给模型，也不能证明漏洞源当前可用。

候选依赖图默认只覆盖按版本排序的有限前缀，后续未查询版本会在事件中显示为未完整检查。遇到 registry 或 OSV 不可用时，Radar 保留不确定性并发出告警，不会生成“已安全”的结论。

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
