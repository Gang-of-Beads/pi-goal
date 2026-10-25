[English](README.md) | 中文

# pi-goal

一个轻量的 [Pi](https://pi.dev) 插件：通过 `/goal` 澄清目标、确认 TODO，并让 AI 执行任务。

## 安装

```sh
pi install npm:@light4/pi-goal@0.1.3
```

或从 GitHub 安装同一版本：`pi install git:github.com/light4/pi-goal@v0.1.3`。

## 快速开始

```text
/goal 添加健康检查接口并验证
/goal
/goal status
```

## 文档

- [使用指南](docs/usage.zh-CN.md)：澄清与确认、目标面板、状态显示、命令与执行边界
- [Snippets](docs/snippets.zh-CN.md)：跨项目复用的 goal 定义
- [目标分享](docs/sharing.zh-CN.md)：导入 / 导出 `.goal.sexp` 模板
- [数据存储](docs/storage.zh-CN.md)：状态与 Pi agent 目录下的目标文件
- [本地开发](docs/development.zh-CN.md)：加载插件、运行检查与发版

## License

[MIT](LICENSE)
