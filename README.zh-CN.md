<p align="center">
  <img src="docs/assets/upstream-radar-hero.jpg" alt="Upstream Radar 监控依赖图，只高亮真正受影响的路径，并把一个信号交给 DSH Agent。" width="100%">
</p>

<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>只有当上游变化真正命中项目时，才唤醒你的 DSH Agent。</strong></p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm 版本" src="https://img.shields.io/npm/v/upstream-radar?style=flat-square&color=2563eb"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/MicroMilo/upstream-radar/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="examples/dsh/README.md"><img alt="已使用 DSH 0.1.0-rc.6 验证" src="https://img.shields.io/badge/tested_with_DSH-0.1.0--rc.6-5b5bd6?style=flat-square"></a>
  <a href="LICENSE"><img alt="Apache-2.0 许可证" src="https://img.shields.io/badge/license-Apache--2.0-0f766e?style=flat-square"></a>
</p>

---

普通漏洞源只能告诉你“某个包有问题”。它通常无法回答：这个精确版本是被哪个 DSH 插件带进来的、真实依赖路径是什么、项目是否会触发漏洞，以及升级时会不会顺手破坏 DSH 兼容性。

Upstream Radar 把这条链路闭合在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 内部：

- **看精确路径，不按包名猜。** 保留物理依赖节点、重复版本和真正命中的完整路径。
- **维护事件状态，不制造告警洪水。** 记录 `new`、`updated`、`resolved`，同一事件只保留当前任务。
- **程序先确定事实，模型只做判断。** 版本命中和兼容边界由程序计算；DSH Agent 只调查项目可达性和迁移影响。

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

要把当前 OSV 和 npm 数据也加入启动轮询：

```bash
pnpm run try:dsh:live
```

## 安装到 DSH

Upstream Radar 发布的是已经构建好的 npm bundle，不需要开放安装期构建权限：

```bash
dsh plugin --profile web add upstream-radar@0.4.0
```

指定项目清单和持久化状态文件后启动 profile：

```bash
export UPSTREAM_RADAR_CONFIG=/absolute/path/radar-config.json
export UPSTREAM_RADAR_STATE=/absolute/path/radar-state.json
export UPSTREAM_RADAR_INTERVAL_SECONDS=1800

dsh --profile web --dump-config
dsh --profile web
```

可以从[示例清单](examples/radar/config.json)开始。如果没有设置 `UPSTREAM_RADAR_CONFIG`，插件会保持休眠，不发起轮询。

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

## 一个真实命中的路径

```text
plugin@1.0.0
├── framework@2.4.7
│   ├── parser@3.2.1
│   └── archive@1.8.0
└── logger@4.0.2
    └── parser@2.9.0
```

如果公告只影响 `parser@2.9.0`，Radar 输出的是：

```text
[HIGH][NEW] Dependency vulnerability
Project: Payments API (payments-api)
Plugin: plugin@1.0.0
Affected: parser@2.9.0
Path: plugin@1.0.0 -> logger@4.0.2 -> parser@2.9.0
Fixed versions: 3.0.0
```

不受影响的 `parser@3.2.1` 仍然是独立节点。

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

DSH Agent 收到的任务要求：只读分析、引用项目证据、保留不确定性，并返回固定的[结果结构](schemas/analysis-result.schema.json)。模型无法改写程序已经确认的匹配事实。

## 当前能力与边界

已经支持：npm lock 依赖图、重复版本路径、OSV 精确版本匹配、恶意包记录、npm release 监听、持久事件、DSH 原生投递，以及 Node/peer/exports/入口/bundle/版本边界检查。

暂未支持：自动发现当前 DSH profile、pnpm/Yarn 图适配、GitHub release 与迁移文档源、项目级 Session 精确路由、把 Agent 结论写回事件，以及自动创建 Issue 或 PR。

Upstream Radar 目前是面向 DSH developer preview 生态的 alpha 软件，事件结构和适配边界仍可能变化。

## 项目文档

- [架构](docs/architecture.md)
- [真实 DSH showcase](examples/dsh/README.md)
- [产品愿景](docs/vision.zh-CN.md)
- [检查项与证据](docs/checks.zh-CN.md)
- [威胁模型](docs/threat-model.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

如果 DSH 插件已经进入你的技术栈，欢迎 Star 并在 [GitHub Discussions](https://github.com/MicroMilo/upstream-radar/discussions) 里讨论真实场景。

<sub>DeepSeek Harness 社区项目，并非 DeepSeek 官方产品。Apache-2.0 许可。</sub>
