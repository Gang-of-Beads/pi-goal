[English](storage.md) | 中文

# 数据存储

目标状态：`待澄清 → 确认 TODO → 待执行 → 执行中 → 待确认`，也可切换为 `已暂停`、`已取消` 或 `已完成`。所有 TODO 均完成（每项都需验证依据，无论由 AI 还是由你标记）时目标自动标记为已完成，可重新打开（带设计目标或复审规则的目标仍为待确认，由你最终确认）；AI 轮次结束但仍有未完成 TODO 时为待确认，取消执行或最终报错会标为已暂停。

每个目标保存为 `<agent 目录>/pi-goal/goals/<workspace key>/<uuidv7>.json`：agent 目录默认为 `~/.pi/agent`（或 `PI_CODING_AGENT_DIR`），workspace key 是项目绝对路径的 SHA-256 十六进制摘要；项目目录内不写入任何文件。文件包含 UUID、项目内显示编号、目标文本、创建/更新时间、澄清问答、计划确认状态、完整 TODO（状态、完成时间及验证依据）、累计执行时长（可选字段 `elapsedMs`，毫秒；执行中另有当前轮开始时间 `runStartedAt`，旧文件缺省按 0 计）、审批清单（可选字段 `approvals`：动作说明与确切命令；`approvalsConfirmed` 表示是否已在确认计划时批准，导入的目标为 `false`），以及目标文本/状态/TODO 的变更历史。

文件记录所属 `workspace` 和创建时的 `sessionId`。每个 workspace 目录另有 `workspace.json`（`{"workspace": "<绝对路径>"}`）说明它属于哪个项目；“所有 Goal”遍历 `pi-goal/goals/*/` 并读取这些文件，无需单独的索引，也不扫描整个磁盘。项目移动或改名后 key 会变化：把目录移到新 key 并更新 `workspace.json` 即可保留目标。要清理已删除项目的目标，删除对应目录即可。

文件采用原子替换写入，文件权限为 `0600`。检测到其他会话修改了文件时拒绝覆盖，需 `/reload` 后再操作。多个会话可以查看同一个项目的目标。无法解析或校验失败的目标文件、workspace 目录（缺少 `workspace.json`，或路径与目录名不符）会提示并跳过，不修改、不删除，也不影响其他目标；编号重复时保留最早创建的目标，后创建的自动改用新编号并写回。恢复时执行中的目标标为已暂停，不自动续跑。删除目标会删除对应 JSON 文件。旧版本会话记录不会自动迁移；工具调用和完整 AI 对话仍由 Pi 会话保存，不复制到目标文件。

这些 JSON 可能包含敏感的问答和验证信息；它们保存在你的 agent 目录中，不会随项目提交。

## 从 0.1.x 迁移

0.1.x 及以前，目标保存在各项目的 `.pi/goals/`，索引在 `pi-goal/workspaces/`。自 0.2.0 起**不再读取或自动迁移**这些位置。如需保留旧目标，先关闭或 `/reload` 使用该项目的其他 Pi 会话，然后复制一次：

```sh
P=/absolute/path/to/project
D=~/.pi/agent/pi-goal/goals/$(printf %s "$P" | shasum -a 256 | cut -d' ' -f1)
mkdir -p "$D" && cp -p "$P"/.pi/goals/*.json "$D"/
printf '{"workspace":"%s"}\n' "$P" > "$D/workspace.json"
```

使用项目的绝对路径，末尾不加斜杠（按 Pi 看到的工作目录解析符号链接，例如 macOS 上的 `/private/tmp`）。`/reload` 后在 `/goal` 中确认目标，再删除 `"$P"/.pi/goals` 与 `~/.pi/agent/pi-goal/workspaces/`。

[返回 README](../README.zh-CN.md)
