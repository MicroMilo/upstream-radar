# DSH 插件首批扫描问题与 PR 覆盖报告

## 对当前项目的借鉴意义

本轮不是把“没有 CVE”当成通过，而是检查发布物能否被真实解析、能否建立完整依赖图，以及失败后能否解释到具体包。

扫描范围：12 个公开 DSH 相关 npm 发布物做了浅检查，其中 6 个做了深度依赖解析。深度检查结果为：1 个可复现的依赖解析问题、2 个只有 provenance 证据缺失、3 个没有报告级发现但仍有未解析的可选边。这个范围不能代表全部 DSH 插件，也不能推出生态整体安全。

### 1. 可迁移的依赖漂移模式

`@sanqi-normal/dsh-webui-market-plugin@0.5.4` 只声明了 DSH 客户端 peer，且版本是 `*`。npm 在干净环境中选择当前客户端运行时后，又追到一个没有发布到 npm 的 `@deepseek-ai/dsh-compact`。结果不是“发现 0 个漏洞”，而是依赖图根本没有建立起来。

这是一种“插件声明看似很轻，真正的依赖藏在 DSH 宿主”的漂移。问题的责任方可能是插件作者，也可能是 DSH 发布方，不能只把告警丢给插件作者。

### 2. 对当前项目迭代的建议

- 保留 npm 解析失败的原始原因。当前实现已在 [`src/npm.ts`](../../../src/npm.ts) 中把 npm 的具体错误带进 finding；用户能直接看到缺的是哪个包，而不是只看到 `dependency-audit-failed`。
- 将来把“缺失的 DSH 宿主包”单独归类，并显示可能的责任边界：插件 peer 声明、DSH 宿主发布物、或用户 profile。
- 对每个 finding 同时给出“可复现命令”和“没有做过的验证”。本案没有执行插件代码，也没有把 DSH web profile 启动成功伪装成已验证。

### 3. 覆盖边界与 residual risk

- 已检查：精确 npm tarball、tarball 完整性、npm registry 签名、manifest、DSH bundle patch、peer 声明和 scripts-disabled 的 npm 依赖解析。
- 未检查：插件业务代码、真实 web profile 启动、模型行为、source 与 npm artifact 的逐文件一致性。
- provenance 缺失和依赖解析失败是两类不同问题；本报告没有把 provenance 缺失写成恶意代码，也没有把空漏洞列表写成安全证明。
- 其他 5 个深度检查对象没有出现同类“依赖解析失败” finding，但其中部分 coverage 仍是 incomplete，不能据此宣布无风险。

### 4. Benchmark / gold case 候选价值

本案适合作为一个 gold case：

```text
floating DSH peer
  -> latest published DSH client runtime
  -> unpublished transitive host package
  -> dependency graph unavailable
```

期望结果应是 `review / incomplete`，并指出缺失包和可能的责任边界；不应被误判为 `allow`，也不应被夸大为“插件有漏洞”。

## 逐项报告

## 问题一：DSH peer 指向未发布包，导致依赖图无法建立

### 问题说明

`@sanqi-normal/dsh-webui-market-plugin@0.5.4` 的发布 manifest 没有 runtime dependencies，只有以下 peer：

```json
{
  "react": "^18.2.0",
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/dsh-client-runtime": "*",
  "@deepseek-ai/dsh-client-ui-slots": "*"
}
```

在干净 npm 项目中解析这个精确版本时，npm 选择 `@deepseek-ai/dsh-client-runtime@0.0.1-rc.1`，随后请求 `@deepseek-ai/dsh-compact@^0.0.1-rc.1`，但该包没有发布到 npm。

### 为什么有危害

用户可能在 DSH web profile 中正常使用它，因为 profile 可能已经有一套本地宿主包；但在干净环境、CI 或供应链扫描中，无法确认它实际会使用哪套 DSH 客户端依赖。

直接后果是：

- 依赖图无法建立；
- 漏洞源无法对完整依赖树做匹配；
- 同一个插件可能因宿主 profile 不同而得到不同结果；
- 发布后才暴露出“能装在某个 profile，但无法作为可复现 npm 依赖解析”的问题。

