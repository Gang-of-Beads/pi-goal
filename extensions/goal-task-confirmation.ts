import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { GoalTask } from "./goal-record.ts";
import { borderedLine, dialogInnerWidth, horizontalRule } from "./widgets/dialog-scaffold.ts";

/** Render a task tree for confirmation dialogs (structural view). */
export function renderConfirmationTasks(tasks: readonly GoalTask[], indent: number): string[] {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const t of tasks) {
		const lw = t.lightweightSubtasks ? " (lightweight)" : "";
		const contract = t.verificationContract ? ` contract: ${t.verificationContract}` : "";
		lines.push(`${prefix}[ ] ${t.id}: ${t.title}${lw}${contract}`);
		if (t.subtasks && t.subtasks.length > 0) {
			lines.push(...renderConfirmationTasks(t.subtasks, indent + 1));
		}
	}
	return lines;
}

/**
 * Task-only confirmation boundary (follow-up Stage 2). The complete result is
 * the user's {decision: confirm | cancel} — no auditor toggle, no
 * goal-creation wording, and no questionnaire state. `set_goal_tasks` confirms
 * the STRUCTURAL input here and merges progress only inside GoalService.apply
 * against the disk-refreshed clone. The dialog is a small self-contained
 * component with neutral, task-specific labels.
 */
export interface TaskConfirmationResult {
	decision: "confirm" | "cancel";
}

export const TASK_CONFIRMATION_TITLE = "Task list confirmation";

export const TASK_CONFIRMATION_OPTIONS: ReadonlyArray<{ label: string; value: TaskConfirmationResult["decision"]; description: string }> = [
	{
		label: "Confirm task list",
		value: "confirm",
		description: "Replace the current task list with this structure.",
	},
	{
		label: "Keep current tasks",
		value: "cancel",
		description: "Leave the existing task list unchanged.",
	},
];

export async function showTaskConfirmation(ctx: ExtensionContext, proposalText: string): Promise<TaskConfirmationResult> {
	const autoConfirmEnv = process.env.PI_GOAL_AUTO_CONFIRM;
	if (autoConfirmEnv === "0") {
		// Explicit opt-out (benchmarking): in headless mode the proposal is
		// declined without a dialog.
		if (!ctx.hasUI) return { decision: "cancel" };
	} else if (!ctx.hasUI || autoConfirmEnv === "1") {
		// Headless default, or forced auto-confirm even with a UI.
		return { decision: "confirm" };
	}
	const rendered = await showTaskListConfirmationDialog(ctx, proposalText);
	if (rendered !== undefined) return rendered;
	// `ctx.hasUI` reports that a UI context is installed, not that it can render
	// a TUI component: a host driving pi from a browser keeps `hasUI` true while
	// `ui.custom` stays the SDK's headless default and resolves to undefined.
	// The same host implements confirm/select/input, so the decision is asked
	// there instead of being dereferenced off undefined.
	return await confirmTaskListWithBasicDialogs(ctx, proposalText);
}

async function confirmTaskListWithBasicDialogs(ctx: ExtensionContext, proposalText: string): Promise<TaskConfirmationResult> {
	if (typeof ctx.ui.select !== "function") return { decision: "cancel" };
	const picked = await ctx.ui.select(`${TASK_CONFIRMATION_TITLE}\n\n${proposalText}`, TASK_CONFIRMATION_OPTIONS.map((option) => option.label));
	return { decision: TASK_CONFIRMATION_OPTIONS.find((option) => option.label === picked)?.value ?? "cancel" };
}

async function showTaskListConfirmationDialog(ctx: ExtensionContext, proposalText: string): Promise<TaskConfirmationResult | undefined> {
	return await ctx.ui.custom<TaskConfirmationResult | undefined>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: (result: TaskConfirmationResult) => void): Component => {
			const wasHardwareCursorShown = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(false);
			// Pause pi's working spinner for the dialog duration: its ~80ms re-renders
			// write output that snaps a scrolled-up user back to the terminal bottom.
			ctx.ui.setWorkingVisible(false);

			// Default: "Confirm task list" (matches the pre-existing default).
			let selectedIndex = 0;

			const OPTIONS = TASK_CONFIRMATION_OPTIONS;

			const BODY_LINES = proposalText.split("\n");
			const MAX_BODY = 16;

			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);

			// ── Component ────────────────────────────────────────────────────
			const component: Component & { dispose?(): void } = {
				dispose() {
					tui.setShowHardwareCursor(wasHardwareCursorShown);
					ctx.ui.setWorkingVisible(true);
				},

				invalidate(): void {
					// No cached state to invalidate
				},

				render(width: number): string[] {
					const termWidth = Math.min(width, 80);
					const innerWidth = dialogInnerWidth(termWidth);

					const line = (leftContent: string): string => borderedLine(accent, innerWidth, leftContent);

					const horizLine = horizontalRule(innerWidth);
					const lines: string[] = [];
					const p = "  ";

					// ── Header ────────────────────────────────────────────────
					lines.push(accent(`┌${horizLine}┐`));
					lines.push(line(p + theme.bold(TASK_CONFIRMATION_TITLE)));
					lines.push(accent(`├${horizLine}┤`));

					// ── Body: the proposed task tree ─────────────────────────
					const body = BODY_LINES.slice(0, MAX_BODY);
					for (const raw of body) {
						const trimmed = raw;
						lines.push(line(p + truncateToWidth(muted(trimmed || " "), innerWidth - p.length, "…")));
					}
					if (BODY_LINES.length > MAX_BODY) {
						lines.push(line(p + dim(`+${BODY_LINES.length - MAX_BODY} more lines`)));
					}
					lines.push(accent(`├${horizLine}┤`));

					// ── Options ─────────────────────────────────────────────
					OPTIONS.forEach((opt, i) => {
						const isSelected = i === selectedIndex;
						const marker = isSelected ? "▸ " : "  ";
						const label = isSelected ? theme.fg("accent", opt.label) : opt.label;
						lines.push(line(p + marker + truncateToWidth(label, innerWidth - 6, "…")));
						if (isSelected) {
							lines.push(line(p + " ".repeat(4) + truncateToWidth(dim(opt.description), innerWidth - 10, "…")));
						}
					});

					// ── Footer ───────────────────────────────────────────────
					lines.push(accent(`├${horizLine}┤`));
					lines.push(line(p + dim("Enter to select  ·  ↑↓ to navigate  ·  Esc = keep current tasks")));
					lines.push(accent(`└${horizLine}┘`));

					return lines;
				},

				handleInput(data: string): void {
					if (matchesKey(data, "up")) {
						selectedIndex = (selectedIndex - 1 + OPTIONS.length) % OPTIONS.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down")) {
						selectedIndex = (selectedIndex + 1) % OPTIONS.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						done({ decision: OPTIONS[selectedIndex]!.value });
						return;
					}
					if (matchesKey(data, "escape")) {
						done({ decision: "cancel" });
						return;
					}
				},
			};

			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "70%",
				minWidth: 50,
				maxHeight: "60%",
			},
		},
	);
}
