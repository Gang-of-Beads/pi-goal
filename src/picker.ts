import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { Goal } from "./index.ts";
import { elapsedMs, formatDuration, GOAL_LEGEND, goalIcon, type Paint, plain, progress, todoListLines, todoWindow } from "./status.ts";
import type { GoalTodo } from "./index.ts";

export interface PickerGroup { title: string; goals: Goal[] }
/** Panel state kept across reopenings so actions return to the same scope, search and selection. */
export interface PickerView { scope: number; query: string; searching: boolean; selected?: string }
export type PickerResult = { type: "close" } | { type: "open"; goal: Goal } | { type: "key"; key: string; goal?: Goal };

/** Single-letter shortcuts, active while the search box is not focused. */
export const SHORTCUTS = ["r", "p", "t", "s", "n", "e", "c", "d"] as const;
const SCOPE_CYCLE = "session → workspace → global";

function goalKey(goal: Goal): string {
  return goal.uuid ?? `${goal.workspace}#${goal.id}`;
}

export function goalItem(goal: Goal, showWorkspace: boolean, paint: Paint = plain): SelectItem {
  const details = [
    goal.todos?.length ? progress(goal) : "未确认 TODO",
    `累计执行 ${formatDuration(elapsedMs(goal))}`,
    ...(goal.updatedAt ? [`更新于 ${new Date(goal.updatedAt).toLocaleString()}`] : []),
    ...(showWorkspace && goal.workspace ? [goal.workspace] : []),
  ];
  return { value: goalKey(goal), label: `${goalIcon(goal, paint)} #${goal.id} ${goal.text.replace(/\s+/g, " ")}`, description: details.join(" · ") };
}

export function filterGoals(goals: readonly Goal[], query: string): Goal[] {
  return query.trim() ? fuzzyFilter([...goals], query, (goal) => `#${goal.id} ${goal.text}`) : [...goals];
}

/**
 * Goal manager modelled on pi-prompt-history: bordered panel, scope title, fuzzy filter, list with
 * descriptions and a key hint line. Tab cycles session → workspace → global.
 */
