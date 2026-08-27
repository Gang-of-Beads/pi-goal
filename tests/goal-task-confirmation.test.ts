import assert from "node:assert/strict";
import test from "node:test";

import { showTaskConfirmation, TASK_CONFIRMATION_OPTIONS } from "../extensions/goal-task-confirmation.ts";

type Ctx = Parameters<typeof showTaskConfirmation>[0];

function nonTerminalUiContext(): Ctx {
	return { hasUI: true, cwd: "/test", ui: { custom: async () => undefined } } as unknown as Ctx;
}

function browserLikeUiContext(pick: string | undefined) {
	const prompts: string[] = [];
	const offered: string[][] = [];
	const ctx = {
		hasUI: true,
		cwd: "/test",
		ui: {
			custom: async () => undefined,
			select: async (title: string, options: string[]) => {
				prompts.push(title);
				offered.push(options);
				return pick;
			},
			input: async () => undefined,
		},
	} as unknown as Ctx;
	return { ctx, prompts, offered };
}

test("a host without ui.custom confirms the task list through plain select", async () => {
	const { ctx, prompts, offered } = browserLikeUiContext(TASK_CONFIRMATION_OPTIONS[0]!.label);
	const result = await showTaskConfirmation(ctx, "[ ] task-1: Reproduce first");
	assert.deepEqual(result, { decision: "confirm" });
	assert.match(prompts[0] ?? "", /Task list confirmation[\s\S]*task-1: Reproduce first/);
	assert.deepEqual(offered[0], TASK_CONFIRMATION_OPTIONS.map((option) => option.label));
});

test("keeping the current tasks on such a host is a cancel, not a crash", async () => {
	const { ctx } = browserLikeUiContext(TASK_CONFIRMATION_OPTIONS[1]!.label);
	assert.deepEqual(await showTaskConfirmation(ctx, "[ ] task-1: One"), { decision: "cancel" });
});

test("a dismissed select keeps the current task list", async () => {
	const { ctx } = browserLikeUiContext(undefined);
	assert.deepEqual(await showTaskConfirmation(ctx, "[ ] task-1: One"), { decision: "cancel" });
});

test("a host with no dialogs at all keeps the current task list instead of dereferencing undefined", async () => {
	assert.deepEqual(await showTaskConfirmation(nonTerminalUiContext(), "[ ] task-1: One"), { decision: "cancel" });
});
