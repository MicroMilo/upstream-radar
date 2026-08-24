# Upstream Radar domain reports

> Snapshot checked on 2026-08-24. This index covers the reports filed by
> Upstream Radar, not every issue that mentions DSH.

## 对当前项目的借鉴意义

这批报告证明我们的 domain 不是“找一条有风险的依赖”，而是核对三层真实关系：

1. DSH 宿主版本与插件声明、运行时导入是否一致。
2. 用户真正拿到的 npm 发布物能否被可靠解析、安装并进入 DSH。
3. 源码、发布版本、lockfile 和依赖图是否足够准确，让持续监控有东西可比。

因此，报告中的“开放”不等于“插件有漏洞”，“需要确认”也不等于“插件不兼容”。
只有真实运行失败，才可以称为已复现的不兼容；发布物和依赖图问题则分别标成安装
契约问题和观测可信度问题。

### 1. 可迁移的 drift 模式

- **宿主契约漂移**：插件代码实际导入 DSH `rc.2`，但发布包只声明 `rc.6`；代码可能
  偶然加载，严格安装器却会拒绝，造成“能跑但契约不成立”。
- **发布物漂移**：仓库代码、README 和 npm tarball 指向不同版本，或者 tarball 本身
  无法解析。用户照着 README 得不到作者声称的修复。
- **安装边界漂移**：`prepare`、`postinstall` 或 native build 在 DSH 接纳插件前执行。
  这不是恶意代码结论，但它改变了安装所需的权限、工具链和网络边界。
- **图谱不可观测**：package-lock 根版本落后，或宿主依赖指向未发布包。此时漏洞“未
  发现”没有意义，因为我们连完整的上下游集合都没有建立起来。

### 2. 对当前项目迭代的建议

- 把“动态复现的运行失败”与“静态发现的契约/安装/图谱问题”分开评分和措辞。
- 将 `exact artifact + DSH version + Node/runtime + observed path` 作为每一条报告的
  最小证据包。
- 将 dshscan 的 peer-range mismatch、Sanqi 的未发布宿主链、anan 的坏 tarball 和
  dsh-web-ui 的 Apply/boot 崩溃作为 benchmark/gold case 候选。
- 对源码、README、package.json、lockfile、npm metadata 建立同一份 IR；只要其中一方
  不能对齐，就输出“监控覆盖不完整”，不要输出“安全”。

### 3. 覆盖边界与 residual risk

本轮维护池有 100 个目录条目：96 个有可执行发布物，74 个已观测兼容，22 个仍需
复核，0 个已复现为插件不兼容，4 个只有源码。browser/web 相关条目不是全部失败：
维护池中的 `anweat/dsh-browser` 与 `dsh-builtin-browser` 已观测兼容；
`Lum1104/dsh-browser` 只有源码，不能据此判断坏或好。

`dsh-web-ui#35` 与 `#71` 是生态中的历史 browser/web 兼容性对照，均已关闭，但不是
Upstream Radar 提出的报告。当前 13 条列表只统计我们的 maintainer-facing reports。

### 4. Benchmark / gold case 候选价值

- **适合**：dsh-web-ui#35 的“Apply 后 boot 崩溃”、dshscan#1 的“运行时导入与 peer
  range 不一致”、Sanqi#5 的“宿主依赖链无法解析”、anan#1 的“精确 tarball 无法解析”。
  它们分别覆盖动态运行失败、契约漂移、图谱不完整和发布物损坏。
- **不适合直接当作漏洞样本**：hdc、wsl、voice、msg-hub、verification-receipt、
  spotlight 的安装脚本报告。它们是安装边界证据，除非在受限环境中复现用户可见的
  安装或加载失败，否则不应包装成漏洞。

## 逐项报告

## 问题一：DSH 宿主依赖链无法建立（Sanqi）

### 问题说明

精确发布物 `@sanqi-normal/dsh-webui-market-plugin@0.5.4` 的干净解析会走到未发布的
`@deepseek-ai/dsh-compact@^0.0.1-rc.1`，因此无法建立完整的 DSH 宿主依赖图。

### 为什么有危害

用户可以安装到一个表面存在、但依赖链无法完整解析的插件；监控器也可能因为图不完整
而漏掉真实依赖和漏洞。这里不能直接归责给插件作者，因为缺失包可能是 DSH 宿主发布契约
的问题。

### 证据

