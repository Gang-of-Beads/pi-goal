import assert from "node:assert/strict";
import test from "node:test";

import { formatQuestionnaireAnswers, runGoalQuestionnaire, showProposalDialog } from "../extensions/goal-questionnaire.ts";
import { showTaskConfirmation } from "../extensions/goal-task-confirmation.ts";
import { fitsQuestionsCard } from "../extensions/web-questions.ts";

/**
 * pi-web draws a declared screen as its interactive card and never mounts the
 * terminal component. The owner had to close a terminal dump before these
 * dialogs appeared natively; each test here pins one half of "shown once".
 */
function piWebUi(answer: unknown) {
	const declared: unknown[] = [];
	const fallbacks: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: "/test",
		ui: {
			piWebScreens: ["card"],
			custom: async (_factory: unknown, options?: { web?: unknown }) => { declared.push(options?.web); return answer; },
			select: async (title: string) => { fallbacks.push(title); return undefined; },
			input: async (title: string) => { fallbacks.push(title); return undefined; },
		},
	} as unknown as Parameters<typeof runGoalQuestionnaire>[0];
	return { ctx, declared, fallbacks };
}

test("the questionnaire declares its questions, options keyed by index", async () => {
	const { ctx, declared } = piWebUi({ values: {} });
	await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"], recommended: 1 }]);
	assert.deepEqual(declared[0], {
		kind: "card",
		title: "Scope?",
		fields: [{ type: "choice", id: "scope", label: "Scope?", detail: "Pick one", options: [{ value: "0", label: "A" }, { value: "1", label: "B", detail: "Recommended" }], other: "choice" }],
	});
});

test("the reader's answers come back as the terminal dialog's result", async () => {
	const { ctx } = piWebUi({ values: { scope: { selected: ["1"] }, notes: { selected: [], other: " my words " } } });
	const result = await runGoalQuestionnaire(ctx, [
		{ id: "scope", question: "Scope?", options: ["A", "B"] },
		{ id: "notes", question: "Notes?", options: ["x"] },
		{ id: "skipped", question: "Skipped?", options: ["y"] },
	]);
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers, [
		{ id: "scope", question: "Scope?", answer: "B", wasCustom: false },
		{ id: "notes", question: "Notes?", answer: "my words", wasCustom: true },
	]);
});

test("a card closed unanswered cancels instead of asking again through select", async () => {
	const { ctx, fallbacks } = piWebUi(undefined);
	const result = await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", options: ["A"] }]);
	assert.equal(result.cancelled, true);
	assert.deepEqual(fallbacks, []);
});

test("the draft confirmation is one question plus the auditor, and both are read back", async () => {
	const { ctx, declared } = piWebUi({ values: { confirm: { selected: ["0"] }, "pi-goal.auditor": { selected: ["off"] } } });
	assert.deepEqual(await showProposalDialog(ctx, "OBJECTIVE", "goal", true), { decision: "confirm", auditorEnabled: false, unavailable: false });
	const fields = (declared[0] as { fields: Array<{ id: string; other?: string }> }).fields;
	assert.deepEqual(fields.map((field) => [field.id, field.other]), [["confirm", undefined], ["pi-goal.auditor", undefined]]);
});

test("an unanswered auditor question keeps its default", async () => {
	const { ctx } = piWebUi({ values: { confirm: { selected: ["0"] } } });
	assert.equal((await showProposalDialog(ctx, "OBJECTIVE", "goal", true)).auditorEnabled, true);
});

test("the task-list confirmation reads Confirm, and a closed card keeps the tasks", async () => {
	const previous = process.env.PI_GOAL_AUTO_CONFIRM;
	delete process.env.PI_GOAL_AUTO_CONFIRM;
	try {
		assert.deepEqual(await showTaskConfirmation(piWebUi({ values: { decision: { selected: ["confirm"] } } }).ctx, "[ ] t1"), { decision: "confirm" });
		const closed = piWebUi(undefined);
		assert.deepEqual(await showTaskConfirmation(closed.ctx, "[ ] t1"), { decision: "cancel" });
		assert.deepEqual(closed.fallbacks, []);
	} finally {
		if (previous !== undefined) process.env.PI_GOAL_AUTO_CONFIRM = previous;
	}
});

test("a host that does not list the card gets no declaration", async () => {
	const declared: unknown[] = [];
	const ctx = { hasUI: true, cwd: "/test", ui: { custom: async (_factory: unknown, options?: { web?: unknown }) => { declared.push(options?.web); return { questions: [], answers: [], cancelled: true }; } } } as unknown as Parameters<typeof runGoalQuestionnaire>[0];
	await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", options: ["A"] }]);
	assert.deepEqual(declared, [undefined]);
});

test("a question the reader skipped is reported as unanswered, not left out", async () => {
	const { ctx } = piWebUi({ values: { scope: { selected: ["0"] } } });
	const result = await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", options: ["A"] }, { id: "risk", question: "Risk?", options: ["low"] }]);
	assert.equal(result.cancelled, false);
	assert.match(formatQuestionnaireAnswers(result), /\*\*Q:\*\* Scope\?[\s\S]*\*\*A:\*\* A[\s\S]*\*\*Q:\*\* Risk\?[\s\S]*\*\*A:\*\* \(left unanswered\)/);
});

test("a host that draws the card never gets the terminal screen: long text is fitted, too many options is not shown", async () => {
	const { ctx, declared } = piWebUi(undefined);
	await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", context: "x".repeat(32_001), options: ["A"] }]);
	const detail = (declared[0] as { fields: Array<{ detail: string }> }).fields[0]!.detail;
	assert.equal(detail.length, 32_000);
	assert.ok(detail.endsWith("…"));
	const crowded = piWebUi(undefined);
	await assert.rejects(
		runGoalQuestionnaire(crowded.ctx, [{ id: "pick", question: "Pick?", options: Array.from({ length: 13 }, (_, index) => `option ${index}`) }]),
		/not shown: "Pick\?" has 13 options/,
	);
	assert.deepEqual(crowded.declared, []);
});

test("blank context is no detail, and a text-only question keeps its text box", async () => {
	const { ctx, declared } = piWebUi({ values: {} });
	await runGoalQuestionnaire(ctx, [{ id: "notes", question: "Notes?", context: "   ", options: [], allowCustom: false }]);
	assert.deepEqual((declared[0] as { fields: unknown[] }).fields, [{ type: "input", id: "notes", label: "Notes?", multiline: true }]);
});

test("a large draft proposal still declares, and duplicate ids never do", async () => {
	const { ctx, declared } = piWebUi({ values: {} });
	await showProposalDialog(ctx, "x".repeat(20_000), "goal", true);
	assert.equal((declared[0] as { kind: string }).kind, "card");
	const q = { id: "a", question: "A?", options: [{ value: "0", label: "zero" }] };
	assert.equal(fitsQuestionsCard([q, q]), false);
	assert.equal(fitsQuestionsCard([{ ...q, options: [{ value: "0", label: "zero" }, { value: "0", label: "again" }] }]), false);
});
