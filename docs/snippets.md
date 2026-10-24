# Goal Snippets

Snippet 是可在所有项目中复用的 goal 定义，格式与 [`.goal.sexp` 模板](sharing.md#格式-v1)相同。例如内置的 `site-design` 可用于任意前端项目。

## 使用

```text
/goal @
/goal @site-design 首页 https://example.com，保留现有品牌色
```

- 不带参数时列出所有 snippet，选择后可补充本项目信息（页面、URL、范围等，可留空）。
- 带名称时直接使用，名称后的文字作为本项目补充信息，追加到目标文本末尾。
- 使用前展示完整定义并要求确认；取消不创建目标。
- 确认后在**当前 workspace** 创建新 goal（新 UUIDv7），不会修改 snippet 本身。
- 没有 TODO 的 snippet 会立即进入交互式澄清（需已选择模型且 AI 空闲，否则保存为待澄清）；包含 TODO 的 snippet 视为已确认计划，**不自动执行**。

`/goal` 面板的分区首页也提供“从 Snippet 创建”；输入 `/goal @` 时可自动补全 snippet 名称。别名 `/goal-snippet [名称] [补充信息]` 行为相同。

## 保存

```text
/goal export 1 @landing-review
```

或在面板中选中目标，选择“保存为 Snippet”（别名：`/goal-snippet-save <编号> <名称>`）。保存前会打开编辑器审阅内容，请移除项目专属信息（URL、路径、业务细节）和敏感内容；取消则不保存。只保存目标定义，不含执行状态、问答或历史。

名称只能包含小写字母、数字和连字符，以字母或数字开头，最多 64 个字符。已存在的同名用户 snippet 不会被覆盖；如需更新，请先手动删除旧文件。

## 来源与优先级

| 来源 | 位置 | 说明 |
|---|---|---|
| 我的 | `~/.pi/agent/pi-goal/snippets/<name>.goal.sexp`（随 `PI_CODING_AGENT_DIR` 变化） | 全局共享，所有 workspace 可用 |
| 内置 | 插件包内 `snippets/` | 随插件发布，只读 |

同名时“我的” snippet 覆盖内置 snippet，可借此定制内置模板（如把 `site-design` 的复审上限改为 5）。无效文件会提示并跳过，不影响其他 snippet。删除用户 snippet 直接删除对应文件即可。

## 内置 Snippet

| 名称 | 用途 |
|---|---|
| `site-design` | 获奖级页面视觉标准：8 个 CHECK 维度、Awwwards / Webby / FWA 基准、最多 3 轮完成后自审。语义边界见[设计目标与复审规则](sharing.md#设计目标与复审规则) |

Snippet 只作为数据解析，不执行代码；确认使用不替代执行时所需的审批。

[返回 README](../README.md)
