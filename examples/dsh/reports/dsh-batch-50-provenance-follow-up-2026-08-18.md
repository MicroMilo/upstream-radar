# 第一批 50 个 DSH 插件：发布 provenance 复核

日期：2026-08-18

本报告在当前分支用新的源码规则重跑了
[第一批 50 个 DSH 插件](dsh-batch-50-2026-08-17.md)。扫描只读取源码、workflow、manifest
和锁文件；没有安装、加载或运行任何插件，也没有调用 LLM。

## 扫描结果

- 50/50 个仓库扫描完成，0 个扫描失败
- 2 个仓库最终确认存在“npm 发布流程没有声明 provenance”
- 1 个仓库的 npm 发布物已存在，可以做精确 artifact 复查
- 1 个仓库还没有对应的 npm 发布物，因此只记录源码发布前风险
- 1 个初始候选被排除：它已经使用 GitHub OIDC trusted publishing

| 仓库 | 源码发布入口 | npm 发布物 | 复查结果 |
| --- | --- | --- | --- |
| [dsh-feed](https://github.com/863683348/dsh-feed) | `.github/workflows/publish.yml` | `dsh-feed@0.1.0` | registry signature 已验证，provenance 缺失，18 个依赖，已知漏洞 0 |
| [dsh-inline-images](https://github.com/3403473060/dsh-inline-images) | `.github/workflows/ci.yml` | `dsh-inline-images@1.0.0` 不存在（npm 404） | 发布前修复项，不能把它写成已发布包问题 |

作者可直接复制的 Issue 草案：

- [dsh-feed provenance issue draft](dsh-feed-provenance-issue-draft.md)
- [dsh-inline-images provenance issue draft](dsh-inline-images-provenance-issue-draft.md)

两个源码 workflow 都直接执行 `npm publish`，但没有 `--provenance`、
`NPM_CONFIG_PROVENANCE=true` 或 GitHub OIDC 的 `id-token: write`。扫描器给出的统一修复是：

```text
Enable npm provenance with npm publish --provenance or NPM_CONFIG_PROVENANCE=true;
GitHub Actions publishers also need id-token: write.
Then inspect the next exact artifact with inspect --deep.
```

## 误报校准

初始规则把 [dsh-plugin-mall](https://github.com/1e0zj/dsh-plugin-mall) 识别为候选，
但复核发现它的 `release.yml` 已经声明 `id-token: write`，并使用 npm trusted publishing。
它没有显式写 `--provenance`，但这条发布路径会由 OIDC 自动生成 provenance；当前规则已经把
这种路径排除，避免把正确配置报告成问题。

## 结论

这批样本没有因此增加任何运行时漏洞结论。它产生了一个已发布、可精确复查的作者问题
（`dsh-feed`），以及一个发布前问题（`dsh-inline-images`）。两者都能给作者明确的
最小修复和下一次发布后的验证动作；结果不依赖 DSH/LLM。
