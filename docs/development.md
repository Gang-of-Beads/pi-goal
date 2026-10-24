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
- Session / Workspace / 所有 Goal 分区、跨 session 的筛选，以及其他 workspace 的只读详情。
- 展开 TODO、人工完成、完成时间和验证说明落盘。
- 取消时保留操作、回滚选项展示。
- 重启后的 JSON 持久化及删除目标文件。
- S 表达式导出 / 导入往返、隐私字段排除、TODO 状态重置与确认后不自动执行。
- 非法语法、未知 / 重复字段、版本、复杂度 / 大小限制、取消导入及拒绝覆盖已有导出文件。
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

当前未额外配置 lint、format 工具或 CI。

[返回 README](../README.md)
