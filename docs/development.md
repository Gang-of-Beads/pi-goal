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

与同级 Pi 插件保持一致：TypeScript、pnpm、`src/index.ts` 入口，以及 Node 内置测试框架。

```sh
pnpm install
pnpm check
```

Pi 直接加载 TypeScript，无需构建产物。`pnpm check` 执行类型检查和单元测试。

当前保持最小工具链，尚未配置 lint、format、prek hooks 或 CI。

[返回 README](../README.md)
