import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { GoalRuntime, MAX_BACKGROUND_DEFERRAL_MS } from "../extensions/goal-runtime.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";

// WHY these exist: while an ask_user card waited for the owner in pi-web, the
// goal injected checkpoints every ~3 seconds (2676→2688 in the live session
// file), each one shoving the card down the page until the owner could not tap
// his own options. An unanswered question is not quiescence; these tests pin
// the hold, the release, and the bounded fallback.

function activeGoal(): GoalRecord {
	const goal = createGoal({ objective: "keep going", autoContinue: true, sisyphus: false });
	return { ...goal, id: "g1", status: "active", autoContinue: true, revision: 378 };
}

function ctxWithBranch(branch: readonly unknown[], extra: Record<string, unknown> = {}): ExtensionContext {
	return {
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => branch },
		...extra,
	} as unknown as ExtensionContext;
}

function runtimeWithoutProbe(sent: string[], goal: GoalRecord): GoalRuntime {
	return new GoalRuntime({
		sendFollowUp: (content) => {
			sent.push(content);
		},
		getGoal: () => goal,
		isActionable: () => true,
	});
}

// ── On-disk shapes (transcribed from the live pi-web session) ───────────────

function askToolCall(): Record<string, unknown> {
	return {
		type: "message",
		id: "m-call",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_1", name: "ask_user", arguments: { questions: [{ id: "q1", question: "Q?" }] } }],
		},
	};
}

function askPostedResult(): Record<string, unknown> {
	return {
		type: "message",
		id: "m-result",
		message: {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "ask_user",
			content: [{ type: "text", text: "Posted 1 question to the user as ask ask-1. Ending this run; the answers arrive as a follow-up message that wakes you." }],
			details: { ask: { askId: "ask-1", askedAt: "2026-08-29T19:23:33.131Z", questions: [{ id: "q1", question: "Q?" }] } },
		},
	};
}

function goalCheckpoint(): Record<string, unknown> {
	return {
		type: "custom_message",
		customType: "pi-goal-event",
		content: '<pi_goal_continuation goal_id="g1" kind="checkpoint" v="2" status="active"/>',
		display: false,
		details: { version: 2, kind: "checkpoint", goalId: "g1", status: "active", revision: 1, checkpointSeq: 9, timestamp: Date.now() },
	};
}

function assistantReply(text: string): Record<string, unknown> {
	return { type: "message", id: `m-${text.slice(0, 8)}`, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function askOutcome(details: Record<string, unknown>): Record<string, unknown> {
	return { type: "custom_message", customType: "pi-web.ask.answers", content: "The user submitted answers to your questions.", display: true, details };
}

test("the follow-up holds while a question waits for the human", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const runtime = runtimeWithoutProbe(sent, goal);
	const ctx = ctxWithBranch([askToolCall(), askPostedResult()]);

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 0, "must not inject while the owner's question card is up");
	assert.equal(
		runtime.continuationPendingFor(goal.id),
		true,
		"the held continuation stays queued so the ordinary dedup still applies",
	);
	runtime.cancelContinuationFor(goal.id);
});

test("the pump that pushed the owner's card around is dead: goal traffic between ask and now releases nothing", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const runtime = runtimeWithoutProbe(sent, goal);
	// The live failure shape: checkpoint → agent reply → checkpoint → reply,
	// all while the question waited. Each reply is a `message` entry, which is
	// exactly what trailingCheckpointWithoutTurn reads as "the turn was taken".
	const ctx = ctxWithBranch([askToolCall(), askPostedResult(), goalCheckpoint(), assistantReply("Goal paused — not advancing."), goalCheckpoint(), assistantReply("等待你的答复。")]);

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 0, "the goal's own entries must not answer the human's question for him");
	runtime.cancelContinuationFor(goal.id);
});

test("the human's answer releases the held follow-up", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const runtime = runtimeWithoutProbe(sent, goal);
	const ctx = ctxWithBranch([askToolCall(), askPostedResult(), goalCheckpoint(), assistantReply("paused"), askOutcome({ askId: "ask-1", reason: "answered" })]);

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 1, "once the question is answered the goal must proceed without another trigger");
});

test("a question that outlasts the bounded fallback releases the goal, out loud", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const notifications: string[] = [];
	const runtime = runtimeWithoutProbe(sent, goal);
	const ctx = ctxWithBranch([askToolCall(), askPostedResult()], {
		ui: { notify: (message: string) => notifications.push(message) },
	});

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 0);
	runtime.cancelContinuationFor(goal.id);

	// White-box: pretend the current hold started before the cap.
	(runtime as unknown as { busyDeferralSince: number | null }).busyDeferralSince = Date.now() - MAX_BACKGROUND_DEFERRAL_MS - 1;

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 1, "a lost human must not stall the goal forever — same fallback as background work");
	assert.equal(notifications.length, 1, "the fallback must be visible, not silent");
});

test("held polls do not consume the stalled-checkpoint budget", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const runtime = runtimeWithoutProbe(sent, goal);
	const ctx = ctxWithBranch([askToolCall(), askPostedResult()]);

	for (let attempt = 0; attempt < 5; attempt += 1) {
		await runtime.flushContinuationForTest(ctx, goal.id);
		runtime.cancelContinuationFor(goal.id);
	}
	assert.equal(sent.length, 0, "waiting for a human is not the goal stalling");

	const answered = ctxWithBranch([askToolCall(), askPostedResult(), askOutcome({ askId: "ask-1", reason: "answered" })]);
	await runtime.flushContinuationForTest(answered, goal.id);
	assert.equal(sent.length, 1, "after the answer the continuation must still fire");
});
