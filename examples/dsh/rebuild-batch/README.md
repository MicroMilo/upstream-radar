# 环境优先的真实插件验收批次

本批包含八个插件，覆盖 Web 客户端、仅在 Web 宿主运行的工具、真实 TUI、作者默认 SDK 流程、Node 多版本与原生依赖构建。

`targets.yml` 是最新版本和源仓库的观察入口；`install-targets.json` 的包版本只是种子，不是新扫描证据。每次验收必须先运行 observer，以本轮实际取得的 npm 版本、源码提交和仓库资料生成推荐与计划。DSH 和 OpenPencil 显式使用 `next` 发布通道，其余插件使用各自的默认发布通道。

独立 CI 工作流 `dsh-rebuild-validation.yml` 默认执行只读观察及模型审阅，上传候选证据、审阅状态和安装计划。显式设置 `execute_batch=true` 后，继续执行隔离批次、构建门槛审阅、重试、未变化复用和真实仓库更新回放。它不会发布 issue/PR、修改默认分支或写入正式兼容性目录。

CI 的审阅成功只证明前置阶段完成；完整验收还需要隔离安装、适用 profile 的运行检查、独立依赖图、统一汇总，以及第二轮的复用、变化触发和失败恢复检查。

## 可恢复的批次执行入口

先构建 Radar，再把 CI 的 `dsh-rebuild-review` 产物解压到一个独立目录。执行器配置由操作者提供，包含 `dockerContext`、`architecture`、`timeoutSeconds`、`maxTasks` 和可选的不带凭据的 `networkProxy`。

```sh
pnpm run build
node scripts/run-dsh-compatibility-batch.mjs \
  examples/dsh/rebuild-batch/install-targets.json \
  /absolute/path/to/review-artifact \
  /absolute/path/to/batch-output \
  /absolute/path/to/executor.json --execute
```

入口会根据本轮仓库推荐选择 Node 与 profile 环境，构建并记录精确隔离镜像，再把安装检查、适用 Web/TUI 检查与结果入账串起来。每次交付执行器前先保存任务，逐个结果写入后再继续；使用相同输出目录重跑可恢复失败任务并复用仍有效的证据。目标容器没有宿主目录挂载、不继承模型或 GitHub 凭据，且以非 root 用户运行。操作者仍须确保 Docker daemon 位于合适的隔离环境；脚本不把容器存在本身当成虚拟机隔离的证明。

`state.json` 是可恢复状态；`reports/` 保留每次执行的原始报告及附件；原生、Web/TUI、SDK/ACP 各自的 ledger 及对应 IR 是本轮派生产物；`summary.json` 同时保留失败、待执行任务和作者环境范围。执行器身份变化会使旧结果失效。SDK/ACP 现有独立初始化与依赖图证据；浏览器启动模块可通过实际响应摘要匹配包版本，但静态／打包别名和认证业务流程仍未完整覆盖。不能把收集闭环当成所有插件兼容。

## 真实仓库更新回放

完整 CI 在当前批次完成后，使用 Context 仓库的真实历史提交 `33fd7ae6801d892ddbee7b76a964a4b2c6ff0416`，再前进到本轮最初实际观察到的提交。它重新调用 observer 和仓库审阅入口，不编辑快照字段来伪造新版本；这是历史变化回放，不是声称上游此刻发布了新版本。

`scripts/verify-dsh-input-change.mjs` 只准备独立副本并核对结果。两次变化都必须只审阅 Context，在同一执行器上留下新原生及 Web 容器记录，并保持其余插件的观察、审阅和执行结果不变。最后重复运行必须零执行且持久化状态不变。文档变化可以刷新前置环境分析，不要求把它伪造成运行时风险事件。全部证据保留在 CI 产物的 `input-change-before` 和 `input-change-after` 下；脚本或单元测试成功不等于这项真实验收已经完成。

## 2026-09-14 前置阶段验证

独立 CI 运行 `34805106617` 对八个仓库执行了新的自动审阅：八个推荐均通过确定性校验，未人工填入结论。紧接着对相同证据重复规划，`attempted=0`、`failed=0`。这是自动审阅和未变化复用的证据，不是安装或运行兼容性证据。完整目标仍须由新的隔离批次及其后续轮次验收。
