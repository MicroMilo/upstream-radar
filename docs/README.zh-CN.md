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

## 先选最小入口

| 你的目标 | 从这里开始 | 你会得到什么 |
| --- | --- | --- |
| 让在线 DSH Agent 持续跟进 | [`setup`](#安装到-dsh) | 自动刷新 profile 里的实际依赖图，只把有变化的事件交给对应项目的 Agent。 |
| 加一个定时 CI 门禁 | [GitHub Actions 示例](../examples/github-actions/upstream-radar.yml) | 基于审查过的依赖图执行冻结检查，同时输出简短 Job Summary 和机器可读 JSON。 |
| 安装插件前先检查它 | [npm/pnpm 锁文件的 `graph` / `init`](#安装前先检查-npm-或-pnpm-锁文件) | 不运行插件或 lifecycle script，直接得到精确依赖路径和 OSV 结果。 |
| 审查一个精确的发布物 | `upstream-radar inspect npm:<包名>@<精确版本> --deep` | 查看单个版本的包、依赖、漏洞和 provenance 证据。 |

需要结合项目代码做判断时，选第一条；只需要独立的准入或回归门禁时，选第二或第三条，不需要启动 DSH profile。

## 60 秒开始

使用一个已经安装至少一个第三方 bundle 的 DSH 环境。如果只有一个这样的 profile，`setup` 会自动选择；只有多个 profile 时才需要传 `--profile <名称>`。下面的命令分成两个终端，因为 DSH 通常会持续运行：

```bash
# 终端 1
pnpm dlx --package=upstream-radar@latest upstream-radar setup \
  --project-name "我的 DSH 项目"
# 使用 setup 输出的 profile 名称；这里的 web 只是示例。
dsh --profile web --patch ./upstream-radar.dsh.yml
```

DSH 启动后，在第二个终端执行只读状态检查：

```bash
# 终端 2
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

`setup` 会明确调用 DSH 的安装命令，把当前正在运行的精确 Radar 版本放进选中的 profile，然后默认写出当前目录下的 `upstream-radar.config.json` 和 `upstream-radar.dsh.yml`，并运行不联网的本地接线检查。它不会启动 DSH，也不会执行插件业务动作；检查生成文件后再启动。需要其他位置时传 `--output` 或 `--dsh-patch`；已经安装过 bundle 时加 `--no-install`。`radar status` 会在不重新请求网络的情况下确认第一次完整检查。完整的状态文件、兼容的旧环境变量方式、profile 边界和真实运行证明见[完整 DSH 配置](#安装到-dsh)。

同一个状态文件还会保留一份有上限的变化记录。想知道“什么时候发生了什么”，而不重新请求任何漏洞源，可以运行：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar history ./upstream-radar.config.json
```

它会显示 `new`、`updated`、`resolved` 以及漏洞源健康变化，并保留真正命中的依赖路径。加 `--json` 可以交给 dashboard 或 relay；默认只保留最近 1000 条变化，并按稳定事件 id 去重。

如果只想先试跑一次监控，而不启动 DSH profile，可以使用同一份清单：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch ./upstream-radar.config.json --once
```

去掉 `--once` 就会持续运行。这个入口适合演示、CI 和排查；需要把任务交给在线 Agent 时，仍然应该安装 DSH bundle。

如果还要把事件通知发到团队自己的 HTTPS 接口，可以把地址放在环境变量里，不要写进提交的配置和状态文件：

```bash
export UPSTREAM_RADAR_WEBHOOK_URL='https://alerts.example.test/upstream-radar?token=replace-me'

# 原生 DSH：bundle 会在运行时读取这个变量
dsh --profile web --patch ./upstream-radar.dsh.yml

# 或使用 CLI 的持久化一次检查/持续监控
pnpm dlx --package=upstream-radar@latest upstream-radar radar watch \
  ./upstream-radar.config.json --webhook "$UPSTREAM_RADAR_WEBHOOK_URL"
```

Webhook 只发送 `new`、`updated`、`resolved` 变化（包括漏洞源健康变化），格式是有界的 `upstream-radar.webhook/v1alpha1` JSON，具体字段见[schema](../schemas/webhook.schema.json)。收到 HTTP 2xx 后才记录事件 id；请求失败会在下一轮继续重试。状态文件只保存 endpoint 的 SHA-256 指纹和已发送事件 id，不保存 URL 或 token。普通 HTTPS 接口仍然收到供应商无关的 JSON，可以由 relay 转成飞书或 Slack 卡片；如果使用飞书/Lark V2 自定义机器人，Radar 会识别 `/open-apis/bot/v2/hook/` 地址并直接发送原生文本消息：

```bash
export UPSTREAM_RADAR_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/替换成真实 token'
# 只有飞书机器人开启签名校验时才需要设置。
export UPSTREAM_RADAR_FEISHU_SECRET='替换成真实密钥'

dsh --profile web --patch ./upstream-radar.dsh.yml
```

飞书密钥只从环境变量读取，不会写入 Radar 配置或状态文件。创建机器人时可参考[飞书官方自定义机器人指南](https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN?lang=zh-CN)。请使用 V2 地址；旧的 `/open-apis/bot/hook/` 地址会被明确拒绝。运行 `pnpm run showcase:webhook` 可以在不访问真实接口的情况下看到去重和重试。

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

## 安装前先检查 npm 或 pnpm 锁文件

如果 DSH 插件使用 pnpm 管理依赖，可以在把它放进 DSH profile 前先看清锁定的依赖树：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar graph pnpm-lock \
  ./pnpm-lock.yaml \
  --json
```

这个命令只读锁文件，不会运行 `pnpm install`、安装脚本、插件代码，也不会联网。它支持 pnpm v6/v9 的包定位方式、peer 上下文的不同版本、重复版本，以及 `importers` 中声明的项目根。如果一个依赖存在多个 peer 上下文而锁文件没有足够信息，结果会保留“不确定”，不会擅自猜一个。输出的 JSON 与 Radar 的 OSV 路径匹配使用同一种依赖图格式，因此可以在 CI 中先审查这棵图，再决定是否让插件进入 DSH。运行 `pnpm run showcase:pnpm-lock` 可以看真实仓库示例。

如果要把它直接变成可监控配置，再运行第一次漏洞检查：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar init \
  --pnpm-lock ./pnpm-lock.yaml \
  --project-name "我的 DSH 插件"

pnpm dlx --package=upstream-radar@latest upstream-radar radar check \
  ./upstream-radar.config.json --frozen --fail-on high
```

`init --pnpm-lock` 不需要 DSH profile，只会生成普通 Radar 配置；`radar check` 随后查询锁定的精确版本，并产生与 DSH 监控相同的事件格式。插件真正安装进 DSH、需要交给在线 Agent 做项目分析时，再使用原生 DSH 的 `setup` 路径。运行 `pnpm run showcase:pnpm-lock:monitor` 可以本地看到从锁文件到 OSV 漏洞事件的完整链路。

如果 `package.json` 与 `pnpm-lock.yaml` 在同一目录，`--root` 可以省略，Radar 会从 manifest 读取精确的包名和版本。锁文件来自其他 workspace，或你希望明确指定接入坐标时，再传入 `--root`。

npm 项目使用完全相同的入口，只需把锁文件类型换成 `npm-lock`：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar graph npm-lock \
  ./package-lock.json --json

pnpm dlx --package=upstream-radar@latest upstream-radar init \
  --npm-lock ./package-lock.json \
  --project-name "我的 DSH 插件"
```

对于 npm 项目根，Radar 读取锁文件中的 `packages[""]`，并排除根包仅用于开发的依赖。两个入口都不会安装包、运行 lifecycle script、加载插件代码或联网；后续 `radar check` 才会查询 OSV。

运行 `pnpm run showcase:npm-lock:monitor` 可以本地看到这条 npm 锁文件到 OSV 再到 DSH 事件的确定性证明。

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
pnpm dlx --package=upstream-radar@latest upstream-radar setup \
  --project-name "我的 DSH 项目"
```

如果只有一个 DSH profile 含有第三方 bundle，`setup` 会自动选择；有多个候选时再传 `--profile <名称>`。`setup` 会使用当前命令对应的精确 Radar 版本调用 DSH 安装器，默认生成 `upstream-radar.config.json` 和 `upstream-radar.dsh.yml`，并运行不联网的 `doctor`。它不会启动 DSH。检查两个生成文件后启动 profile：

```bash
dsh --profile web --patch ./upstream-radar.dsh.yml --dump-config
dsh --profile web --patch ./upstream-radar.dsh.yml
pnpm dlx --package=upstream-radar@latest upstream-radar radar status ./upstream-radar.config.json
```

如果 bundle 已经在 profile 中，加入 `--no-install`。如果你想把安装单独拿出来审查，也可以使用底层路径：先运行 `dsh plugin --profile web add upstream-radar@<精确版本>`，再运行 `init --profile web --dsh-patch ...` 和 `doctor`。

初始化命令会读取 profile 中实际安装的第三方 bundle，并沿着该 profile 暴露的 `node_modules` 目录构建依赖图，包括重复版本、override 和本地 package-manager 选择。默认把 workspace 写成 `.`，因此配置可以提交并在另一台机器复用；请从项目根目录启动 DSH。如果 DSH 从其他目录启动，再传入 `--workspace <绝对路径>`。它只读取 manifest，不会导入插件代码、运行 lifecycle scripts、启动 DSH 或开启轮询。

如果启动结果不对，先运行本地接线检查，不需要访问漏洞源：

```bash
pnpm dlx --package=upstream-radar@latest upstream-radar doctor ./upstream-radar.config.json \
  --profile web \
  --patch ./upstream-radar.dsh.yml
```

`doctor` 不访问 OSV、npm 或 GitHub，也不执行插件代码。它检查配置是否能解析、选中的 DSH profile 是否真的登记了 `upstream-radar`、overlay 是否指向同一份配置和状态文件、依赖覆盖是否完整，以及状态文件是否可读。如果设置了 `UPSTREAM_RADAR_WEBHOOK_URL`，它还会在本地检查 HTTPS 地址、识别飞书/Lark V2 地址，并在第一次轮询前拦住已经废弃的 V1 地址；它不会打印 webhook 地址或 `UPSTREAM_RADAR_FEISHU_SECRET`。只有接线被阻断时才返回非零；第一次还没有状态文件会显示为警告，并给出下一条命令。需要给其他工具读取时加上 `--json`。

生成的 overlay 会记录选中的 profile；如果初始化时传入了 `--registry <url>`，它也会被带入 DSH 运行时，避免后续 release 和候选依赖检查悄悄切回公共 npm。原生 DSH 每次轮询前，以及 CLI 的 `radar check/watch` 每次轮询前，都会重新读取这个 profile 的实际依赖图，因此之后安装、升级、卸载插件，或 DSH 宿主运行时发生变化时，不会继续悄悄监控旧快照；如果重读失败，本轮会停止，不会替换最后一次持久化状态。`radar status` 仍然只读取本地配置和状态，不会刷新 OSV/npm/GitHub；它还会列出最重要的活动事件、精确依赖路径或候选信号，以及建议的下一步。`radar history` 同样只读同一份状态文件，会显示已经恢复、因此不再出现在活动列表里的事件。`radar compare` 也只比较你明确提供的文件。如果不使用 `--dsh-patch`，仍可以使用 `UPSTREAM_RADAR_CONFIG`、`UPSTREAM_RADAR_STATE`、`UPSTREAM_RADAR_INTERVAL_SECONDS`、`UPSTREAM_RADAR_REGISTRY` 和 `UPSTREAM_RADAR_DEEP_CANDIDATES` 环境变量方式。

生成的依赖图对应 profile 当前实际安装的树。原生 DSH 运行时，Radar 还会从确切的 DSH CLI 入口（`@deepseek-ai/dsh/lib/bin.js`）找到这个 DSH 进程实际使用的 `node_modules` 宿主依赖平面。这个过程只做有边界的 manifest 读取，不 import DSH、不加载插件代码，也不运行安装脚本。宿主平面中被实际解析到的包会纳入漏洞查询，并明确标成 `dsh-host`，不会和插件自己带的依赖混在一起；`radar status` 还会显示宿主图来自“正在运行的 DSH”还是 profile fallback。如果一个必需依赖在 profile 和宿主依赖平面中都找不到，它会保留为“覆盖不完整”，不会被当成安全或不存在。当前平台没有安装的可选原生包仍会记录，但不会制造“必需依赖缺失”的假警报。对于 `@deepseek-ai/dsh-*`、Cordis 这类宿主 peer，如果 profile 没有暴露准确版本，`doctor` 和 `radar status` 会单独写明“DSH 宿主依赖未观察到”，而不是把它和普通缺失依赖混成一个数字。这意味着漏洞查询没有覆盖该宿主边界，结果不能当作完整安全结论。显式传入 `--registry <url>` 才会使用公共 npm artifact 图，适合和 registry 解析结果做比较，但不是默认路径。

如果需要手写配置或制作 CI fixture，可以参考[示例清单](../examples/radar/config.json)。如果既没有 `--patch` overlay，也没有设置 `UPSTREAM_RADAR_CONFIG`，插件会保持休眠，不发起轮询。

启动后，Radar 会轮询 OSV、npm 和公开 GitHub Release，先把事件状态持久化，再把有变化的事件交给项目 workspace 对应的根 DSH Agent。只有一个 root 时保持自动投递；有多个 root 且无法精确匹配 workspace 时，任务会留在队列中，不会误投给另一个项目。原生适配器会记录准确的消息 id、DSH 会话、task id 和 event id；只有同一会话产生的 `assistant/message`，且可解析为固定六字段 JSON，才会写入 `analysisResults`。事件发生更新后，旧结论会被清掉，过期模型回复不会覆盖新事实。

检查持久化结论：

```bash
upstream-radar analysis list ./upstream-radar.config.json.state.json
upstream-radar analysis show ./upstream-radar.config.json.state.json
```

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

验证不满足以下五项就会失败：

```json
{
  "bundleInstalled": true,
  "radarTaskReachedModel": true,
  "pluginSourcePreserved": true,
  "pendingTasksAfterDelivery": 0,
  "analysisResults": 1,
  "dshEntrypointObserved": true,
  "dshHostRuntimePlaneDiscovered": true
}
```

运行 `pnpm run try:dsh:live`，可以在 DSH 投递前加入一次当前 OSV 与 npm 数据轮询。

如果要专门证明“宿主运行时依赖也会被监控”，运行 `pnpm run showcase:dsh-runtime`。它会启动真实的 DSH `headless` 进程，从该进程实际使用的 `node_modules` 刷新插件依赖图，查询本地 OSV 兼容 feed 中针对真实 `@deepseek-ai/cordis` 版本的确定性演示漏洞，把带有 `dsh-host` 来源和完整依赖路径的事件写入状态，再交给 DSH Agent。模型和漏洞 feed 都是本地 stub；它证明的是接线、来源和持久化，不是真实漏洞的安全结论。使用 `pnpm run showcase:dsh-runtime:report` 可以更新[宿主运行时结果](../examples/dsh/reports/dsh-runtime-host.json)。

## 验证兼容性规则

在把项目接入兼容性门禁前，可以先运行离线规则 benchmark：

```bash
pnpm dlx --package=upstream-radar@0.33.0 upstream-radar benchmark compatibility
```

它覆盖六类契约：安全补丁、只需要项目分析的变化、不兼容的 DSH peer、发布者明确声明 breaking、候选传递依赖漏洞，以及候选依赖图不完整。这个命令不会联网、安装包、加载插件或启动 DSH；它验证的是 Radar 的确定性规则以及 `breaking`/`any` 门禁行为，不是运行时兼容性证明。

## 实测一个 DSH bundle 能否加载

如果手上已经有一个精确的插件发布物，想知道某个精确 DSH 版本能不能加载它，可以运行一次性探针：

```bash
# 打包精确版本，并明确不运行它的 lifecycle script。
npm pack --ignore-scripts dsh-plugin@1.2.3

pnpm dlx --package=upstream-radar@0.33.0 upstream-radar probe dsh-load \
  ./dsh-plugin-1.2.3.tgz \
  --dsh-version 0.1.0-rc.6
```

探针先读取 tarball，要求包内存在 `dsh.bundle.patch`，并拒绝声明了 lifecycle script 的包。然后它会创建一次性的 DSH `headless` profile，安装这个精确 tarball，确认 DSH 已登记 bundle，再运行 `--dump-config`。除非传入 `--keep-profile`，临时 profile 会在结束时删除。

结果故意只有三种：

| 结果 | 白话含义 | 退出码 |
| --- | --- | ---: |
| `compatible` | 这个 DSH 版本登记了 bundle，并成功加载了它的配置。 | `0` |
| `incompatible` | DSH 接受了安装，但登记或加载配置时拒绝了它。 | `2` |
| `unknown` | 预检查、DSH 启动、安装或超时让我们无法可靠下结论。 | `1` |

这只是“能不能加载”的兼容性检查：它不会执行插件业务动作，不测试模型效果，也不能证明包及其依赖安全。仓库里有一个可重复的三案例子：

```bash
pnpm run showcase:dsh-probe
```

它会展示一个能加载的 bundle、一个被 DSH 拒绝的 bundle，以及一个因为声明了 `postinstall` 而只能得到 `unknown` 的包。

如果要比较多个 DSH 版本，可以使用矩阵入口：

```bash
pnpm dlx --package=upstream-radar@0.33.0 upstream-radar probe dsh-matrix \
  ./dsh-plugin-1.2.3.tgz \
  --dsh-version 0.1.0-rc.3 \
  --dsh-version 0.1.0-rc.6 \
  --json
```

它会把同一个发布物依次放进不同的临时 profile 中测试。矩阵至少需要两个不同的精确版本，最多八个。只要有一个版本不兼容，汇总就是 `incompatible`；没有不兼容但有 `unknown`，汇总就是 `unknown`；只有全部通过才是 `compatible`。

JSON 结果结构见[矩阵结果 schema](../schemas/dsh-load-matrix.schema.json)。

## 在 GitHub Actions 中运行

如果团队想先用定时 CI 检查，而不是马上在 runner 里安装 DSH，可以把审查过的 `upstream-radar.config.json` 提交到仓库，然后复制[示例 workflow](../examples/github-actions/upstream-radar.yml)。现在可以直接使用可复用的 GitHub Action，workflow 只需要两个关键步骤；需要时再增加一个 DSH 加载兼容性步骤：

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: MicroMilo/upstream-radar@v0.33.0
    with:
      config: upstream-radar.config.json
      fail-on: high
      # 可选：把确定性的 DSH/插件兼容性破坏也作为 CI 失败条件
      fail-on-compatibility: breaking
```

这个 Action 只是 `radar check --frozen --state :memory: --fail-on high --fail-on-compatibility breaking --json` 的薄封装。`--frozen` 是有意的：它只使用配置文件里的依赖图，不会尝试读取 runner 上不存在的本地 DSH profile。每次运行彼此独立；发现达到阈值的漏洞或选择的兼容性变化时返回 `2`，运行或漏洞源出错时返回 `1`。`breaking` 只拦截有 confirmed/strong 信号的兼容性事件，`any` 会拦截所有活动兼容性事件，默认值是 `never`。除了原始 JSON 日志，Action 还会把经过转义的简短摘要写入 GitHub Job Summary，定时任务失败时可以直接看到受影响的包和准确依赖路径。这个入口不会投递 DSH Agent 任务，也不会修改分支；需要持续监控和项目级分析时，仍使用原生 DSH bundle。建议把 Action 固定到类似 `v0.33.0` 的发布标签，并根据团队策略固定 checkout Action。

如果仓库只有 pnpm 锁文件，还没有提交 Radar 配置，可以让 Action 在同一个 job 中生成配置；可直接复制[pnpm workflow 示例](../examples/github-actions/upstream-radar-pnpm.yml)：

```yaml
- uses: MicroMilo/upstream-radar@v0.33.0
  with:
    pnpm-lock: pnpm-lock.yaml
    fail-on: high
```

这个模式会先执行 `init --pnpm-lock`，再执行同一个 frozen 检查。`root` 在锁文件旁有 `package.json` 时可以省略；如果是其他 workspace 或希望显式指定根包，也可以传入它。它不会安装项目，也不会执行插件；`config` 是生成文件的路径（默认 `upstream-radar.config.json`）。不填写 `pnpm-lock` 就仍然使用上面的已审查配置模式。

npm 项目可以改用 `npm-lock: package-lock.json`；`pnpm-lock` 和 `npm-lock` 不能同时填写。两种模式都会从锁文件旁的 `package.json` 推断根包，必要时再用 `root` 覆盖。
对应的可复制示例见[npm workflow](../examples/github-actions/upstream-radar-npm.yml)。

调用方需要先 checkout 仓库。这个 Action 不会安装项目依赖，也不会执行项目的 lifecycle script；它只读取提交到仓库的依赖图并查询配置中的上游漏洞源。如果需要完全显式的底层命令，等价写法是：

```bash
pnpm dlx --package=upstream-radar@0.33.0 upstream-radar radar check \
  ./upstream-radar.config.json --frozen --state :memory: --fail-on high \
  --fail-on-compatibility breaking --json
```

如果还要检查一个已发布插件能否跨多个 DSH 版本加载，可以增加三个 input：

```yaml
- uses: MicroMilo/upstream-radar@v0.33.0
  id: radar
  with:
    config: upstream-radar.config.json
    fail-on: high
    probe-package: dsh-cloudflare-browser-run@0.1.1
    probe-dsh-versions: 0.1.0-rc.3,0.1.0-rc.6
```

Action 会用 `--ignore-scripts` 打包精确 npm 版本，运行 `probe dsh-matrix`，并暴露 `probe-result`。如果结果是 `incompatible` 或 `unknown`，Action 会失败。这个步骤会下载并加载 DSH bundle 到临时 profile；它是兼容性信号，不是安全沙箱，也不是能力测试。

如果想先跑一个真实消费者样例，可以参考使用真实 [`dsh-cloudflare-browser-run@0.1.1`](../examples/github-actions/consumer/upstream-radar.config.json) 依赖图的[consumer smoke 说明](../examples/github-actions/consumer/README.md)和[可复制 workflow](../examples/github-actions/consumer/upstream-radar.yml)。

在本仓库中也可以直接运行同一个已发布 Action：

```bash
pnpm run try:consumer
```

在本地或自托管 DSH 机器上不要加 `--frozen`，这样 Radar 会在每轮检查前刷新选中的 profile。`--fail-on` 和 `--fail-on-compatibility` 适用于一次性 `radar check`、`radar status` 或 `radar watch --once`；长期运行的 watch 不应该因为第一次告警就退出。

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

CI 中可以使用 `radar check --frozen --state :memory: --fail-on high --json`，直接检查提交到仓库的审查过的图；本地持续监控仍使用 `radar watch`，并让 DSH profile 自动刷新。

投递消息保留明确的插件身份；模型回复还必须经过准确会话和固定 JSON 结构校验：

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

DSH Agent 收到的任务要求：只读分析、引用项目证据、保留不确定性，并返回固定的[结果结构](../schemas/analysis-result.schema.json)。Radar 只接受同一 DSH 会话中、由模型产生的完整 JSON；普通聊天、用户伪造的标记、额外字段和过期事件都不会写回。模型无法改写程序已经确认的匹配事实，分析结论也不会改变确定性的漏洞或兼容性状态。

同一轮 DSH 运行时升级如果同时改动多个 `@deepseek-ai/dsh-*` 包，Radar 仍然逐包保存状态和证据，但交给 Agent 时会合并成一个 notice。用户只需要处理一个整体升级问题，之后每个包仍然可以独立更新或恢复。

## 当前能力与边界

已经支持：DSH profile 实际安装树、npm lock 和 pnpm v6/v9 lock 依赖图、从 npm/pnpm lock 生成静态 Radar 配置并执行同一套 OSV 精确版本检查、重复版本路径、未解析依赖的覆盖提示、可选 peer 与 DSH 宿主 peer 的区分、从正在运行的 DSH 进程发现真实宿主依赖平面、OSV 精确版本匹配、恶意包记录、npm release 监听（只接受高于当前安装版本的候选；npm 的 `latest` 回退不会制造 breaking 告警；最新版本有确定性阻断时会检查历史候选的 OSV 状态和最早一小段传递依赖图，并筛出第一个没有确定性阻断且没有已知漏洞路径、值得交给 DSH 分析的候选；图不完整、图解析或 OSV 失败时不推荐候选）、公开 GitHub Release 说明、OSV 故障时保留已确认状态、连续失败后的 source-health DSH notice、有上限的事件历史和 `radar history` 查询、持久事件、按项目 workspace 精确路由到 DSH Agent、严格绑定消息/会话/task/event 的 DSH 结果写回、以及 Node/peer/exports/入口/bundle/版本边界检查；还包括不联网的 `doctor` 接线检查、默认可提交的相对 workspace、把审查过的图接入 CI 的可复用 GitHub Action 以及可读的 Job Summary、可选的 breaking/any 兼容性门禁、可选的 DSH 版本加载矩阵、离线的 `benchmark compatibility` 规则契约检查、provider-neutral HTTPS webhook 事件通知、直接投递飞书/Lark V2 文本消息，以及基于真实 DSH 插件的 consumer smoke。

此外支持一次性的 `probe dsh-load` 和有界的 `probe dsh-matrix`：在临时 DSH profile 中针对一个或多个精确 DSH 版本加载一个精确 tarball，并返回 `compatible`、`incompatible` 或 `unknown`。它是加载兼容性证据，不是安全准入，也不是插件能力 benchmark。

`init` 在省略 `--profile` 时可以自动选择唯一一个含第三方 bundle 的 DSH profile；多个候选仍要求显式指定。默认读取实际安装树，因此 pnpm override 和本地解析选择会被纳入；`graph npm-lock`/`graph pnpm-lock` 是独立的安装前/CI 图采集入口，本身不会查询 OSV，也不会生成 Radar 配置。加上 `--dsh-patch <path>` 可以生成不依赖环境变量的 DSH overlay。`radar status` 提供离线的首次运行检查、活动事件摘要、等待中的投递和已验证结论，还会显示宿主依赖图是否来自正在运行的 DSH 进程；但不会替你刷新漏洞源，也不会自动升级插件。暂未支持 Yarn 图适配、changelog/比较 diff/迁移文档源，以及自动创建 Issue 或 PR。多 root Agent 场景下，只有 `project.workspace` 与 DSH 会话的 `cwd` 精确一致才会投递；无法确认时任务会留在队列中。

`init --pnpm-lock <path>` 或 `init --npm-lock <path>` 是不依赖 DSH profile 的静态配置入口；默认读取锁文件旁的 `package.json`，也可以用 `--root <name>@<version>` 覆盖。之后可用 `radar check` 或 `radar watch` 查询 OSV。它不会启动 DSH，也不会自己投递 Agent 任务。

如果插件根包没有发布到当前 npm registry，返回 `404` 时只跳过这个包的版本比较，锁文件中的精确依赖和已发布的 DSH 宿主包仍会继续检查。registry 故障、超时、损坏响应和 OSV 故障仍然会让本轮失败。

`radar watch` 是 CLI 监控入口，本身不会把任务投递给 DSH；需要 Agent 分析时应使用原生 DSH bundle。

`doctor` 只检查本地接线，不能证明 DSH 进程已经把任务交给模型，也不能证明漏洞源当前可用。

`probe dsh-load` 只证明选定 DSH 版本是否登记并加载了 bundle 配置；即使结果是 `compatible`，也不代表插件安全、业务动作可用或模型效果合格。要评估依赖漏洞，仍然使用 Radar 的依赖图和 OSV 监控。

`probe dsh-matrix` 最多检查八个版本，并且逐个运行；只要还有一个版本是 `unknown`，汇总结果就不会变成 `compatible`。

候选依赖图默认只覆盖按版本排序的有限前缀，后续未查询版本会在事件中显示为未完整检查。遇到 registry 或 OSV 不可用时，Radar 保留不确定性并发出告警，不会生成“已安全”的结论。

兼容性 CI 门禁默认关闭；使用 `--fail-on-compatibility breaking` 时，只会在有 confirmed/strong 信号的兼容性事件上让 CI 失败，使用 `any` 时则拦截所有活动兼容性事件。两者都不是候选版本安全证明。

`radar check/watch --frozen` 会有意使用提交到仓库的配置图，适合 CI，但不能证明 DSH profile 的实际安装树没有变化；不加 `--frozen` 时，原生 DSH 和 CLI 轮询会先刷新选中的 profile。

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
