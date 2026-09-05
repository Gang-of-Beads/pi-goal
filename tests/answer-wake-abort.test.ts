import test from "node:test";
import assert from "node:assert/strict";

import { abortPauseDecision } from "../extensions/goal-runtime.ts";

// WHY these exist: pi-web's ask_user ends its run by design, the answers wake
// a fresh turn, and an abort landing on that fresh turn paused the goal with
// a stopReason "user" nobody chose (measured live: answers closed
// 07:09:33.800Z, POST /abort landed 07:09:35.497Z, goal_paused 07:09:35Z).
// The wake window is the newest custom entry being the answers delivery; the
// decision must name every state so an unhandled one fails here, not live.

function askAnswers(): Record<string, unknown> {
	return {
		type: "custom_message",
		customType: "pi-web.ask.answers",
		content: "The user submitted answers to your questions.",
		display: true,
		details: { askId: "ask-1", reason: "submitted" },
	};
}

function goalCheckpoint(): Record<string, unknown> {
	return {
		type: "custom_message",
		customType: "pi-goal-event",
		content: '<pi_goal_continuation goal_id="g1" kind="checkpoint" v="2" status="active"/>',
		display: false,
		details: { version: 2, kind: "checkpoint", goalId: "g1", status: "active", revision: 1, checkpointSeq: 9, timestamp: 0 },
	};
}

function assistantReply(text: string): Record<string, unknown> {
	return { type: "message", id: `m-${text.slice(0, 8)}`, message: { role: "assistant", content: [{ type: "text", text }] } };
}

test("answers as the newest custom entry are the wake window", () => {
	assert.equal(abortPauseDecision([goalCheckpoint(), assistantReply("worked"), askAnswers()]), "turn-stop-only");
});

test("ordinary messages after the answers do not close the window", () => {
	assert.equal(
		abortPauseDecision([goalCheckpoint(), askAnswers(), assistantReply("started the step"), assistantReply("still going")]),
		"turn-stop-only",
	);
});

test("a checkpoint after the answers closes the window", () => {
	assert.equal(abortPauseDecision([askAnswers(), goalCheckpoint()]), "pause");
});

test("a branch with no custom entries pauses like before", () => {
	assert.equal(abortPauseDecision([assistantReply("no goal traffic")]), "pause");
	assert.equal(abortPauseDecision([]), "pause");
});

test("unrelated custom_message traffic is not the wake window", () => {
	const other = { type: "custom_message", customType: "pi-goal-event", content: "goal event", display: false, details: {} };
	assert.equal(abortPauseDecision([askAnswers(), other]), "pause");
});

test("custom (non custom_message) entries are skipped, not window-closing", () => {
	const focus = { type: "custom", customType: "pi-goal-focus" };
	assert.equal(abortPauseDecision([askAnswers(), focus]), "turn-stop-only");
});
