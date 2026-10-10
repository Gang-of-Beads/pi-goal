# pi-goal

一个轻量的 [Pi](https://pi.dev) 插件，通过 `/goal` 把目标交给当前 AI 执行。

## 使用

```text
/goal 给这个项目添加一个健康检查接口，并补上测试
/goal 排查测试失败的原因，修复后验证
```

直接输入 `/goal` 会打开多行编辑器填写目标。AI 会结合当前项目及会话上下文，理解目标、执行任务、验证结果，并总结完成情况与阻塞点。

- 使用当前会话的模型和工具，不创建额外 agent。
- AI 正在执行时会提示稍后重试，不打断或排队。
- 保留已有项目规则和审批要求，不把目标视为高风险操作的授权。
- 当前版本只提供任务入口和执行提示词，不包含自动续跑、进度持久化或完成判定循环；任务完成与否仍需审阅 AI 输出及验证结果。

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

与同级 Pi 插件保持一致：TypeScript、pnpm、`src/index.ts` 入口，以及 Node 内置测试框架。

```sh
pnpm install
pnpm check
```

Pi 直接加载 TypeScript，无需构建产物。`pnpm check` 执行类型检查和单元测试。

当前保持最小工具链，尚未配置 lint、format、prek hooks 或 CI。

## License

MIT
