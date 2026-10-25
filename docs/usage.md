English | [中文](usage.zh-CN.md)

# Usage

## Overview

```text
/goal add a health check endpoint and verify it
/goal
/goal status
/goal @site-design home page https://example.com
```

- `/goal <task>`: clarify the goal interactively and confirm its TODOs. Pick options with the arrow keys; confirmation defaults to "confirm and run now", or you can run it later.
- `/goal`: open the goal panel, showing the current session's goals by default. Tab switches to Workspace / All goals, `/` searches, and single-letter shortcuts run, pause, show TODOs and more.
- `/goal status [#id]`: show goal status — which TODOs are done, which one is in progress, blocked notes and accumulated execution time.
- `/goal @<snippet>`: create a goal from a cross-project [snippet](snippets.md), such as the built-in `site-design`.
- `/goal run #<id>` / `/goal pause #<id>`: run or pause a goal directly, with the same checks as the panel's `r` / `p` keys and the outcome reported as a notice — useful for clients that drive `/goal` by command, such as a web page's buttons.
- `/goal help`: show all usage (`#<id>` to open a goal, import / export, save a snippet, ...); the full list is in [Commands](#commands).

Everything goes through `/goal`; `/goal-import`, `/goal-export`, `/goal-snippet` and `/goal-snippet-save` are only aliases.

Statuses are shown as theme-colored [symbols](#status-symbols-and-colors). While a goal runs, the area above the input shows its TODO list and the footer shows progress, time and the current TODO; the `/goal` panel previews the selected goal's TODOs. When confirming a plan you can approve a list of high-impact actions with exact commands at once; after a run stops on a blocker, simply replying continues the goal (see [Fewer interruptions during execution](#fewer-interruptions-during-execution)).

Running, pausing, editing, cancelling and rollback requests are supported. Goals are persisted as UUIDv7 JSON files (see [Storage](storage.md)); rollback cannot guarantee every operation is reversible, and high-risk actions still need approval.

## Clarification and confirmation

`/goal <task>` creates the goal; the current AI then asks questions to clarify scope, acceptance criteria and constraints, and drafts a TODO list.

Clarification is answered by keyboard where possible:

- **Single choice**: when the AI offers options, choose with ↑↓ and Enter — no need to type a/b/c.
- **Multiple choice**: ↑↓ to move, Space to tick, Enter to confirm, Escape to cancel; with nothing ticked, Enter picks the highlighted item. Multiple answers are saved joined by "；". RPC clients cannot show custom components and fall back to multi-line text input (one item per line).
- **Yes / no**: choose "是 / 否" instead of typing yes/no.
- Every option list ends with "其他（自定义输入）" (other), which opens an editor for free text; questions whose answers cannot be enumerated use the editor directly.

Confirming the TODOs is a single choice:

- **确认并立即执行 — confirm and run now** (default, just press Enter): save the plan and start execution automatically once the clarification turn ends; if that turn is interrupted, the plan is only saved and can be started from the panel.
- **确认，稍后从 /goal 执行 — confirm, run later**: save only; start later with "执行 / 继续" (run / continue) in the panel.
- **编辑 TODO — edit TODOs**: edit line by line in an editor, then return to this choice; a cancelled or empty edit keeps the previous TODOs.
- **取消 — cancel**: stop planning; clarification can be resumed later from the panel.

Without a selected model, or with a model missing credentials, a new goal is saved as awaiting clarification and no AI turn starts; resume it from the panel ("继续澄清") once configured.

## Fewer interruptions during execution

- **Preflight during clarification**: before the plan is confirmed, the AI runs read-only checks of everything the plan depends on (logins and credentials, permissions, repository or resource visibility, external platform rules and deadlines) and raises anything that needs your decision or action during clarification.
- **One-time approval list**: high-impact actions the plan needs (push, tag, release, publish, deploy, delete, sending messages, ...) are listed with an action description and exact command in the confirmation dialog's approval list; confirming the plan approves them all, and running them during execution needs no further confirmation. High-impact actions outside the list, materially changed commands or a changed scope still require asking first; steps only you can perform (2FA / OTP, browser login) are marked as yours. Your higher-level rules (e.g. Terraform apply needing approval right before it runs) are unaffected. Editing the goal invalidates the approvals until the plan is clarified and confirmed again.
- **Finish what you can when blocked**: the execution prompt asks the AI, when blocked, to first complete every TODO that does not depend on the blocker and prepare what it can (drafts, commits, commands), then ask all pending questions in one message; when continuing, it checks what changed first and does not repeat questions without new information.
- **Reply to continue**: when a run worked on the goal but ended with unfinished TODOs (awaiting review), the footer shows "↩ 下条消息将续接目标 #N" (next message continues goal #N). Your next ordinary message (not a `/` command or `!` shell line) resumes the goal automatically: timing, the widget and `goal_todo` work again, and the goal and TODO status are given to the AI. The continuation applies to that next message only; if that turn makes no progress on the goal (e.g. the message is unrelated), the goal returns to awaiting review and is not continued again. Pausing the goal, starting another goal or re-clarifying in `/goal` cancels the continuation.

"查看目标定义" (view goal definition) in the panel and `/goal status` show the approval list and its state (approved / suggested).

## Goal panel

`/goal` opens the goal manager, showing the current session's goals by default. There are three scopes:

- **当前 Session — current session**: goals in the current workspace created by the current session.
- **当前 Workspace — current workspace**: all goals in the current working directory, regardless of session.
- **所有 Goal — all goals**: goals from every workspace stored under the agent directory (see [Storage](storage.md)), with their paths.

The scopes overlap rather than partition. Goals from other workspaces are read-only (details and status); run or edit them in their own workspace. Older files without a session only appear under Workspace / All goals.

In the TUI the panel follows [pi-prompt-history](https://github.com/light4/pi-prompt-history): a bordered panel whose title shows the scope and count, with a grey description per goal (TODO progress, accumulated time, update time; plus the workspace under All goals). Below the list are the selected goal's details: the full title with its status word (up to 3 lines; longer titles point to "查看目标定义"), TODO progress, accumulated time and update time, followed by a TODO preview (about 8 lines, folded around the TODO in progress or the first unfinished one); a status legend and key hints sit at the bottom. The list is ordered running → awaiting review → paused → awaiting clarification → pending → done → cancelled, most recently updated first within a status.

### Keys

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle scopes session → workspace → global |
| `↑` `↓` / `PageUp` `PageDown` | Select a goal |
| `/` | Search: fuzzy filter by goal text or id (e.g. `#3`); the search is kept when switching scopes |
| `Enter` | Open the selected goal's action menu |
| `Esc` | While searching, clear and leave the search; otherwise close the panel |
| `r` | Run / continue; continues clarification if the plan is not confirmed |
| `p` | Pause |
| `t` | TODOs and status: status, progress, accumulated time and the TODO in progress / next at the top, the TODO list below; read-only for goals from other workspaces |
| `n` | New: blank goal / from a snippet / import a goal template |
| `e` / `c` / `d` | Edit / cancel / delete (cancel and delete still ask for confirmation) |

Single-letter shortcuts work only outside search; unavailable actions (e.g. pausing a goal that is not running) show a hint, with the same state rules as the action menu. After an action you return to the panel with scope, search and selection kept; starting execution or clarification closes the panel.

Dialog-only clients such as RPC use select lists: they open on the current session's list, "切换到：…" (switch to) items change scope, and "＋ 新增目标" (new goal) offers blank / snippet / import.

### Action menu

The most likely action comes first: pause for a running goal, reopen for a done one, mark done once every TODO is done, otherwise run / continue. Then the other frequent actions (run / continue, mark done, TODOs, view definition, edit), and finally sharing and destructive ones (export, save as snippet, cancel, delete).

- **新增目标 / 继续澄清 — new goal / continue clarifying**: the AI asks questions, records answers and confirms a TODO plan; a cancelled clarification can be resumed later.
- **展开 TODO — TODOs**: each TODO's status (pending, running, blocked or done), completion time and verification note. During execution the AI updates them with `goal_todo`; when idle you can mark a TODO done or reopen it. Marking done requires a verification note; the plugin records the time.
- **执行 / 继续 — run / continue**: execute the goal with the current model and tools; continuing uses the existing conversation and the latest goal text.
- **暂停 — pause**: pause the goal; if it is running, the current AI turn is aborted.
- **修改 — edit**: edit the goal text; a running goal must be paused and the AI stopped first. After editing, the plan must be clarified and confirmed again; the old TODOs remain for reference until a new plan replaces them.
- **标记完成 / 重新打开 — mark done / reopen**: a goal is marked done automatically when its last TODO is done (by the AI at the end of a run, or by you in the TODO view); goals with a design objective or review loop stay awaiting review for your final check. You can also mark a goal done once all TODOs are done, and reopen it.
- **取消目标 — cancel goal**: choose "保留已有操作" (keep changes) or "回滚所有操作" (roll back all changes), or go back. The record stays as cancelled; rollback first stops the goal, waits for tool calls to finish, then starts an AI rollback turn.
- **删除 — delete**: delete the record after confirmation; a running goal is paused first. Deleting only removes the record; to undo changes, use "cancel goal" first.

## Status display

### Goal summary

The area above the input shows a goal summary: the header counts goals per status; at most 3 unfinished goals are listed, ordered running → awaiting review → paused → awaiting clarification → pending, most recently updated first within a status; done and cancelled goals are not listed and, together with goals beyond the limit, fold into "… 另有 N 个未列出" (N more not listed); when everything has ended, only the header remains, noting "均已结束" (all ended). Long titles are cut to one line. The full list is in the `/goal` panel.

### Status symbols and colors

Lists, widgets, the footer and select dialogs show only symbols; `/goal status`, status and goal details show symbol plus word. Colors follow the current pi theme:

| Goal status | Symbol | Color |
|---|---|---|
| Running (执行中) | `▶` | accent |
| Awaiting review (待确认) | `◎` | warning (yellow) |
| Awaiting clarification (待澄清) | `?` | warning (yellow) |
| Pending (待执行) | `○` | muted (grey) |
| Paused (已暂停) | `‖` | muted (grey) |
| Done (已完成) | `✓` | success (green) |
| Cancelled (已取消) | `✗` | error (red) |

TODOs: `✓` done (green), `▶` running (accent), `✗` blocked (red), `○` pending (grey). Colors appear only in the TUI; RPC clients and output without a UI get plain text that keeps the symbols.

### TODO list

"展开 TODO" (shortcut `t`, with status and progress at the top) and `/goal status` show TODOs as an indented list: the first line has the status symbol and TODO text, and a grey second line shows the completion time and done or blocked note. In the TUI each TODO and note takes one row (long text is cut; the dialog opened with Enter shows it in full); use ↑↓ to select (long lists scroll), Enter to mark done or reopen, Esc to go back. RPC clients get a select list with one row per TODO.

### Execution status

While a goal runs, the area above the input shows that goal's TODO view, returning to the goal summary when the run ends, pauses or is cancelled:

- Header: the goal, TODO progress (e.g. `TODO 3/9`) and accumulated execution time.
- TODOs are marked with [status symbols](#status-symbols-and-colors). With many TODOs only the one in progress (or the first unfinished one) and its neighbours are shown; the rest fold into "… 另有 N 项" (N more), at most 8 lines.
- The footer shows `目标 #id · progress · time · current TODO`.

Time accumulates across all runs of a goal; paused, awaiting-review and other idle periods do not count. It refreshes every minute while running, to minute precision. If the process exits unexpectedly, the run is settled at its last recorded update.

`/goal status #<id>` prints the full status: goal status, progress, accumulated time, the TODO in progress or next, each TODO's completion time and done or blocked note, and the approval list. Without an id it shows the running goal, or a summary of the current session's unfinished goals when none is running.

## Commands

Everything goes through `/goal`:

| Usage | Action |
|---|---|
| `/goal` | Open the goal panel (current session by default; Tab switches scope) |
| `/goal <task>` | Create a goal and clarify its TODOs interactively |
| `/goal #<id>` | Open that goal's action menu in the current workspace |
| `/goal status [#<id>]` | Show goal status, TODO progress and accumulated time |
| `/goal run #<id>` | Run / continue the goal (continues clarification if the plan is not confirmed) without opening the panel |
| `/goal pause #<id>` | Pause the goal without opening the panel |
| `/goal @` / `/goal @<snippet> [extra context]` | Create a goal from a [snippet](snippets.md) |
| `/goal import <file.goal.sexp>` | Import a template, see [Sharing](sharing.md) |
| `/goal export <id> [file.goal.sexp]` | Export a template |
| `/goal export <id> @<name>` | Save as a global snippet |
| `/goal help` | Show usage |

Opening a goal requires `#`: `/goal #1`. A bare number such as `/goal 1` is ambiguous; it suggests `#1` and neither opens nor creates a goal. Text is treated as a subcommand only when it matches the forms above exactly: `run` / `pause` need `#<id>`, the `export` id must be numeric, `import` / `export` files must end with `.goal.sexp`, and `@` must be followed by a valid snippet name. Any other text (e.g. `/goal import the customer data`) creates a new goal. After typing `/goal `, subcommands, `#<id>` and snippet names autocomplete.

`/goal-import`, `/goal-export`, `/goal-snippet` and `/goal-snippet-save` are aliases with the same behavior as the corresponding usage above.

## Execution boundaries

- Uses the current session's model and tools without spawning extra agents; one goal runs at a time.
- `/goal <task>` creates a goal and starts clarifying; while the AI is busy it is only saved as awaiting clarification — nothing is interrupted or queued.
- The panel can be opened while the AI runs; pausing only aborts the current run and does not undo completed file changes, external operations or previously queued messages. Deleting a goal likewise undoes no changes and deletes no conversation history.
- Existing project rules and approval requirements still apply, and a goal is not authorization for high-risk actions; only commands on the approval list confirmed with the plan may run directly.
- "回滚所有操作" (roll back all changes) is a rollback request for the AI to verify and carry out, not a snapshot restore, and cannot guarantee every operation is reversible. The AI identifies the goal's changes from the session's tool calls and current state, protecting pre-existing work and other goals' changes, and asks first when attribution or the original state is unclear. External, destructive, production or other high-risk reversals still need explicit approval. Results are reported in the conversation; a goal shown as cancelled does not mean rollback has completed.
- Rollback cannot interrupt another running task; if it is aborted or cannot start, choose "取消目标 → 回滚所有操作" on the goal again. The plugin never runs `git reset --hard` or wipes the working tree on its own.
- Continuing after a pause is a new AI turn, not a process-level resume; review the AI's output and verification results.
- Without a UI, `/goal` prints goals and TODOs as notifications; goal drafts can be saved, but interactive clarification and confirmation need the TUI or an RPC client that supports dialogs.

[Back to README](../README.md)
