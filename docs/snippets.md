English | [中文](snippets.zh-CN.md)

# Goal snippets

A snippet is a goal definition reusable across all projects, in the same format as [`.goal.sexp` templates](sharing.md#format-v1). For example, the built-in `site-design` works in any frontend project.

## Use

```text
/goal @
/goal @site-design home page https://example.com, keep the existing brand colors
```

- Without a name, all snippets are listed; after choosing one you can add project details (page, URL, scope, ...; may be empty).
- With a name, it is used directly; the text after the name is extra project context appended to the goal text.
- The full definition is shown for confirmation first; cancelling creates nothing.
- Confirming creates a new goal (new UUIDv7) in the **current workspace**; the snippet itself is never modified.
- A snippet without TODOs starts interactive clarification immediately (if a model is selected and the AI is idle; otherwise it is saved as awaiting clarification); a snippet with TODOs counts as a confirmed plan and **does not run automatically**.

In the `/goal` panel you can also press `n` (or "＋ 新增目标" in RPC lists) and choose "从 Snippet 创建" (from snippet); typing `/goal @` autocompletes snippet names. The alias `/goal-snippet [name] [extra context]` behaves the same.

## Save

```text
/goal export 1 @landing-review
```

Or select a goal in the panel and choose "保存为 Snippet" (save as snippet) (alias: `/goal-snippet-save <id> <name>`). An editor opens for review before saving; remove project-specific details (URLs, paths, business details) and sensitive content. Cancelling saves nothing. Only the goal definition is saved — no execution state, clarification answers or history.

Names may only contain lowercase letters, digits and hyphens, start with a letter or digit, and be at most 64 characters. An existing user snippet with the same name is never overwritten; delete the old file manually to update it.

## Sources and precedence

| Source | Location | Notes |
|---|---|---|
| Mine | `~/.pi/agent/pi-goal/snippets/<name>.goal.sexp` (follows `PI_CODING_AGENT_DIR`) | Global, available in every workspace |
| Built-in | `snippets/` in the plugin package | Shipped with the plugin, read-only |

On a name clash, your snippet overrides the built-in one, which lets you customize built-in templates (e.g. raise `site-design`'s review limit to 5). Invalid files are reported and skipped without affecting other snippets. To delete a user snippet, delete its file.

## Built-in snippets

| Name | Purpose |
|---|---|
| `site-design` | Award-tier page visual standard: 8 CHECK dimensions, Awwwards / Webby / FWA benchmarks, up to 3 self-review rounds on completion. See [Design objectives and review rules](sharing.md#design-objectives-and-review-rules) for its semantic boundaries |

Snippets are parsed as data only and never execute code; confirming a snippet does not replace the approvals required during execution.

[Back to README](../README.md)
