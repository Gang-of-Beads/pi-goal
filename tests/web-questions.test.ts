import assert from "node:assert/strict";
import test from "node:test";

import { formatQuestionnaireAnswers, runGoalQuestionnaire, showProposalDialog } from "../extensions/goal-questionnaire.ts";
import { showTaskConfirmation } from "../extensions/goal-task-confirmation.ts";
import { fitsQuestionsCard } from "../extensions/web-questions.ts";

/**
 * pi-web draws a declared screen as its Questions card and never mounts the
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
			piWebScreens: ["questions"],
			custom: async (_factory: unknown, options?: { web?: unknown }) => { declared.push(options?.web); return answer; },
			select: async (title: string) => { fallbacks.push(title); return undefined; },
			input: async (title: string) => { fallbacks.push(title); return undefined; },
		},
	} as unknown as Parameters<typeof runGoalQuestionnaire>[0];
	return { ctx, declared, fallbacks };
}

test("the questionnaire declares its questions, options keyed by index", async () => {
	const { ctx, declared } = piWebUi({ answers: [] });
	await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"], recommended: 1 }]);
	assert.deepEqual(declared[0], {
		kind: "questions",
		title: "Scope?",
		questions: [{ id: "scope", question: "Scope?", detail: "Pick one", options: [{ value: "0", label: "A" }, { value: "1", label: "B", detail: "Recommended" }] }],
	});
});

test("the reader's answers come back as the terminal dialog's result", async () => {
	const { ctx } = piWebUi({ answers: [{ id: "scope", values: ["1"] }, { id: "notes", values: [], otherText: " my words " }] });
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
	const { ctx, declared } = piWebUi({ answers: [{ id: "confirm", values: ["0"] }, { id: "pi-goal.auditor", values: ["off"] }] });
	assert.deepEqual(await showProposalDialog(ctx, "OBJECTIVE", "goal", true), { decision: "confirm", auditorEnabled: false, unavailable: false });
	const questions = (declared[0] as { questions: Array<{ id: string; custom?: boolean }> }).questions;
	assert.deepEqual(questions.map((question) => [question.id, question.custom]), [["confirm", false], ["pi-goal.auditor", false]]);
});

test("an unanswered auditor question keeps its default", async () => {
	const { ctx } = piWebUi({ answers: [{ id: "confirm", values: ["0"] }] });
	assert.equal((await showProposalDialog(ctx, "OBJECTIVE", "goal", true)).auditorEnabled, true);
});

test("the task-list confirmation reads Confirm, and a closed card keeps the tasks", async () => {
	const previous = process.env.PI_GOAL_AUTO_CONFIRM;
	delete process.env.PI_GOAL_AUTO_CONFIRM;
	try {
		assert.deepEqual(await showTaskConfirmation(piWebUi({ answers: [{ id: "decision", values: ["confirm"] }] }).ctx, "[ ] t1"), { decision: "confirm" });
		const closed = piWebUi(undefined);
		assert.deepEqual(await showTaskConfirmation(closed.ctx, "[ ] t1"), { decision: "cancel" });
		assert.deepEqual(closed.fallbacks, []);
	} finally {
		if (previous !== undefined) process.env.PI_GOAL_AUTO_CONFIRM = previous;
	}
});

test("a host that does not list questions gets no declaration", async () => {
	const declared: unknown[] = [];
	const ctx = { hasUI: true, cwd: "/test", ui: { custom: async (_factory: unknown, options?: { web?: unknown }) => { declared.push(options?.web); return { questions: [], answers: [], cancelled: true }; } } } as unknown as Parameters<typeof runGoalQuestionnaire>[0];
	await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", options: ["A"] }]);
	assert.deepEqual(declared, [undefined]);
});

test("a question the reader skipped is reported as unanswered, not left out", async () => {
	const { ctx } = piWebUi({ answers: [{ id: "scope", values: ["0"] }] });
	const result = await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", options: ["A"] }, { id: "risk", question: "Risk?", options: ["low"] }]);
	assert.equal(result.cancelled, false);
	assert.match(formatQuestionnaireAnswers(result), /\*\*Q:\*\* Scope\?[\s\S]*\*\*A:\*\* A[\s\S]*\*\*Q:\*\* Risk\?[\s\S]*\*\*A:\*\* \(left unanswered\)/);
});

test("a declaration the card would refuse is not sent, so the terminal screen stands alone", async () => {
	const { ctx, declared } = piWebUi(undefined);
	await runGoalQuestionnaire(ctx, [{ id: "scope", question: "Scope?", context: "x".repeat(32_001), options: ["A"] }]);
	assert.deepEqual(declared, [undefined]);
});

test("blank context is no detail, and a text-only question keeps its text box", async () => {
	const { ctx, declared } = piWebUi({ answers: [] });
	await runGoalQuestionnaire(ctx, [{ id: "notes", question: "Notes?", context: "   ", options: [], allowCustom: false }]);
	assert.deepEqual((declared[0] as { questions: unknown[] }).questions, [{ id: "notes", question: "Notes?", options: [] }]);
});

test("a large draft proposal still declares, and duplicate ids never do", async () => {
	const { ctx, declared } = piWebUi({ answers: [] });
	await showProposalDialog(ctx, "x".repeat(20_000), "goal", true);
	assert.equal((declared[0] as { kind: string }).kind, "questions");
	const q = { id: "a", question: "A?", options: [{ value: "0", label: "zero" }] };
	assert.equal(fitsQuestionsCard([q, q]), false);
	assert.equal(fitsQuestionsCard([{ ...q, options: [{ value: "0", label: "zero" }, { value: "0", label: "again" }] }]), false);
});
