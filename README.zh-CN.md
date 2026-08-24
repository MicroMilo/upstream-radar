<h1 align="center">Upstream Radar</h1>

<p align="center"><strong>每次 DeepSeek Harness 发布后，在用户踩坑前找出哪些插件坏了。</strong></p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MicroMilo/upstream-radar/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/upstream-radar"><img alt="npm" src="https://img.shields.io/npm/v/upstream-radar"></a>
  <a href="https://github.com/MicroMilo/upstream-radar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/MicroMilo/upstream-radar"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

Upstream Radar 持续把一批真实插件发布物放到一次性隔离环境中，与不断变化的
[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)
版本重新配对测试。某个组合坏了，就生成一条可复现的 Issue；作者发布修复后，
Radar 会再次检查并关闭闭环。

**维护 100 个安装/加载目标 · 覆盖目录全部 21 个类别 · 4 条上游报告已关闭**

[最近一次 Agent 驱动的 headless 运行](https://github.com/MicroMilo/upstream-radar/actions/runs/32684879130)：
**观测 96 个可执行目录插件 · 74 个兼容 · 22 个需要复核 · 0 个复现不兼容 · 4 个仅源码目标**。
需要复核的信号不会被宣传成插件故障。

第一轮真实闭环从 29 个待复核插件开始。Agent 选择了 9 个受限重试，其中 7 个转为
兼容；另 2 个明确停在 Web 客户端依赖边界，没有被误报成插件坏了。

## 为什么需要它

仓库看起来正常，不代表用户实际安装的插件仍然可用。真实发布物必须同时适配某个
DSH 版本、Node 运行时、profile 和依赖组合；其中任何一项更新，都可能让插件一夜
之间失效。

Upstream Radar 检查的是这层真实关系，而不只是分别看两个仓库。本地发布前检查
回答“这个插件今天能不能过”；Radar 回答“生态变化后，维护中的哪些插件不再能过”。

## 完整闭环

```mermaid
flowchart TB
  Change["定时运行 / DSH 或插件变化"] --> Agent["Agent 规划受限的 headless 重试"]
  Agent --> Runtime["一次性虚拟机：安装 → 注册 → 加载"]
  Runtime -->|"出现下一层门槛"| Agent
  Runtime -->|"兼容 / 超出 headless"| Evidence["发布精确证据"]
  Runtime -->|"复现真实失败"| Issue["创建一条可修复的 Issue"]
  Issue -->|"作者发布修复"| Change
```

Agent 读取仓库说明和最新运行证据，决定 headless 是否重试、重试时允许哪些安装条件。
真正的结果由一次性虚拟机执行得出，而不是模型判断。模型不能凭空增加安装包、不能
进入目标虚拟机执行，也不能把缺失证据说成通过。

## 你会得到什么

- `插件版本 × DSH 版本 × Node/profile` 的精确结果，而不是永不过期的“兼容”标签。
- 把 Agent 规划的后续动作，与真实发布物的安装、注册、加载结果放在一起判断。
- DSH 或插件变化后自动重新检查，而不是只生成一次报告。
- 同一问题持续更新；回归时重新打开；干净复测通过后自动关闭。

## 已关闭的上游报告

以下报告由我们提出，目前均已被对应上游维护者关闭：

- [Sanqi-normal/dsh-webui-market-plugin#5](https://github.com/Sanqi-normal/dsh-webui-market-plugin/issues/5)
- [1na-ko/dsh-hdc-bridge#3](https://github.com/1na-ko/dsh-hdc-bridge/issues/3)
- [6Mikao9/dsh-wsl-workspace#6](https://github.com/6Mikao9/dsh-wsl-workspace/issues/6)
- [3274375092/dsh-voice#2](https://github.com/3274375092/dsh-voice/issues/2)

## 检查一个插件

```bash
npx --yes upstream-radar@0.43.0 review dsh-plugin \
  <包名>@<版本> \
  --dsh-version <DSH版本>
```

需要执行插件代码时，请使用仓库维护的
[隔离观察工作流](.github/workflows/observe-dsh-plugin-install.yml)：每个组合都会获得
一台全新的、无密钥的 GitHub 托管虚拟机和受限容器。

你还可以查看[实时兼容性矩阵](examples/dsh/install-observer/README.md)、
[可供目录消费的兼容性结果](feeds/dsh-plugin-compatibility.md)、
[第一批 50 个插件](examples/dsh/first-batch/README.md)和
[架构说明](docs/architecture.md)。

<p align="center">
  <strong>如果 Upstream Radar 对 DSH 生态有帮助，欢迎<a href="https://github.com/MicroMilo/upstream-radar">点一个 Star</a> ⭐</strong>
</p>
