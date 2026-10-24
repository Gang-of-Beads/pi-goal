# pi-goal

一个轻量的 [Pi](https://pi.dev) 插件：通过 `/goal` 澄清目标、确认 TODO，并让 AI 执行任务。

## 快速开始

```sh
pi install /absolute/path/to/pi-goal
```

在 Pi 中：

```text
/goal 添加健康检查接口并验证
/goal
/goal-snippet site-design 首页 https://example.com
```

- `/goal <任务>`：交互式澄清并确认 TODO，确认后不自动执行。
- `/goal`：打开 Session / Workspace / 所有 Goal 面板，管理目标与 TODO。
- `/goal-snippet`：用全局可复用的 goal snippet 创建目标，如内置的 `site-design`。

支持执行、暂停、修改、取消及回滚请求。目标以 UUIDv7 JSON 文件持久化；回滚不保证所有操作可撤销，高风险操作仍需审批。

## 文档

- [使用指南](docs/usage.md)：面板、TODO、执行与回滚边界
- [Snippets](docs/snippets.md)：跨项目复用的 goal 定义
- [目标分享](docs/sharing.md)：导入 / 导出 `.goal.sexp` 模板
- [数据存储](docs/storage.md)：状态、JSON 文件与 workspace 索引
- [本地开发](docs/development.md)：加载插件与运行检查

## License

[MIT](LICENSE)
