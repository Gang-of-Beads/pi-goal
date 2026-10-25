# Goal 模板分享

完整执行状态继续保存为 `.pi/goals/<uuidv7>.json`；`.goal.sexp` 只保存可分享的目标定义。

## 导出

```text
/goal export 1
/goal export 1 templates/health.goal.sexp
```

编号对应当前 workspace 中的目标；文件路径必须以 `.goal.sexp` 结尾。别名 `/goal-export` 行为相同。默认文件名为 `<uuidv7>.goal.sexp`；路径相对当前 workspace，也可用绝对路径（含空格的路径直接填写，不加引号）。父目录须已存在，已有文件不会覆盖。

也可在 `/goal` 面板选中目标后选择“导出 Goal 模板”。交互模式会打开内容编辑器，允许审阅、编辑和移除敏感文本；取消则不写文件。非交互模式直接导出定义。

默认只导出目标文本、约束、验收标准、结构化目标 / 基准 / 检查维度 / 复审规则、审批清单（仅作建议，不含“已批准”状态）及 TODO 文本，不含 UUID、workspace、session、问答、执行状态、完成时间、验证记录或历史。目标文本本身仍可能含敏感信息，分享前请自行检查。澄清时确认的约束和验收标准会保存为结构化字段；旧目标只存在于问答中的信息不会自动提取，可在导出编辑器中补充。

## 导入

```text
/goal import templates/health.goal.sexp
```

或在 `/goal` 的分区首页选择“导入 Goal 模板”。导入会显示完整定义并要求确认：

- 确认后在当前 workspace / session 下生成新的 UUIDv7，不覆盖原目标。
- TODO 全部重置为待执行，不导入任何完成记录。
- 确认包含 TODO 的模板即确认这份计划，但**不自动执行**；随后通过面板“执行 / 继续”开始。
- 没有 TODO 的模板保存为待澄清，之后仍需提问和确认计划。
- 模板中的 `approvals` 只是**建议审批项**，导入（含 Snippet）后一律为未批准：执行时 AI 会把它们当作需要询问的操作；重新澄清并确认计划时才一并批准。
- 取消确认不创建目标。导入要求 TUI 或支持对话框的 RPC 客户端。

模板可能包含不可信的任务指令，确认前请审阅；导入确认不替代执行时所需的审批。

## 格式 v1

```lisp
(goal
  (version 1)
  (title "添加健康检查接口")
  (constraints
    "不引入新依赖"
    "不修改生产配置")
  (acceptance
    "GET /health 返回 HTTP 200")
  (todos
    (todo "实现 /health 接口")
    (todo "验证正常与异常响应")
    (todo "补充使用说明")))
```

- `version`、`title` 必须各出现一次，版本仅支持 `1`；`title` 是一个非空字符串。
- `constraints`、`acceptance`、`todos` 可省略或为空，但字段不能重复。另支持下述可选的 `objective`、`benchmarks`、`checks`、`review-loop`，以及审批清单 `approvals` 字段。
- `approvals` 中每项为 `(approval "动作说明" (command "确切命令"))`，最多 30 项，每段不超过 2000 字符。
- `constraints` / `acceptance` 包含非空字符串；`todos` 中只允许 `(todo "非空文本")`。
- 字符串采用 JSON 转义规则：`\"`、`\\`、`\n`、`\uXXXX` 等；支持中文。
- 支持空白和 `;` 行注释；不支持任意字段、多条顶层表达式、reader macros、`eval`、`sequence` 或 `parallel`。
- 最大 64 KiB，解析限制嵌套深度和表达式数量。文件只作为数据解析，绝不执行表达式。

## 设计目标与复审规则

完整可分享示例：[site-design.goal.sexp](../snippets/site-design.goal.sexp)，对应“获奖级页面设计 + 8 维 CHECK + 完成后自审”的需求：

```lisp
(objective
  (name "site_design")
  (priority "OVERRIDE_ALL")
  (target "build page to award-tier visual standard"))
(benchmarks "Awwwards winning entries" "Webby Awards winning entries" "FWA winning entries")
(checks
  (check "typography" (standard "award_tier"))
  (check "whitespace" (standard "award_tier"))
  (check "visual_hierarchy" (standard "award_tier"))
  (check "color" (standard "award_tier"))
  (check "motion" (standard "award_tier"))
  (check "micro_interaction" (standard "award_tier"))
  (check "responsive" (standard "award_tier"))
  (check "originality" (standard "award_tier")))
(review-loop
  (name "self_review")
  (trigger "on_completion")
  (read "current page against CHECK list")
  (compare "each dimension to BENCHMARK entries")
  (on-gap "patch-and-repeat")
  (on-pass "stop")
  (max-iterations 3))
```

这些字段需放在 `(goal (version 1) (title "...") ...)` 内。检查维度不能重复；`priority` 仅支持 `normal` 或 `OVERRIDE_ALL`。复审字段必须完整，必须有非空的 checks 和 benchmarks；`max-iterations` 必须是 1–20 的整数，不允许无限循环。

它是内置 [Snippet](snippets.md)，可在任意前端项目中使用：

```text
/goal @site-design 首页 https://example.com
```

示例不预置已确认 TODO，创建后先澄清实际页面 URL、具体获奖参考作品、设备尺寸、浏览器和参考访问权限，再确认实施与验收 TODO。也可以直接通过 `/goal <任务>` 描述这类目标，AI 在澄清时可通过 `goal_plan` 的 `definition` 字段提出结构化定义，用户确认后保存。

### 语义边界

- `OVERRIDE_ALL` 仅表示该 goal 自身设计偏好中的最高优先级，不能覆盖上层指令、审批、明确约束、无障碍或安全要求。
- `ACCEPT` 原文保存在 `acceptance`，奖项机构保存在 `benchmarks`；应在澄清时补齐具体作品链接，不能把机构名称当作已完成的对照证据。
- 执行提示词带入完整定义，并要求实现后按 READ → COMPARE → 有差距则 PATCH → 再复审；无已识别差距时停止。每次执行最多进行配置的复审轮数，到限必须报告剩余差距。
- 这是给当前 AI 的有界执行 / 复审协议，**不是插件实现的独立自动调度器**，也不保证模型遵循每一条规则。暂停后继续属于新的执行轮次。模板本身不执行代码或启动后台循环。
- 要求浏览器实际渲染、相关移动 / 平板 / 桌面尺寸与交互状态的检查；动效和微交互不能仅凭静态截图宣称通过。参考不可访问、缺少浏览器或证据时应报告阻塞，不得假装达到基准。
- “no visible improvement remaining”是评审目标，不是可证明的绝对完美或获奖承诺。最终需说明评审范围、不确定性、每个维度的证据和剩余差距，并由用户确认整个目标。
- 面板的“查看目标定义”可查看完整结构；JSON 保存和 S 表达式导出会保留以上字段。

[返回 README](../README.md)
