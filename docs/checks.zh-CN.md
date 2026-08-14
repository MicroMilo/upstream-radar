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
| Breaking signals | 新版本是否跨兼容边界或改变关键声明 | 比较版本、入口、exports、Node、DSH bundle 和 peer 范围 | confirmed/strong/needs-analysis |
| DSH 分析入口 | 如何避免“新闻”直接指挥 Agent | 将所有来源文字标记为不可信数据，要求只读和项目证据 | 由 DSH 原生投递；CLI 只用于检查持久 analysis task |
| 去重与恢复 | 重启、重复轮询是否丢失、刷屏或投递过期任务 | 保存活跃漏洞、活跃兼容性问题和待分析任务；同一 incident 的新任务替换旧任务，resolved 会撤销旧任务 | 至少一次投递，不变不重复，不过期投递 |

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
- 插件能力、任务成功率、成本和延迟 benchmark。

因此，真实样例即使当前风险检查全部通过，也会得到 `riskVerdict=allow`、`coverageVerdict=incomplete`、`verdict=review`。这不是保守文案，而是产品最重要的安全语义。

## 运行展示

```bash
pnpm run showcase:radar
pnpm run showcase:radar:reports
```

主展示包含漏洞源更新、精确依赖路径、项目路由、DSH 分析任务和 breaking-change 候选。旧的 clean、review、block 安装前样例仍可通过 `node scripts/showcase.mjs` 运行。目标插件代码和 lifecycle scripts 都不会被执行。
