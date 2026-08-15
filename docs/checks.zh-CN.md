# 检查项与方法

当前产品主线是持续监控“精确依赖版本发生了什么变化”。原有安装前供应链检查保留为依赖清单和辅助证据收集器。两条线都不评价插件效果。

## Radar 已实现

| 层次 | 检查什么 | 如何检查 | 输出 |
| --- | --- | --- | --- |
| 依赖实图 | 项目实际装了哪些版本、从哪个插件进入 | 解析 npm lock 的物理节点与父子边，重复版本不合并 | 完整节点、边和路径 |
| 漏洞变化 | 当前精确版本是否被 OSV 报告为受影响 | 批量查询 `name@version`，命中后再读取完整公告 | `new/updated/resolved` |
| 恶意包 | 当前版本是否命中 `MAL-*` 记录 | 与普通漏洞共用准确版本查询 | `critical` 事件 |
| 项目路由 | 哪个项目、插件、负责人受影响 | 依赖图反查项目登记 | project、owner、channel |
| 插件新版本 | npm `latest` 是否出现新候选 | 只读 packument，不安装候选 | 兼容性事件或无变化 |
| 候选漏洞 | 中间版本本身是否已被 OSV 报告为受影响 | 对每个更高的精确候选版本做 OSV 查询；命中任何有效公告就阻断该候选；OSV 查询失败则不推荐任何候选 | known-vulnerability / checked / unavailable |
| 候选传递依赖 | 候选版本解析出的依赖树是否引入已知漏洞 | 对按版本排序的有限前缀运行 `npm install --package-lock-only --ignore-scripts`；不执行候选代码；将每个图节点查询 OSV，并保留从候选根到漏洞节点的路径 | candidate-dependency-vulnerability / checked / partial / incomplete / unavailable |
| 发布说明 | 候选版本有没有对应的公开 GitHub Release 说明 | 仅接受 npm 元数据中的公开 `github.com` 仓库，按 `v<version>` 或 `<version>` 精确读取；正文限长并作为不可信材料 | 发布说明正文与链接，失败不阻塞 npm/OSV 主链路 |
| Breaking signals | 新版本是否真的是高于当前安装版本的候选，并且是否跨兼容边界或改变关键声明 | 先比较 npm 精确版本方向；只对更高版本比较入口、exports、Node、DSH bundle 和 peer 范围；`latest` 回退不制造新告警，也不把已有问题误判为已解决；当最新版本有确定性阻断时，再按版本从低到高筛出第一个没有确定性阻断且没有已知漏洞的候选；OSV 失败时不推荐候选，但不称为“安全” | confirmed/strong/needs-analysis；最低候选仍需 DSH 项目分析 |
| DSH 分析入口与结果写回 | 如何避免“新闻”直接指挥 Agent、避免一次 DSH 升级刷出多条通知，以及避免普通聊天被误当成结论 | 将所有来源文字标记为不可信数据，要求只读和项目证据；同一项目同一轮的 DSH 运行时包更新在投递层合并，底层事件仍逐包保存；用 task/message/session/event 四个身份绑定回复，只接受固定六字段 JSON，并在上游事件变化时清掉旧结论 | DSH 原生投递；`radar status`、`analysis list/show` 查看等待和已验证结果 |
| 去重与恢复 | 重启、重复轮询是否丢失、刷屏或投递过期任务 | 保存活跃漏洞、活跃兼容性问题和待分析任务；同一 incident 的新任务替换旧任务，resolved 会撤销旧任务 | 至少一次投递，不变不重复，不过期投递 |
| 源失败与健康 | OSV、npm release 或候选依赖图暂时查不到时，是否会被误判成“没有漏洞”，以及负责人能否知道源长期不可用 | 保留上一次确认的漏洞状态，不生成假的 `resolved`，仍继续投递已有 DSH 任务；连续 3 次失败生成持久 `source-health` DSH notice，恢复后 `resolved`；CLI/JSON 返回源警告 | `sourceErrors: osv/npm-releases/npm-candidate-graphs`、源健康状态、source-health 生命周期 |
| 本地接线 | DSH profile 是否登记 Radar、overlay 是否指向同一份配置和状态、状态是否可读、必需依赖是否完整 | `doctor` 只读本地 manifest、配置、overlay 和状态，不访问 OSV/npm/GitHub，也不执行插件代码 | `READY`、`READY WITH WARNINGS` 或 `BLOCKED` |
| DSH 加载兼容性 | 一个或多个精确 DSH 版本能否加载一个精确插件 tarball 的 bundle 配置 | 先检查包内 `dsh.bundle.patch` 和 lifecycle scripts；再把同一发布物依次放进临时 `headless` profile，安装、登记并运行 `--dump-config` | `compatible`、`incompatible` 或 `unknown`；只代表加载结果，不代表安全或能力 |

