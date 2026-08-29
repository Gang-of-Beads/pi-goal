import test from "node:test";
import assert from "node:assert/strict";

import { PI_WEB_ASK_ANSWERS_CUSTOM_TYPE, trailingAskWithoutAnswer } from "../extensions/goal-runtime.ts";

// ── On-disk entry shapes, transcribed from a live pi-web session ────────────
// (2026-08-28T06-15-06-103Z_01a04701-….jsonl: the ask_user call at index 2674,
// its "Posted … Ending this run" toolResult at 2675, the goal's own checkpoint
// custom_messages pumping at ~3s cadence from 2676, and the human's outcome
// landing later as a `pi-web.ask.answers` custom_message).

function askToolCall(): Record<string, unknown> {
	return {
		type: "message",
		id: "m-call",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "ask the owner" },
				{ type: "toolCall", id: "toolu_1", name: "ask_user", arguments: { questions: [{ id: "q1", question: "Q?" }] } },
			],
		},
	};
}

/** pi-web's ask tool result: posted, run ended, answers arrive as a follow-up. */
function askPostedResult(): Record<string, unknown> {
	return {
		type: "message",
		id: "m-result",
		message: {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "ask_user",
			content: [{ type: "text", text: "Posted 1 question to the user as ask ask-1. Ending this run; the answers arrive as a follow-up message that wakes you, naming every question the user left unanswered. Do not repost these questions." }],
			details: { ask: { askId: "ask-1", askedAt: "2026-08-29T19:23:33.131Z", questions: [{ id: "q1", question: "Q?" }] } },
		},
	};
}

/** A blocking ask tool result: the outcome IS the result, no daemon-owned shape. */
function completedBlockingAskResult(): Record<string, unknown> {
	return {
		type: "message",
		id: "m-result",
		message: {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "ask_user",
			content: [{ type: "text", text: "selected: option-a" }],
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
	return {
		type: "custom_message",
		customType: PI_WEB_ASK_ANSWERS_CUSTOM_TYPE,
		content: "The user submitted answers to your questions.",
		display: true,
		details,
	};
}

test("a posted ask whose outcome has not landed reads as pending", () => {
	assert.equal(trailingAskWithoutAnswer([askToolCall(), askPostedResult()]), true);
});

test("the goal's own continuation entries after the ask are not an answer", () => {
	// The live failure: each injected checkpoint made the agent reply "paused,
	// not advancing", and those replies are `message` entries — a scan that
	// treats any message as "the turn was taken" releases the ask and pumps again.
	const pump = [goalCheckpoint(), assistantReply("Goal paused — not advancing."), goalCheckpoint(), assistantReply("等待你的答复。")];
	assert.equal(trailingAskWithoutAnswer([askToolCall(), askPostedResult(), ...pump]), true);
});

test("the human's answer — the pi-web ask-answers entry — clears the pending ask", () => {
	const branch = [askToolCall(), askPostedResult(), goalCheckpoint(), assistantReply("paused"), askOutcome({ askId: "ask-1", reason: "answered" })];
	assert.equal(trailingAskWithoutAnswer(branch), false);
});

test("a dismissed ask is an outcome too: pi-web writes the same entry on cancel", () => {
	const branch = [askToolCall(), askPostedResult(), askOutcome({ askId: "ask-1", reason: "cancelled" })];
	assert.equal(trailingAskWithoutAnswer(branch), false);
});

test("a completed blocking ask — a toolResult without the daemon-owned ask shape — is not pending", () => {
	// In a host where the ask tool blocks until answered, the result landing
	// means the human already answered. Requiring the `details.ask` shape is
	// what keeps this predicate honest about which host it is reading.
	const branch = [askToolCall(), completedBlockingAskResult(), assistantReply("carried on")];
	assert.equal(trailingAskWithoutAnswer(branch), false);
});

test("an ask superseded by a newer pending ask stays pending", () => {
	const branch = [askToolCall(), askPostedResult(), askOutcome({ askId: "ask-1", reason: "answered" }), askToolCall(), askPostedResult()];
	assert.equal(trailingAskWithoutAnswer(branch), true);
});

test("ordinary tool traffic between the ask and now does not answer it", () => {
	const bashResult = { type: "message", id: "m-bash", message: { role: "toolResult", toolCallId: "toolu_2", toolName: "bash", content: [{ type: "text", text: "ok" }] } };
	const branch = [askToolCall(), askPostedResult(), goalCheckpoint(), bashResult, assistantReply("ran a probe")];
	assert.equal(trailingAskWithoutAnswer(branch), true);
});
