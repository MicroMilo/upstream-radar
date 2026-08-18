# 第一批 DSH 插件：安装脚本复查

日期：2026-08-18

这是第一批 50 个 DSH 插件在加入“精确依赖的安装脚本”证据后的复查。它只读取精确 npm
发布物的 lockfile、package.json 和脚本文件；没有执行脚本、安装插件业务代码或调用 LLM。

## 结果

| 项目 | 数量 |
| --- | ---: |
| 源码样本 | 49 个有可读取的 package.json |
| 精确 npm 发布物 | 30 |
| 未发布或版本不存在 | 19 |
| 已知漏洞 | 0 |
| 含安装阶段脚本的发布物 | 3 |
| DSH `rc.6`/`rc.7` 加载通过 | 3/3 |

## 三个可复查结果

### `dsh-hdc-bridge@0.7.2`

```text
dsh-hdc-bridge@0.7.2
└── @deveco/deveco-cli@1.3.0
    └── postinstall: node scripts/postinstall.mjs
```

静态读取该脚本后确认：它会 detached 启动 DevEco 文档索引进程，向用户目录下的
`.local/share/deveco-cli` 写入文档索引状态和数据。没有在本次证据中看到恶意行为，但这是
安装时后台启动进程的高信任行为，作者应在 DSH 安装说明中明确说明并让用户批准。

### `dsh-wsl-workspace@0.2.3`

```text
dsh-wsl-workspace@0.2.3
└── @deepseek-ai/dsh-fs-local@0.0.1-rc.1
    └── koffi@3.1.5
        └── install: node ./cnoke.cjs -P . -D src/koffi --prebuild --release
```

`koffi` 是原生 FFI 模块；脚本会检查预构建产物，必要时运行 CMake 和本地编译器构建
native addon。它可能是正常的功能需要，但 DSH 安装路径必须明确要求原生构建工具和用户
批准，不能让用户把它误认为纯 JavaScript 插件。

### `dsh-msg-hub@0.1.6`

```text
dsh-msg-hub@0.1.6
└── @larksuiteoapi/node-sdk@1.73.0
    └── protobufjs@7.6.5
        └── postinstall: node scripts/postinstall
```

该脚本静态内容只是检查依赖的 version scheme 并输出兼容性警告，没有看到下载、启动
后台进程或执行编译的行为。它仍会触发 DSH/pnpm 的安装脚本审批，因此是一个真实的安装
阻塞/说明问题，但不能被描述为漏洞或恶意包。

## 统一验证结果

三个精确 tarball 都满足：

- 审查使用的 tarball 与 DSH probe 使用的 tarball 字节完全一致；
- DSH `0.1.0-rc.6` 和 `0.1.0-rc.7` 都能登记并加载 bundle；
- npm 漏洞审计为 0；
- Radar 关闭了 npm lifecycle scripts，以上行为均来自静态证据，不是本次运行执行出来的副作用。

## 结论

这批结果不应被包装成“三个漏洞”。正确的作者反馈是：

1. `dsh-hdc-bridge` 说明安装会后台启动文档索引进程；
2. `dsh-wsl-workspace` 说明安装可能运行 native build；
3. `dsh-msg-hub` 说明安装会触发脚本审批，但脚本本身目前看是兼容性检查。

这证明 Upstream Radar 能把“DSH 能加载”和“安装是否需要信任额外代码”分开报告，并且能
把依赖名、实际路径、脚本命令和 DSH 版本结果一起交给作者。
