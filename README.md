# pi-goal

一个轻量的 [Pi](https://pi.dev) 插件：通过 `/goal` 澄清目标、确认 TODO，并让 AI 执行任务。

## 快速开始

从 npm 安装 v0.1.2：

```sh
pi install npm:@light4/pi-goal@0.1.2
```

或从 GitHub 安装同一版本：`pi install git:github.com/light4/pi-goal@v0.1.2`。

在 Pi 中：

```text
/goal 添加健康检查接口并验证
/goal
/goal @site-design 首页 https://example.com
```

- `/goal <任务>`：交互式澄清并确认 TODO；选项用方向键选择，确认时默认“确认并立即执行”，也可选择稍后执行。
- `/goal`：打开目标面板，默认显示当前 Session 的目标；Tab 切换 Workspace / 所有 Goal，`/` 搜索，单字母快捷键执行、暂停、查看 TODO 等。
- `/goal status [#编号]`：查看目标状态——哪些 TODO 已完成、正在执行哪一项、阻塞说明与累计执行时长。
- `/goal @<snippet>`：用跨项目复用的 snippet 创建目标，如内置的 `site-design`。
- `/goal help`：查看全部用法（`#<编号>` 直接打开目标、导入 / 导出、保存 snippet 等）。

所有功能都通过 `/goal` 完成；`/goal-import`、`/goal-export`、`/goal-snippet`、`/goal-snippet-save` 只是辅助别名。

状态以带主题色的符号显示：目标 `▶` 执行中 · `◎` 待确认 · `?` 待澄清 · `○` 待执行 · `‖` 已暂停 · `✓` 已完成 · `✗` 已取消；TODO `✓` 已完成 · `▶` 执行中 · `✗` 阻塞 · `○` 待执行。执行中，输入区上方显示当前目标的 TODO 列表，底部状态栏显示进度、时长和当前 TODO；`/goal` 面板下方预览所选目标的 TODO。

支持执行、暂停、修改、取消及回滚请求。目标以 UUIDv7 JSON 文件持久化；回滚不保证所有操作可撤销，高风险操作仍需审批。

## 文档

- [使用指南](docs/usage.md)：面板、TODO、执行与回滚边界
- [Snippets](docs/snippets.md)：跨项目复用的 goal 定义
- [目标分享](docs/sharing.md)：导入 / 导出 `.goal.sexp` 模板
- [数据存储](docs/storage.md)：状态、JSON 文件与 workspace 索引
- [本地开发](docs/development.md)：加载插件、运行检查与发版

## License

[MIT](LICENSE)
