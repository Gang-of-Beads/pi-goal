import type { Goal, GoalStatus, GoalTodo, TodoStatus } from "./index.ts";

/** Pi theme colors used for status symbols. */
export type StatusColor = "accent" | "success" | "warning" | "muted" | "error" | "dim";
/** Colors text in the TUI; dialog-only clients and logs get plain text (see `plain`). */
export type Paint = (color: StatusColor, text: string) => string;
export const plain: Paint = (_color, text) => text;

export const LABELS: Record<GoalStatus, string> = {
  clarifying: "待澄清", pending: "待执行", running: "执行中", paused: "已暂停", review: "待确认", done: "已完成", cancelled: "已取消",
};
/** Single-width symbols keep columns aligned in every terminal. */
export const GOAL_ICONS: Record<GoalStatus, string> = { clarifying: "?", pending: "○", running: "▶", paused: "‖", review: "◎", done: "✓", cancelled: "✗" };
const GOAL_COLORS: Record<GoalStatus, StatusColor> = {
  clarifying: "warning", pending: "muted", running: "accent", paused: "muted", review: "warning", done: "success", cancelled: "error",
};
export const TODO_ICONS: Record<TodoStatus, string> = { done: "✓", running: "▶", blocked: "✗", pending: "○" };
export const TODO_LABELS: Record<TodoStatus, string> = { pending: "待执行", running: "执行中", blocked: "阻塞", done: "已完成" };
const TODO_COLORS: Record<TodoStatus, StatusColor> = { done: "success", running: "accent", blocked: "error", pending: "muted" };

export const GOAL_LEGEND = (["running", "review", "clarifying", "pending", "paused", "done", "cancelled"] as const)
  .map((status) => `${GOAL_ICONS[status]} ${LABELS[status]}`).join(" · ");

/** Display priority: active work first, finished goals last. */
const STATUS_ORDER: Record<GoalStatus, number> = { running: 0, review: 1, paused: 2, clarifying: 3, pending: 4, done: 5, cancelled: 6 };

/** Goals ordered by status priority, then most recently updated, so active work is never folded away. */
export function sortGoals<T extends Goal>(goals: readonly T[]): T[] {
  const updated = (goal: Goal) => (goal.updatedAt ? Date.parse(goal.updatedAt) : 0) || 0;
  return [...goals].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || updated(b) - updated(a) || b.id - a.id);
}

