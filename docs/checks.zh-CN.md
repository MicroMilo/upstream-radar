# 第一版检查项与方法

Plugin Notary 只回答供应链风险，不评价插件效果。所有结论都绑定到精确产物摘要；没有运行的检查必须显示为缺口。

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
pnpm showcase
pnpm showcase:reports
```

展示包含一个真实、精确版本的 DSH npm 插件，以及 clean、review、block 三个离线固定样例。目标插件代码和 lifecycle scripts 都不会被执行。
