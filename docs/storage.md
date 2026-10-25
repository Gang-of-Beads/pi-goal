English | [中文](storage.zh-CN.md)

# Storage

Goal states: `awaiting clarification → TODOs confirmed → pending → running → awaiting review`; a goal can also become `paused` or `cancelled`, or `done`. A goal becomes done automatically once every TODO is done (each requires verification evidence), whether by the AI or by you, and can be reopened (goals with a design objective or review loop stay awaiting review for your final check); an AI turn ending with unfinished TODOs leaves it awaiting review, and aborted runs and final errors mark it as paused.

Each goal is saved as `<agent dir>/pi-goal/goals/<workspace key>/<uuidv7>.json`, where the agent directory is `~/.pi/agent` by default (or `PI_CODING_AGENT_DIR`) and the workspace key is the SHA-256 hex digest of the project's absolute path; nothing is written inside the project. Each file contains the UUID, the project-local display id, goal text, creation / update times, clarification answers, plan confirmation state, full TODOs (status, completion time and verification note), accumulated execution time (optional `elapsedMs` in milliseconds; while running there is also `runStartedAt` for the current run; older files count as 0), the approval list (optional `approvals`: action descriptions and exact commands; `approvalsConfirmed` records whether they were approved when the plan was confirmed — `false` for imported goals), and a history of goal text / status / TODO changes.

Files record their `workspace` and the creating `sessionId`. Each workspace directory also holds a `workspace.json` (`{"workspace": "<absolute path>"}`) describing which project it belongs to; "All goals" walks `pi-goal/goals/*/` and reads these files, so no separate registry is needed and the disk is never scanned. Moving or renaming a project changes its key: move its directory to the new key and update `workspace.json` to keep its goals. To remove a deleted project's goals, delete its directory.

Files are written by atomic replacement with mode `0600`. If another session changed a file, overwriting is refused; run `/reload` and try again. Several sessions can view the same project's goals. Unparseable or invalid goal files and workspace directories (missing `workspace.json`, or a path that does not match the directory name) are reported and skipped — never modified or deleted — without affecting other goals; on duplicate ids the earliest goal keeps its id and later ones are renumbered and written back. On restore, running goals are marked paused and never resume on their own. Deleting a goal deletes its JSON file. Older session records are not migrated; tool calls and full AI conversations stay in Pi's sessions and are not copied into goal files.

These JSON files may contain sensitive clarification answers and verification notes; they stay in your agent directory and are never committed with the project.

## Migrating from 0.1.x

Up to 0.1.x, goals were stored in each project's `.pi/goals/` with an index in `pi-goal/workspaces/`. Since 0.2.0 these locations are **no longer read or migrated automatically**. To keep old goals, close or `/reload` other Pi sessions using the project, then copy them once:

```sh
P=/absolute/path/to/project
D=~/.pi/agent/pi-goal/goals/$(printf %s "$P" | shasum -a 256 | cut -d' ' -f1)
mkdir -p "$D" && cp -p "$P"/.pi/goals/*.json "$D"/
printf '{"workspace":"%s"}\n' "$P" > "$D/workspace.json"
```

Use the project's absolute path without a trailing slash (resolve symlinks the way Pi sees the working directory, e.g. `/private/tmp` on macOS). After `/reload`, check the goals in `/goal`, then delete `"$P"/.pi/goals` and `~/.pi/agent/pi-goal/workspaces/`.

[Back to README](../README.md)