/** Per-status counts as colored symbols, e.g. "▶ 1 · ◎ 2 · ✓ 3", in priority order. */
export function statusCounts(goals: readonly Goal[], paint: Paint = plain): string {
  const counts = new Map<GoalStatus, number>();
  for (const goal of goals) counts.set(goal.status, (counts.get(goal.status) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => STATUS_ORDER[a] - STATUS_ORDER[b])
    .map(([status, count]) => `${paint(GOAL_COLORS[status], GOAL_ICONS[status])} ${count}`).join(" · ");
}

export function goalIcon(goal: Goal, paint: Paint = plain): string {
  return paint(GOAL_COLORS[goal.status], GOAL_ICONS[goal.status]);
}
/** Symbol plus word, for detail views. */
export function goalStatusText(goal: Goal, paint: Paint = plain): string {
  return paint(GOAL_COLORS[goal.status], `${GOAL_ICONS[goal.status]} ${LABELS[goal.status]}`);
}
export function todoIcon(todo: GoalTodo, paint: Paint = plain): string {
  return paint(TODO_COLORS[todo.status], TODO_ICONS[todo.status]);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** Cap a one-line text at `max` characters so compact views stay on one terminal row. */
const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);

/** List label: symbol only, no status word. */
export function goalListLabel(goal: Goal, paint: Paint = plain, maxText = Infinity): string {
  const progressText = goal.todos?.length ? ` · ${progress(goal)}` : "";
  // Compact views cap the title so each goal stays on one line.
  return `${goalIcon(goal, paint)} #${goal.id} ${clip(oneLine(goal.text), maxText)}${progressText}`;
}

/** Grey second line of a TODO: completion time and done / blocked note. */
export function todoNote(todo: GoalTodo): string | undefined {
  const parts = [
    ...(todo.completedAt ? [`完成于 ${new Date(todo.completedAt).toLocaleString()}`] : []),
    ...(todo.evidence ? [`${todo.status === "blocked" ? "阻塞说明" : "说明"}：${oneLine(todo.evidence)}`] : []),
  ];
  return parts.length ? parts.join(" · ") : undefined;
}

/** Indented two-line list entry used by /goal status and the TODO list. */
export function todoListLines(todo: GoalTodo, paint: Paint = plain, indent = ""): string[] {
  const note = todoNote(todo);
  return [`${indent}${todoLine(todo, paint)}`, ...(note ? [`${indent}    ${paint("dim", note)}`] : [])];
}

/** Accumulated execution time: finished runs plus the current run, if any. Paused time never counts. */
export function elapsedMs(goal: Goal, now = Date.now()): number {
  const current = goal.runStartedAt ? Math.max(0, now - Date.parse(goal.runStartedAt)) : 0;
  return (goal.elapsedMs ?? 0) + current;
}

/**
 * Keep elapsed time in step with status changes: entering running starts a run, leaving it adds the run.
 * Called before every save, so every transition (start, pause, settle, cancel, shutdown) is covered.
 */
export function trackElapsed(goal: Goal, now = Date.now()) {
  if (goal.status === "running") {
    goal.runStartedAt ??= new Date(now).toISOString();
  } else if (goal.runStartedAt) {
    goal.elapsedMs = elapsedMs(goal, now);
    delete goal.runStartedAt;
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
}

export function progress(goal: Goal): string {
  const todos = goal.todos ?? [];
  return `TODO ${todos.filter((todo) => todo.status === "done").length}/${todos.length}`;
}

/** The TODO being worked on, or else the first unfinished one. */
export function focusTodo(goal: Goal): GoalTodo | undefined {
  const todos = goal.todos ?? [];
  return todos.find((todo) => todo.status === "running") ?? todos.find((todo) => todo.status !== "done");
}

export function todoLine(todo: GoalTodo, paint: Paint = plain, maxText = Infinity): string {
  return `${todoIcon(todo, paint)} TODO #${todo.id} ${clip(oneLine(todo.text), maxText)}`;
}

/**
 * At most `max` lines: the focused TODO with its neighbours; the rest fold into "… 另有 N 项" markers.
 */
export function todoWindow(goal: Goal, max = 8, paint: Paint = plain, maxText = Infinity): string[] {
  const todos = goal.todos ?? [];
  const line = (todo: GoalTodo) => todoLine(todo, paint, maxText);
  if (todos.length <= max) return todos.map(line);
  const focus = focusTodo(goal);
  const center = focus ? todos.indexOf(focus) : todos.length - 1;
  // Reserve a line for each fold marker that will be needed.
  let size = max - 2;
  let start = Math.max(0, Math.min(center - Math.floor((size - 1) / 2), todos.length - size));
  if (start === 0 || start + size >= todos.length) {
    size = max - 1;
    start = start === 0 ? 0 : todos.length - size;
  }
  const end = start + size;
  return [
    ...(start > 0 ? [paint("dim", `  … 另有 ${start} 项`)] : []),
    ...todos.slice(start, end).map(line),
    ...(end < todos.length ? [paint("dim", `  … 另有 ${todos.length - end} 项`)] : []),
  ];
}

/** Compact footer text for the running goal. */
export function statusBarText(goal: Goal, now = Date.now(), paint: Paint = plain): string {
  const focus = focusTodo(goal);
  let current = focus ? ` · TODO #${focus.id} ${oneLine(focus.text)}` : "";
  const base = `#${goal.id} · ${progress(goal)} · ${formatDuration(elapsedMs(goal, now))}`;
  // Truncate before coloring so escape sequences are never cut.
  if (base.length + current.length > 78) current = `${current.slice(0, Math.max(0, 77 - base.length))}…`;
  return `${goalIcon(goal, paint)} 目标 ${base}${focus ? ` · ${todoIcon(focus, paint)}${current.slice(2)}` : ""}`;
}

export function runningWidget(goal: Goal, now = Date.now(), paint: Paint = plain): string[] {
  return [
    `${goalIcon(goal, paint)} Goal #${goal.id} ${clip(oneLine(goal.text), 40)} · ${progress(goal)} · 已执行 ${formatDuration(elapsedMs(goal, now))} ${paint("dim", "· /goal status 查看详情")}`,
    ...todoWindow(goal, 8, paint, 60),
  ];
}

/** Full status of one goal, including completion times and done/blocked notes. */
export function statusDetails(goal: Goal, now = Date.now(), paint: Paint = plain): string {
  const focus = focusTodo(goal);
  const lines = [
    `${goalStatusText(goal, paint)} · #${goal.id} ${oneLine(goal.text)}`,
    `进度：${progress(goal)} · 累计执行 ${formatDuration(elapsedMs(goal, now))}${focus ? ` · ${focus.status === "running" ? "正在执行" : "下一项"}：TODO #${focus.id}` : ""}`,
  ];
  if (!goal.todos?.length) lines.push(goal.planConfirmed ? "暂无 TODO" : "尚未确认 TODO 计划");
  for (const todo of goal.todos ?? []) lines.push(...todoListLines(todo, paint, "  "));
  return lines.join("\n");
}

/** One-line-per-goal summary with the TODO in focus. */
export function statusSummary(goals: readonly Goal[], now = Date.now(), paint: Paint = plain): string {
  const open = goals.filter((goal) => goal.status !== "done" && goal.status !== "cancelled");
  if (!open.length) return "当前 Session 没有未完成的目标。用 /goal 查看全部目标。";
  return [
    `当前 Session · ${open.length} 个未完成目标（/goal status #<编号> 查看详情）`,
    ...open.flatMap((goal) => {
      const focus = focusTodo(goal);
      return [
        `${goalStatusText(goal, paint)} · #${goal.id} ${oneLine(goal.text)} · ${progress(goal)} · 累计执行 ${formatDuration(elapsedMs(goal, now))}`,
        ...(focus ? [`    ${todoLine(focus, paint)}`] : []),
      ];
    }),
  ].join("\n");
}