这不是已确认的恶意行为或 CVE；它是一个可复现的依赖发布和 DSH 宿主兼容性问题。

### 证据

- 精确发布物：`@sanqi-normal/dsh-webui-market-plugin@0.5.4`。
- artifact SHA-256：`af56c9dacbfcdc0a3ac8e50c0f84d285eefa67b05208008f14a0067c7605f2aa`。
- npm manifest：peer `@deepseek-ai/dsh-client-runtime: "*"`、`@deepseek-ai/dsh-client-ui-slots: "*"`、`@deepseek-ai/cordis: "*"`，没有 lifecycle script。
- 源仓库提交：[`aa5f4ef`](https://github.com/Sanqi-normal/dsh-webui-market-plugin/commit/aa5f4efc7827176cce27c73f73a2f42514da1ebf)；该提交没有 `pnpm-lock.yaml`、`package-lock.json` 或 `yarn.lock`。
- 解析输出：`npm error 404 Not Found ... @deepseek-ai/dsh-compact@^0.0.1-rc.1`。
- 单独的 registry 查询确认：`@deepseek-ai/dsh-compact@0.0.1-rc.1` 当前不存在。
- `@deepseek-ai/dsh-client-runtime@0.0.1-rc.1` 的 manifest 声明了对 `@deepseek-ai/dsh-compact@^0.0.1-rc.1` 的依赖。

### 验证结果

验证等级：**依赖解析动态复现 + 发布物静态证据**。

命令：

```bash
node dist/src/cli.js inspect \
  npm:@sanqi-normal/dsh-webui-market-plugin@0.5.4 \
  --deep --fail-on never
```

结果：

```text
dependency audit: failed
404 Not Found: @deepseek-ai/dsh-compact@^0.0.1-rc.1
provenance: missing
lifecycle scripts: none
```

解析过程使用 `npm install --ignore-scripts`，没有运行插件代码，也没有启动真实 DSH web profile。

### 现有 issue/PR 覆盖状况

已重新检查：

- 插件仓库 Issue：#4 是收录到 DSH Directory，#1 和 #3 是其他插件/安装识别问题；都不覆盖本次依赖解析根因。
- 插件仓库 PR：当前没有覆盖该问题的 PR。
- DeepSeek Harness 仓库按 `dsh-compact`、`dsh-client-runtime` 搜索 Issue/PR，没有找到覆盖记录。

覆盖结论：**未覆盖**。但责任归属仍有一个需要作者确认的分支：缺包可能是 DSH 发布链问题，插件的 `*` peer 又放大了这个问题。

### 修复建议

结论：**先确认再提 PR**；现在不应直接向插件作者提交猜测性的代码 PR。

建议先向作者/DSH 发布方确认 web profile 是否必须从 registry 解析这套 client runtime。确认后：

1. 如果这些包应该公开可解析：发布缺失的 `@deepseek-ai/dsh-compact`，或修复 `dsh-client-runtime` 的发布依赖。
2. 如果 DSH profile 会固定提供宿主包：插件把 `*` 改成已经测试过的 DSH 版本范围，并在 CI 中跑一次干净解析和真实 profile-check。
3. 在发布前保留一条失败测试：缺失宿主包时必须明确失败，不能输出空漏洞列表或“已检查”。

非目标：本轮不修改插件源码、不执行插件业务行为，也不把 provenance 缺失作为单独的安全漏洞提交。

## 上游反馈

由于责任方可能是 DSH 宿主发布链，而不是插件作者，本轮先提交了确认型 issue，
没有直接提交猜测性的代码 PR：

- [Sanqi-normal/dsh-webui-market-plugin#5](https://github.com/Sanqi-normal/dsh-webui-market-plugin/issues/5)
- 当前状态：**open**；最近一次检查没有机器人或维护者回复。

Issue 中包含 `upstream-radar@0.33.5` 的精确复现命令，并请维护者确认插件应依赖
公开 npm 宿主包，还是由 DSH profile 在宿主平面提供这些包。
