# 本地开发

## 本地加载

在本仓库运行：

```sh
pi -e ./src/index.ts
```

或从其他项目安装本地插件（路径换成实际位置）：

```sh
pi install /absolute/path/to/pi-goal
```

安装后启动 Pi，已有会话可用 `/reload` 重新加载插件。

## 开发

使用 TypeScript、pnpm，插件入口为 `src/index.ts`。测试目录仅保留 `e2e/`，使用 Node 内置测试运行器，不额外引入测试框架。

```sh
pnpm install
pnpm check
```

Pi 直接加载 TypeScript，无需构建产物。`pnpm check` 执行类型检查和 E2E 测试；单独运行 E2E 可用 `pnpm test:e2e`。

## E2E 覆盖

`e2e/goal.test.mjs` 启动依赖包内的真实 Pi CLI 子进程，通过 RPC 命令和 extension UI 请求/响应操作插件，不 mock 插件 API。每项用例使用独立的临时 workspace 和 Pi agent 目录，退出后清理，所有 RPC 等待均有超时。

当前用例覆盖：

- 插件加载和 `/goal` 命令注册。
- RPC 选择列表降级：默认当前 Session、“切换到：…”范围项、“＋ 新增目标”子菜单、跨 session 的筛选，以及其他 workspace 的只读详情（TUI 自定义面板需在真实终端验证）。
- 展开 TODO、人工完成、完成时间和验证说明落盘。
- 取消时保留操作、回滚选项展示。
- 重启后的 JSON 持久化及删除目标文件。
- S 表达式导出 / 导入往返、隐私字段排除、TODO 状态重置与确认后不自动执行。
- 非法语法、未知 / 重复字段、版本、复杂度 / 大小限制、取消导入及拒绝覆盖已有导出文件。
- `/goal` 统一入口：help、`/goal #<编号>` 直接打开目标并在操作后保持菜单、不存在的编号、纯数字输入被拒绝（不打开、不新建目标）、类似子命令的普通文本仍创建目标、非法 snippet 名称、别名与主命令一致；无可用模型凭据时不启动 AI 轮次。
- `/goal status`：TODO 图标、完成时间与完成 / 阻塞说明、累计时长，中断运行在加载时按最后更新时间结算，无执行中目标时的 Session 摘要，`status` 不会新建目标。
- Snippet：内置列表、补充项目信息、全局保存（审阅编辑）、跨 workspace 复用、用户 snippet 覆盖内置、拒绝覆盖与非法名称、取消不创建。
- 设计目标、8 个 CHECK 维度、基准与有界复审规则的导入、重启、面板查看及导出保真；不支持的优先级、重复维度与无限复审配置会拒绝。

用例预置 goal JSON，不调用模型或外部服务、无需凭据。尚未覆盖真实 AI 的澄清提问、执行与回滚，也不验证终端视觉和键盘交互；这些不能由 RPC 面板测试替代。

## Git hooks

使用 `prek.toml` 配置 pre-commit 检查。首次克隆后运行：

```sh
prek install
```

提交时检查尾随空格、文件末尾换行、大文件、合并冲突，以及 JSON / TOML / YAML 格式。源码、E2E 或相关配置变更时，还会执行类型检查和现有 E2E 测试；不向这些命令传入文件名。

手动检查所有已跟踪文件：

```sh
prek run --all-files
```

当前未额外配置 lint、format 工具；GitHub Actions 只有发版用的 `publish.yml`（见下文）。

## 发版

1. 更新 `package.json` 的 `version` 与 README 中的安装示例版本，运行 `pnpm check`。
2. 提交并推送 `main`，再推送对应的 `vX.Y.Z` tag。
3. 为该 tag 发布 GitHub Release（说明分 Changes / Validation / Install 三段）。[publish.yml](../.github/workflows/publish.yml) 会校验 tag 与 `package.json` 版本一致，运行类型检查与测试，然后通过 OIDC 以 provenance 发布到 npm；GitHub 中不保存 npm token。

npm 包所有者的一次性配置（需要 npm 11.19+ 与 2FA）：

```sh
npm trust github @light4/pi-goal --repo light4/pi-goal --file publish.yml --allow-publish --yes
```

trusted publishing 只能为已存在的包配置，因此 v0.1.0 由包所有者在本机手动执行 `npm publish --access public` 首发，之后再配置上述信任关系；后续版本均通过 GitHub Release 自动发布。发布失败时修复原因后重新运行失败的 GitHub Actions job；更新使用方之前先确认 GitHub Release 与 npm 版本均已就绪。

[返回 README](../README.md)
