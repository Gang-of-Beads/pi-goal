import { truncateToVisualLines, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Always offered after the AI-provided options so the user is never forced into a listed answer. */
export const OTHER_OPTION = "其他（自定义输入）";
export const YES_OPTION = "是";
export const NO_OPTION = "否";

/** Trimmed, nonblank, unique options; the reserved "other" label is supplied by the plugin. */
export function normalizeOptions(options: readonly string[]): string[] {
  return [...new Set(options.map((option) => option.replace(/\s+/g, " ").trim()))].filter((option) => option && option !== OTHER_OPTION);
}

async function customText(ctx: ExtensionContext, title: string): Promise<string | undefined> {
  const text = await ctx.ui.editor(`${title}\n（${OTHER_OPTION}）`);
  return text?.trim() || undefined;
}

type CardAnswer = { values?: { answer?: { selected?: string[]; other?: string } } } | undefined;

/**
 * Hosts listing "card" in `ctx.ui.piWebScreens` (PI WEB) draw this declared choice card natively,
 * with ticks for multiple choice and a box for a custom answer; pi's terminal ignores `web`.
 * Returns undefined when the host draws no card or the options exceed its bounds, null when the
 * card closed unanswered (cancelled, not asked again), otherwise the answers in option order.
 */
async function choiceCard(ctx: ExtensionContext, title: string, options: readonly string[], multiple: boolean): Promise<string[] | null | undefined> {
  const screens = (ctx.ui as { piWebScreens?: readonly string[] }).piWebScreens;
  if (ctx.mode === "tui" || !screens?.includes("card") || !options.length || options.length > 12 || [title, ...options].some((text) => text.length > 1000)) return undefined;
  const field = { type: "choice", id: "answer", label: title, options: options.map((label, index) => ({ value: String(index), label })), other: "field", required: true, ...(multiple ? { multiple: true } : {}) };
  const declaration = { web: { kind: "card", fields: [field] } } as Parameters<typeof ctx.ui.custom>[1];
  const result = await ctx.ui.custom<CardAnswer>((_tui, _theme, _keybindings, done) => ({ render: () => [title], invalidate() {}, handleInput: () => done(undefined) }), declaration);
  const answer = result?.values?.answer;
  const other = answer?.other?.trim();
  const picked = [...options.filter((_option, index) => answer?.selected?.includes(String(index))), ...(other ? [other] : [])];
  return picked.length ? picked : null;
}

/** Single choice with ↑↓ + Enter. Returns undefined when cancelled. */
export async function chooseOne(ctx: ExtensionContext, title: string, options: readonly string[]): Promise<string | undefined> {
  const items = normalizeOptions(options);
  const card = await choiceCard(ctx, title, items, false);
  if (card !== undefined) return card?.[0];
  const selected = await ctx.ui.select(title, [...items, OTHER_OPTION]);
  if (selected === undefined) return undefined;
  return selected === OTHER_OPTION ? customText(ctx, title) : selected;
}

/**
 * Multiple choice: a keyboard checklist in the TUI (↑↓ move, Space toggle, Enter confirm, Esc cancel).
 * Dialog-only clients (RPC) cannot host custom components, so they fall back to a free-text editor.
 */
export async function chooseMany(ctx: ExtensionContext, title: string, options: readonly string[]): Promise<string[] | undefined> {
  const items = [...normalizeOptions(options), OTHER_OPTION];
  const card = await choiceCard(ctx, title, items.slice(0, -1), true);
  if (card !== undefined) return card ?? undefined;
  if (ctx.mode !== "tui") {
    const text = await ctx.ui.editor(`${title}\n可多选，每行填写一项：\n${items.slice(0, -1).map((option) => `- ${option}`).join("\n")}`);
    const answers = text?.split("\n").map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean) ?? [];
    return answers.length ? answers : undefined;
  }
  const picked = await ctx.ui.custom<number[] | undefined>((tui, theme, keybindings, done) => {
    let cursor = 0;
    const checked = new Set<number>();
    let cache: { width: number; lines: string[] } | undefined;
    const update = () => { cache = undefined; tui.requestRender(); };
    const wrap = (text: string, width: number) => truncateToVisualLines(text, 1000, Math.max(1, width), 0, "start").visualLines;
    return {
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up")) { cursor = (cursor + items.length - 1) % items.length; update(); }
        else if (keybindings.matches(data, "tui.select.down")) { cursor = (cursor + 1) % items.length; update(); }
        else if (data === " ") {
          if (!checked.delete(cursor)) checked.add(cursor);
          update();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          // Enter without any ticks picks the highlighted item, like a single-choice list.
          done(checked.size ? [...checked].sort((a, b) => a - b) : [cursor]);
        } else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
      },
      render(width: number) {
        if (cache?.width === width) return cache.lines;
        const lines = [
          ...wrap(theme.fg("accent", title), width),
          "",
          ...items.flatMap((item, index) => {
            const line = `${index === cursor ? "›" : " "} ${checked.has(index) ? "[x]" : "[ ]"} ${item}`;
            return wrap(index === cursor ? theme.fg("accent", line) : line, width);
          }),
          "",
          ...wrap(theme.fg("dim", "↑↓ 移动 · 空格 勾选 · 回车 确认 · Esc 取消"), width),
        ];
        cache = { width, lines };
        return lines;
      },
      invalidate() { cache = undefined; },
    };
  });
  if (!picked?.length) return undefined;
  const answers = picked.filter((index) => index < items.length - 1).map((index) => items[index]!);
  if (picked.includes(items.length - 1)) {
    const text = await customText(ctx, title);
    if (text) answers.push(text);
  }
  return answers.length ? answers : undefined;
}

/** Yes/no question answered by keyboard selection, still allowing a free-text reply. */
export function chooseYesNo(ctx: ExtensionContext, title: string): Promise<string | undefined> {
  return chooseOne(ctx, title, [YES_OPTION, NO_OPTION]);
}
