English | [中文](sharing.zh-CN.md)

# Sharing goal templates

Full execution state stays in `.pi/goals/<uuidv7>.json`; a `.goal.sexp` file holds only the shareable goal definition.

## Export

```text
/goal export 1
/goal export 1 templates/health.goal.sexp
```

The id refers to a goal in the current workspace; the file path must end with `.goal.sexp`. The alias `/goal-export` behaves the same. The default file name is `<uuidv7>.goal.sexp`; paths are relative to the current workspace or absolute (write paths with spaces as is, without quotes). The parent directory must exist, and existing files are never overwritten.

You can also select a goal in the `/goal` panel and choose "导出 Goal 模板" (export goal template). Interactive mode opens an editor so you can review, edit and remove sensitive text; cancelling writes nothing. Non-interactive mode exports the definition directly.

Only the goal text, constraints, acceptance criteria, structured objective / benchmarks / checks / review loop, the approval list (as suggestions, without the "approved" state) and TODO texts are exported — never the UUID, workspace, session, clarification answers, execution state, completion times, verification notes or history. The goal text itself may still be sensitive; check it before sharing. Constraints and acceptance criteria confirmed during clarification are saved as structured fields; information that older goals only kept in clarification answers is not extracted automatically and can be added in the export editor.

## Import

```text
/goal import templates/health.goal.sexp
```

Or press `n` in the `/goal` panel (or "＋ 新增目标" in RPC lists) and choose "导入 Goal 模板" (import goal template). Import shows the full definition and asks for confirmation:

- After confirming, a new UUIDv7 is created in the current workspace / session; the original goal is not overwritten.
- All TODOs are reset to pending; no completion records are imported.
- Confirming a template with TODOs confirms that plan, but it **does not run automatically**; start it with "执行 / 继续" (run / continue) in the panel.
- A template without TODOs is saved as awaiting clarification and still needs questions and a confirmed plan.
- The template's `approvals` are **suggested approvals only**: after import (including from snippets) they are not approved, the AI treats them as actions to ask about during execution, and they are approved only when a plan is clarified and confirmed again.
- Cancelling creates nothing. Import needs the TUI or an RPC client that supports dialogs.

Templates may contain untrusted task instructions; review them before confirming. Confirming an import does not replace the approvals required during execution.

## Format v1

```lisp
(goal
  (version 1)
  (title "Add a health check endpoint")
  (constraints
    "No new dependencies"
    "Do not change production configuration")
  (acceptance
    "GET /health returns HTTP 200")
  (todos
    (todo "Implement the /health endpoint")
    (todo "Verify normal and error responses")
    (todo "Document usage")))
```

- `version` and `title` must each appear once; only version `1` is supported, and `title` is one nonempty string.
- `constraints`, `acceptance` and `todos` may be omitted or empty, but fields cannot repeat. The optional `objective`, `benchmarks`, `checks` and `review-loop` fields below, and the approval list `approvals`, are also supported.
- Each `approvals` entry is `(approval "action description" (command "exact command"))`; at most 30 entries, each part at most 2000 characters.
- `constraints` / `acceptance` contain nonempty strings; `todos` only allows `(todo "nonempty text")`.
- Strings use JSON escapes: `\"`, `\\`, `\n`, `\uXXXX` and so on; Unicode text is supported.
- Whitespace and `;` line comments are allowed; arbitrary fields, multiple top-level expressions, reader macros, `eval`, `sequence` and `parallel` are not.
- At most 64 KiB, with limits on nesting depth and expression count. Files are parsed as data only; expressions are never evaluated.

## Design objectives and review rules

A complete shareable example, [site-design.goal.sexp](../snippets/site-design.goal.sexp), covers "award-tier page design + 8 CHECK dimensions + self-review on completion":

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

These fields go inside `(goal (version 1) (title "...") ...)`. Check dimensions cannot repeat; `priority` only supports `normal` or `OVERRIDE_ALL`. Review fields must be complete and require nonempty checks and benchmarks; `max-iterations` must be an integer from 1 to 20 — unbounded loops are not allowed.

It is a built-in [snippet](snippets.md) usable in any frontend project:

```text
/goal @site-design home page https://example.com
```

The example has no pre-confirmed TODOs: after creation, clarify the actual page URL, specific award-winning reference entries, device sizes, browser and reference access first, then confirm implementation and acceptance TODOs. You can also describe such a goal directly with `/goal <task>`; during clarification the AI can propose a structured definition through `goal_plan`'s `definition` field, saved once you confirm.

### Semantic boundaries

- `OVERRIDE_ALL` only means the highest priority among this goal's own design preferences; it never overrides higher-level instructions, approvals, explicit constraints, accessibility or safety.
- The original `ACCEPT` text is kept in `acceptance` and award organisations in `benchmarks`; specific entry links should be added during clarification — organisation names are not completed comparison evidence.
- The execution prompt includes the full definition and asks for READ → COMPARE → PATCH on gaps → review again after implementation, stopping when no gaps are identified. Each run performs at most the configured number of review rounds and must report remaining gaps at the limit.
- This is a bounded execution / review protocol for the current AI, **not an independent scheduler implemented by the plugin**, and the model is not guaranteed to follow every rule. Continuing after a pause is a new run. Templates never execute code or start background loops.
- Checks require actual browser rendering at relevant mobile / tablet / desktop sizes and interaction states; motion and micro-interactions cannot pass on static screenshots alone. If references are inaccessible or a browser or evidence is missing, the AI should report a blocker rather than pretend the benchmark was met.
- "no visible improvement remaining" is a review target, not provable perfection or an award promise. The final report states the review scope, uncertainty, evidence and remaining gaps per dimension, and you confirm the whole goal.
- "查看目标定义" (view goal definition) in the panel shows the full structure; JSON storage and S-expression export keep all of these fields.

[Back to README](../README.md)
