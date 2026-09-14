# 环境优先的真实插件验收批次

本批包含八个插件，覆盖 Web 客户端、仅在 Web 宿主运行的工具、真实 TUI、作者默认 SDK 流程、Node 多版本与原生依赖构建。

`targets.yml` 是最新版本和源仓库的观察入口；`install-targets.json` 的包版本只是种子，不是新扫描证据。每次验收必须先运行 observer，以本轮实际取得的 npm 版本、源码提交和仓库资料生成推荐与计划。DSH 和 OpenPencil 显式使用 `next` 发布通道，其余插件使用各自的默认发布通道。

独立 CI 工作流 `dsh-rebuild-validation.yml` 执行只读观察及模型审阅，上传候选证据、审阅状态和安装计划。它不会执行插件、发布 issue/PR、修改默认分支或写入正式兼容性目录。

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

`state.json` 是可恢复状态；`reports/` 保留每次执行的原始报告及附件；`compatibility-ledger.json`、`surface-ledger.json` 和对应 IR 是本轮派生产物；`summary.json` 同时保留失败、待执行任务和作者环境范围。执行器身份变化会使旧结果失效。当前入口仍未实现作者 SDK/ACP adapter 的独立执行和浏览器精确 peer 版本证明，不能据此声明完整验收通过。

## 2026-09-14 前置阶段验证

独立 CI 运行 `34805106617` 对八个仓库执行了新的自动审阅：八个推荐均通过确定性校验，未人工填入结论。紧接着对相同证据重复规划，`attempted=0`、`failed=0`。这是自动审阅和未变化复用的证据，不是安装或运行兼容性证据。完整目标仍须由新的隔离批次及其后续轮次验收。