- [公开 Issue #5](https://github.com/Sanqi-normal/dsh-webui-market-plugin/issues/5)
- [本地依赖解析报告](../examples/dsh/reports/sanqi-market-plugin-dependency-resolution.md)
- 证据中的结果：`review / incomplete`，registry 返回 `404 Not Found`。

### 验证结果

源码与精确 npm tarball 的 scripts-disabled 解析已验证；没有安装或执行插件业务代码。
修复后的 `0.5.5` 已重新解析为完整图并验证通过。

### 现有 issue/PR 覆盖状况

Issue #5 已关闭，维护者通过宿主依赖范围和发布物修复覆盖了同一根因；当前不需要重复
提交 PR。

### 修复建议

暂不提出新 PR。把该案例保留为“宿主依赖未发布 → 完整图不可建立 → 修复后重新验证”的
gold case，并要求插件发布 CI 做一次 scripts-disabled 的 registry 解析。

## 问题二：运行时使用的 DSH 版本超出 peer contract（dshscan）

### 问题说明

`@shaoshi/dshscan@0.5.0` 声明 `@deepseek-ai/dsh-tools: 0.1.0-rc.6`，但在 DSH
`0.1.1-rc.2` 中实际解析并被运行时导入的是 `0.1.1-rc.2`。插件加载成功，然而发布包
没有声明它实际工作的 DSH 版本边界。

### 为什么有危害

严格包管理器和兼容性工具可能因为 peer range 不匹配而拒绝安装；维护者也无法从包元数据
判断 `rc.2` 是正式支持、偶然可用，还是未测试。

### 证据

- [公开 Issue #1](https://github.com/shaoshi20/dshscan/issues/1)
- 精确包 SHA-256：`db62d1fb00272fd174cd6d8650a432a25a16103ec11b4f1a4bc78d6c31d70dc5`
- 运行时：DSH `0.1.1-rc.2`、Node `22.23.2`、Linux x64。

### 验证结果

已在隔离环境安装并加载精确发布物；这是动态“加载成功 + 契约不一致”，不是动态崩溃。
Web 业务功能尚未完整验证，因此不能扩大成“全部兼容”。

### 现有 issue/PR 覆盖状况

Issue #1 仍开放，页面当前没有关联 PR；没有发现其他 PR 覆盖 peer range 与运行时导入的
同一根因。

### 修复建议

先确认再提 PR。若维护者确认支持 `rc.2`，应更新 peer range 并补一条对应 DSH 的加载测试；
若只支持 `rc.6`，应让报告和运行矩阵明确显示该边界。

## 问题三：传递依赖在安装时执行宿主外部命令（hdc）

### 问题说明

`dsh-hdc-bridge@0.7.2` 的精确发布物会到达 `@deveco/deveco-cli@1.3.0`，该依赖声明
`postinstall` 和 `prepare: husky` 等 lifecycle 行为。

### 为什么有危害

普通安装可能在 DSH 接纳插件之前执行脚本，要求额外命令、网络或本地权限；这会导致安装
在不同机器上表现不同，也扩大了插件进入 Agent 前的信任边界。它不是恶意代码结论。

### 证据

- [公开 Issue #3](https://github.com/1na-ko/dsh-hdc-bridge/issues/3)
- 精确依赖图中 `@deveco/deveco-cli@1.3.0` 的 lifecycle metadata。

### 验证结果

本轮是精确发布物的静态依赖/脚本观察，脚本被禁用，没有把外部命令实际执行当成插件故障。

### 现有 issue/PR 覆盖状况

Issue #3 已关闭；维护者在后续版本移除了相关可选依赖。当前没有需要重复提交的 PR。

### 修复建议

暂不提出新 PR。将“依赖树中存在安装脚本”作为需要解释的安装边界信号，只有动态复现
安装失败或未声明权限要求时才升级为兼容性事件。

## 问题四：native 依赖在安装阶段构建（wsl）

### 问题说明

`dsh-wsl-workspace@0.2.3` 的发布物到达 `koffi@3.1.6`，安装时可能选择或构建 native
addon。

### 为什么有危害

没有编译器、匹配的 Node ABI 或支持平台的用户会在安装阶段失败；即使最终能安装，构建
行为也应被作者明确声明，而不是让 DSH 用户从日志中猜。

### 证据

- [公开 Issue #6](https://github.com/6Mikao9/dsh-wsl-workspace/issues/6)
- 精确发布物依赖路径：`dsh-wsl-workspace@0.2.3 → koffi@3.1.6`。

### 验证结果

已确认安装边界和 native 构建入口；没有把缺少某个平台工具链的观察直接称为插件运行
不兼容。

### 现有 issue/PR 覆盖状况

Issue #6 已关闭，维护者补充了平台/安装说明；没有新的同根因 PR 需要我们追加。

### 修复建议

暂不提出新 PR。将 Node ABI、操作系统和工具链记录为动态运行矩阵的环境维度。

## 问题五：prepare 在消费者安装时重新构建（voice）

### 问题说明

`dsh-voice@0.2.5` 的源码和精确 npm 发布物都声明 `prepare: npm run build`，因此消费者
安装时可能重新运行项目构建。

### 为什么有危害

发布物如果已经包含运行所需产物，就不应要求用户重复构建；重复构建会引入 Node、包管理器、
网络和脚本权限差异，最终可能出现“作者机器能装，用户机器不能装”。

### 证据

- [公开 Issue #2](https://github.com/3274375092/dsh-voice/issues/2)
- 源码 manifest 与精确发布物 manifest 的 `prepare` 字段一致。

### 验证结果

这是源码与发布物的静态一致性证据；脚本没有在本轮只读检查中执行。

### 现有 issue/PR 覆盖状况

Issue #2 已关闭，维护者处理了发布/构建边界；没有发现仍需我们提交的同根因 PR。

### 修复建议

暂不提出新 PR。把“发布时构建、消费时只加载”作为 DSH 插件发布检查项。

## 问题六：精确 npm tarball 无法解析（anan）

### 问题说明

`anan-thermal-monitor@1.0.4` 的公开 npm archive 被标准 tar reader 拒绝，报
`unsupported PAX size override`。

### 为什么有危害

用户无法可靠提取、检查或安装作者发布的精确版本；我们也无法建立可信依赖图。这里是
发布物完整性问题，不是恶意行为或 CVE 指控。

### 证据

- [公开 Issue #1](https://github.com/AmeKrance/anan-thermal-monitor/issues/1)
- registry 精确包 `anan-thermal-monitor@1.0.4`，结果为 `npm-archive-invalid`。

### 验证结果

独立 tar reader 对公开归档的解析失败已复现；没有进入插件代码执行阶段。

### 现有 issue/PR 覆盖状况

Issue #1 仍开放，页面当前没有关联 PR；没有发现相同根因的修复覆盖。

### 修复建议

值得维护者处理，但不需要我们代写 PR：重新发布标准 npm archive，并在发布前用独立 reader
验证文件列表和可提取性。

## 问题七：传递依赖带有 protobufjs postinstall（msg-hub）

### 问题说明

`dsh-msg-hub@0.1.8` 的精确依赖图到达 `protobufjs@7.6.5`，其 metadata 声明
`postinstall: node scripts/postinstall`。

### 为什么有危害

安装脚本会在 DSH 接纳插件前运行，改变安装所需的执行权限和可观测行为；目前证据只说明
脚本存在，不能说明它恶意或必然造成运行失败。

### 证据

- [公开 Issue #3](https://github.com/AbcdefgXW/dsh-msg-hub/issues/3)
- 路径：`dsh-msg-hub@0.1.8 → protobufjs@7.6.5`。

### 验证结果

脚本被禁用的精确依赖审查已完成；没有执行 `postinstall`，也没有动态证明它会破坏 DSH。

### 现有 issue/PR 覆盖状况

Issue #3 仍开放，且与该仓库的 lockfile 元数据 Issue #1 是两个不同根因；没有发现 PR 覆盖
安装脚本路径。

### 修复建议

先确认再提 PR。作者应判断脚本是否是运行必需；若不是，移除依赖路径；若是，应记录输入、
输出和脚本关闭时的加载行为。

## 问题八：prepare 在安装时执行 pnpm build（verification-receipt）

### 问题说明

`dsh-verification-receipt@0.1.0` 的源码与发布物都声明 `prepare: pnpm run build`。

### 为什么有危害

用户安装时会进入项目构建路径，而不是只解压并加载已发布产物；缺失 pnpm、编译工具或网络
时可能安装失败，且 DSH 尚未有机会限制插件行为。

### 证据

- [公开 Issue #3](https://github.com/030611/dsh-verification-receipt/issues/3)
- 源码和精确 tarball 的 `prepare` 字段均为 `pnpm run build`。

### 验证结果

已完成源码/发布物静态对齐；脚本没有在只读检查中执行，因此尚未宣称安装失败。

### 现有 issue/PR 覆盖状况

Issue #3 仍开放，页面当前没有关联 PR；没有发现同根因覆盖。

### 修复建议

值得维护者确认。优先在发布工作流构建并发布产物；若必须保留 prepare，增加关闭脚本后的
加载测试并说明输入输出。

## 问题九：prepare 在安装时执行（dsh-spotlight）

### 问题说明

`dsh-spotlight@0.0.2` 的精确发布物声明安装阶段的 prepare 脚本。

### 为什么有危害

这会把构建或其他代码执行引入 DSH 接纳前的安装边界，导致不同机器上的 Node、工具链和
网络条件影响结果；单凭脚本存在不能推断恶意。

### 证据

- [公开 Issue #5](https://github.com/0xsline/dsh-spotlight/issues/5)
- 精确 npm 发布物的 manifest lifecycle metadata。

### 验证结果

这是发布物静态证据；没有执行 prepare，也没有动态复现 DSH 加载失败。

### 现有 issue/PR 覆盖状况

Issue #5 仍开放，页面当前没有关联 PR；没有发现同根因覆盖。

### 修复建议

先确认再提 PR。作者应把构建移到发布阶段，或明确说明 prepare 必须执行的环境与边界。

## 问题十：README、源码版本与 npm latest 不一致（coding-subscription-oauth）

### 问题说明

仓库和 README 宣传 `0.6.1`，但 npm latest 和 GitHub Release 仍只有 `0.6.0`；用户照文档
安装不到文档声称的修复版本。

### 为什么有危害

这是最直接的“修复已经存在但用户拿不到”问题，也会让依赖监控把源码版本和用户实际运行版本
错误地对齐。

### 证据

- [公开 Issue #14](https://github.com/lninghaha/dsh-coding-subscription-oauth/issues/14)
- registry latest、GitHub Release、README 与 `package.json` 的版本对比。

### 验证结果

源码/registry 元数据差异已复核；`0.6.0` 精确包在 DSH `0.1.1-rc.2` 可加载，但 Web
功能没有完整验证，因此不扩大为“全部功能兼容”。

### 现有 issue/PR 覆盖状况

Issue #14 仍开放，页面当前没有关联 PR；没有发现发布 `0.6.1` 或修正文档的覆盖。

### 修复建议

值得提出一个聚焦的发布修复：发布 `0.6.1` 并创建对应 release，或先把 README 改回可安装
版本；同时明确 DSH peer range 的真实支持范围。

## 问题十一：package-lock 根版本落后（msg-hub）

### 问题说明

`dsh-msg-hub` 的 `package.json` 已到 `0.1.7`，但 `package-lock.json` 根 metadata 仍报告
`0.1.1`，导致源码版本和锁文件观察点不一致。

### 为什么有危害

监控器无法确定 lockfile 对应哪个发布状态，可能把旧图当成当前图，漏报依赖变化或误报版本
变化；这首先是可观测性问题，不是运行时漏洞。

### 证据

- [公开 Issue #1](https://github.com/AbcdefgXW/dsh-msg-hub/issues/1)
- `package.json` 与 `package-lock.json` 根节点版本差异。

### 验证结果

源码与 lockfile 的静态对比已完成；没有安装或执行插件代码。

### 现有 issue/PR 覆盖状况

Issue #1 仍开放，页面当前没有关联 PR；与 Issue #3 的 postinstall 发现不构成覆盖关系。

### 修复建议

值得提出一个小 PR：重新生成并提交与当前源码版本一致的 lockfile，并在发布 CI 中检查根
版本和 package.json 对齐。

## 问题十二：package-lock 根版本落后（toolbox-web）

### 问题说明

`dsh-toolbox-web` 的 package-lock 根 metadata 仍报告 `0.1.1`，而当前发布/源码版本为
`0.1.9`，因此无法把锁定依赖图准确归属到当前插件版本。

### 为什么有危害

上游依赖更新后，Radar 可能读取旧图，无法可靠回答“哪些插件受影响”；作者也无法复现
监控报告对应的依赖集合。

### 证据

- [公开 Issue #1](https://github.com/AbcdefgXW/dsh-toolbox-web/issues/1)
- package.json 与 package-lock 根 metadata 的版本差异。

### 验证结果

已完成静态版本对比；未安装或执行插件。

### 现有 issue/PR 覆盖状况

Issue #1 仍开放，页面当前没有关联 PR；没有发现同根因覆盖。

### 修复建议

值得提出一个聚焦的 lockfile 更新 PR，并在 CI 中增加根版本一致性检查。

## 问题十三：package-lock 根版本落后（composer-expand）

### 问题说明

`dsh-composer-expand` 的 `package.json` 为 `0.1.2`，而 package-lock 根 metadata 仍为
`0.1.0`。

### 为什么有危害

这是同一类图谱可信度问题：依赖路径可能来自旧发布状态，持续漏洞监控和上下游反向索引
都可能建立在错误版本上。

### 证据

- [公开 Issue #1](https://github.com/13071301808/dsh-composer-expand/issues/1)
- package.json 与 package-lock 根 metadata 的版本差异。

### 验证结果

已完成源码/lockfile 静态对比；没有安装或执行插件。

### 现有 issue/PR 覆盖状况

Issue #1 仍开放，页面当前没有关联 PR；没有发现同根因覆盖。

### 修复建议

值得提出一个小 PR：重新生成 lockfile 并在发布前校验根版本。修复后再用精确发布物重建
依赖图，不要只凭源码仓库状态关闭观察项。
