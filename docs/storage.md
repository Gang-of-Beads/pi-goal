English | [中文](storage.zh-CN.md)

# Storage

Goal states: `awaiting clarification → TODOs confirmed → pending → running → awaiting review`; a goal can also become `paused` or `cancelled`, or be marked `done` by you. An AI turn ending does not mean the goal is done, so success is never marked automatically; aborted runs and final errors mark the goal as paused.

Each goal is saved as `.pi/goals/<uuidv7>.json` in the current project, containing the UUID, the project-local display id, goal text, creation / update times, clarification answers, plan confirmation state, full TODOs (status, completion time and verification note), accumulated execution time (optional `elapsedMs` in milliseconds; while running there is also `runStartedAt` for the current run; older files count as 0), the approval list (optional `approvals`: action descriptions and exact commands; `approvalsConfirmed` records whether they were approved when the plan was confirmed — `false` for imported goals), and a history of goal text / status / TODO changes.

Files record their `workspace` and the creating `sessionId`. The workspace registry lives in the Pi agent directory under `pi-goal/workspaces/` (default `~/.pi/agent/pi-goal/workspaces/`), one index file per workspace, so "All goals" can find goals without scanning the disk.

Files are written by atomic replacement with mode `0600`. If another session changed a file, overwriting is refused; run `/reload` and try again. Several sessions can view the same project's goals. Unparseable or invalid goal files and workspace index entries are reported and skipped — never modified or deleted — without affecting other goals; on duplicate ids the earliest goal keeps its id and later ones are renumbered and written back. On restore, running goals are marked paused and never resume on their own. Deleting a goal deletes its JSON file. Older session records are not migrated; tool calls and full AI conversations stay in Pi's sessions and are not copied into goal files.

These JSON files may contain sensitive clarification answers and verification notes; whether to add `.pi/goals/` to the project's `.gitignore` is up to you.

[Back to README](../README.md)