export function showGoalPicker(ctx: ExtensionContext, groups: readonly PickerGroup[], view: PickerView): Promise<PickerResult> {
  // Inline in the editor area, as in pi-prompt-history: overlays can be painted over by terminal images.
  return ctx.ui.custom<PickerResult>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const paint: Paint = (color, text) => theme.fg(color, text);
    const input = new Input();
    input.setValue(view.query);
    let focused = false;
    let matches: Goal[] = [];
    let selectedIndex = 0;
    let list: SelectList | undefined;

    const rebuild = (keepSelection: boolean) => {
      const group = groups[view.scope]!;
      matches = filterGoals(group.goals, view.query);
      const previous = keepSelection ? matches.findIndex((goal) => goalKey(goal) === view.selected) : -1;
      selectedIndex = previous >= 0 ? previous : 0;
      list = matches.length ? new SelectList(matches.map((goal) => goalItem(goal, view.scope === 2, paint)), 10, {
        selectedPrefix: (text) => theme.fg("accent", text),
        // Labels carry colored status symbols; bold keeps them visible on the selected row.
        selectedText: (text) => theme.bold(text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      }) : undefined;
      list?.setSelectedIndex(selectedIndex);
      view.selected = matches[selectedIndex] ? goalKey(matches[selectedIndex]!) : undefined;
    };
    const move = (delta: number) => {
      if (!matches.length) return;
      selectedIndex = Math.max(0, Math.min(matches.length - 1, selectedIndex + delta));
      list?.setSelectedIndex(selectedIndex);
      view.selected = goalKey(matches[selectedIndex]!);
    };
    const setSearching = (value: boolean) => {
      view.searching = value;
      input.focused = focused && value;
    };
    const clearSearch = () => {
      input.setValue("");
      view.query = "";
      setSearching(false);
      rebuild(true);
    };
    rebuild(true);

    return {
      get focused() { return focused; },
      set focused(value: boolean) {
        focused = value;
        input.focused = value && view.searching;
      },
      render(width: number) {
        const group = groups[view.scope]!;
        const count = view.query.trim() ? `${matches.length}/${group.goals.length}` : `${group.goals.length}`;
        container.clear();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold(`Goals — ${group.title} · ${count} 个`)), 1, 0));
        container.addChild(new Text(theme.fg("dim", view.searching ? "搜索（按目标文本 / 编号模糊过滤）：" : view.query ? "搜索：" : "按 / 搜索"), 1, 0));
        if (view.searching || view.query) container.addChild(input);
        if (list) container.addChild(list);
        else container.addChild(new Text(theme.fg("warning", group.goals.length ? "没有匹配的目标" : `${group.title} 暂无目标 · 按 n 新增 · Tab 切换范围`), 1, 0));
        const current = matches[selectedIndex];
        if (current) {
          // Preview of the selected goal's TODOs, folded around the one in progress.
          const preview = current.todos?.length ? todoWindow(current, 8, paint) : [theme.fg("dim", current.planConfirmed ? "暂无 TODO" : "尚未确认 TODO 计划")];
          container.addChild(new Text(theme.fg("dim", `TODO · #${current.id}${current.todos?.length ? ` · ${progress(current)}` : ""}`), 1, 0));
          for (const line of preview) container.addChild(new Text(`  ${line}`, 1, 0));
        }
        container.addChild(new Text(theme.fg("dim", `图例：${GOAL_LEGEND}`), 1, 0));
        container.addChild(new Text(theme.fg("dim", view.searching
          ? `输入过滤 · ↑↓ 选择 · Enter 操作菜单 · Tab 范围（${SCOPE_CYCLE}） · Esc 清空搜索`
          : `↑↓ 选择 · Enter 操作菜单 · Tab 范围（${SCOPE_CYCLE}） · / 搜索 · r 执行 · p 暂停 · t TODO · s 状态 · n 新增 · e 修改 · c 取消 · d 删除 · Esc 关闭`), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
        input.invalidate();
        list?.invalidate();
      },
      handleInput(data: string) {
        // Picker keys are handled here rather than by SelectList, as in pi-prompt-history.
        if (matchesKey(data, Key.tab)) {
          view.scope = (view.scope + 1) % groups.length;
          rebuild(false);
        } else if (matchesKey(data, Key.shift("tab"))) {
          view.scope = (view.scope + groups.length - 1) % groups.length;
          rebuild(false);
        } else if (matchesKey(data, Key.up)) move(-1);
        else if (matchesKey(data, Key.down)) move(1);
        else if (matchesKey(data, Key.pageUp)) move(-10);
        else if (matchesKey(data, Key.pageDown)) move(10);
        else if (matchesKey(data, Key.enter)) {
          const goal = matches[selectedIndex];
          if (goal) { done({ type: "open", goal }); return; }
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          if (view.searching || view.query) clearSearch();
          else { done({ type: "close" }); return; }
        } else if (view.searching) {
          input.handleInput(data);
          view.query = input.getValue();
          rebuild(false);
        } else if (matchesKey(data, "/")) {
          setSearching(true);
        } else {
          const key = SHORTCUTS.find((letter) => matchesKey(data, letter));
          if (key) { done({ type: "key", key, goal: matches[selectedIndex] }); return; }
        }
        tui.requestRender();
      },
    };
  });
}

/** TUI TODO list: symbol and text, with time and note on a grey second line. Resolves the chosen index. */
export function showTodoList(ctx: ExtensionContext, title: string, todos: readonly GoalTodo[], initial = 0): Promise<number | undefined> {
  return ctx.ui.custom<number | undefined>((tui, theme, _keybindings, done) => {
    const paint: Paint = (color, text) => theme.fg(color, text);
    let index = Math.max(0, Math.min(initial, todos.length - 1));
    const container = new Container();
    return {
      render(width: number) {
        container.clear();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        if (!todos.length) container.addChild(new Text(theme.fg("warning", "暂无 TODO"), 1, 0));
        // Scroll long lists: keep the selection within a window of at most 10 TODOs.
        const size = 10;
        const start = Math.max(0, Math.min(index - Math.floor(size / 2), todos.length - size));
        const end = Math.min(todos.length, start + size);
        if (start > 0) container.addChild(new Text(theme.fg("dim", `    … 上方还有 ${start} 项`), 1, 0));
        todos.slice(start, end).forEach((todo, offset) => {
          const position = start + offset;
          const [first, ...rest] = todoListLines(todo, paint);
          const selected = position === index;
          container.addChild(new Text(`${selected ? theme.fg("accent", "→ ") : "  "}${selected ? theme.bold(first!) : first}`, 1, 0));
          for (const line of rest) container.addChild(new Text(`  ${line}`, 1, 0));
        });
        if (end < todos.length) container.addChild(new Text(theme.fg("dim", `    … 下方还有 ${todos.length - end} 项`), 1, 0));
        container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 标记完成 / 重新打开 · Esc 返回"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return container.render(width);
      },
      invalidate() { container.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
        else if (matchesKey(data, Key.down)) index = Math.min(todos.length - 1, index + 1);
        else if (matchesKey(data, Key.enter)) { if (todos[index]) { done(index); return; } }
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { done(undefined); return; }
        tui.requestRender();
      },
    };
  });
}