## 支持性的安装前检查

## 已实现

| 层次 | 检查什么 | 如何检查 | 当前结论 |
| --- | --- | --- | --- |
| 输入身份 | 包名和版本是否精确 | 只接受 `npm:<name>@<exact-version>`，拒绝 tag 和范围 | 非精确输入直接报错 |
| 下载字节 | 下载物是否与 registry 声明一致 | 流式限量下载，验证最强可用 SRI，并交叉检查 SHA-1 shasum | 不一致为 `critical/block` |
| Registry 身份 | registry 是否为这些字节签名 | 获取 registry 公钥，验证 `${name}@${version}:${integrity}` 的 ECDSA 签名，并检查发布时间与密钥有效期 | 缺失为 `high`，无效为 `critical` |
| 归档安全 | tarball 是否能攻击扫描器或写出目标目录 | gzip/tar 大小、条目数、单文件和压缩比预算；拒绝路径穿越、绝对路径、跨平台冲突和特殊设备；链接从不落盘 | 逃逸、冲突和异常类型为 `critical` |
| 发布物内容 | 安装阶段是否存在不可解释行为 | 检查 lifecycle scripts、联网下载、`curl/wget \| shell`、原生二进制、pnpm hook、包内 `.npmrc` 凭据和自定义 registry | 按证据映射为 `medium/high/critical` |
| DSH 声明 | 是否真是可定位的 DSH bundle | 识别 `dsh.bundle.patch`，验证路径不逃逸且指向包内普通文件 | 逃逸为 `critical`，缺失/非普通文件为 `high` |
| 依赖声明 | 依赖来源是否可变或绕过 registry | 检查未锁图、浮动版本、未固定 Git commit、URL tarball 和 bundled dependencies | `medium/high` |
| 依赖实图 | 此刻真正解析到了哪些字节 | 深度模式在临时项目中禁用脚本后运行 npm 解析，摘要化完整 lock graph | 记录包数量和 graph digest |
| 依赖真实性 | 解析后的包是否有无效或缺失签名 | 调用官方 npm verifier 检查整张依赖图的 registry 签名和 attestations | 无效为 `critical`，缺失为 `high` |
| 构建来源 | 发布物声明来自哪个源码和工作流 | 验证 npm/Sigstore SLSA provenance，提取仓库、ref、commit、workflow 和 builder | 无效为 `critical`，失败为 `high` |
| 已知漏洞 | 解析图是否命中 registry advisory | 对临时 lock graph 运行 `npm audit --json` 并保留分级汇总 | critical/high 漏洞沿用相应等级 |
| 覆盖范围 | 哪些关键证明仍然缺失 | 独立输出 coverage，不用“没有发现”代替“已经证明” | 缺少必要覆盖时准入至少为 `review` |

## 明确未实现

- 从 provenance 指向的 commit 重建，并逐字节比较 npm tarball；
- 在 microVM/容器中执行安装和加载，观察文件、网络、进程和凭据探测；
- 恶意包情报、多源漏洞情报和 maintainer 异常监测；
- SBOM、签名 review receipt、撤销和 `dsh plugin add/load` 的强制准入；
- 插件运行时能力、任务成功率、成本和延迟 benchmark；当前提供的是离线兼容性规则契约 benchmark，不是插件能力 benchmark。
- `probe dsh-load` 不是安全准入：它不执行插件业务动作，不证明依赖没有漏洞，也不证明模型能够正确使用插件。

因此，真实样例即使当前风险检查全部通过，也会得到 `riskVerdict=allow`、`coverageVerdict=incomplete`、`verdict=review`。这不是保守文案，而是产品最重要的安全语义。

## 运行展示

```bash
pnpm run showcase:radar
pnpm run showcase:radar:reports
```

主展示包含漏洞源更新、精确依赖路径、项目路由、DSH 分析任务和 breaking-change 候选。旧的 clean、review、block 安装前样例仍可通过 `node scripts/showcase.mjs` 运行。目标插件代码和 lifecycle scripts 都不会被执行。
