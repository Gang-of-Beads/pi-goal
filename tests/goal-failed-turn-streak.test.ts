/**
 * Auto-continue must stop driving a goal whose turns keep dying.
 *
 * Taken from a real session. Five checkpoints in a row were written carrying
 * the same goal revision (378) *and* the same `checkpointSeq` (1) — a sequence
 * that only increments, so seeing 1 five times proves the runtime holding the
 * counter was rebuilt between every one of them. The in-memory stall guard
 * therefore reset each time and could never fire, and one
 * `400 invalid_request_error` — which the model layer deliberately refuses to
 * retry, because the same bytes get the same answer — was re-sent by the goal
 * loop seven times.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GoalRuntime,
	MAX_CONSECUTIVE_MODEL_ERRORS,
	trailingModelErrorCount,
} from "../extensions/goal-runtime.ts";
import { createGoal } from "../extensions/goal-record.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAILURE =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.27.content.356: `thinking` blocks in the latest assistant message cannot be modified."}}';

function failedTurn(): unknown {
	return { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: FAILURE } };
}

function goodTurn(): unknown {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
}

/** What the goal loop writes between turns: hidden, and not a message entry. */
function checkpoint(revision = 378): unknown {
	return {
		type: "custom_message",
		customType: "pi-goal-event",
		content: '<pi_goal_continuation goal_id="g1" kind="checkpoint" v="2"/>',
		details: { version: 2, kind: "checkpoint", goalId: "g1", revision, checkpointSeq: 1 },
	};
}

describe("trailingModelErrorCount", () => {
	it("counts the failed turns at the end of the branch", () => {
		const branch = [goodTurn(), checkpoint(), failedTurn(), checkpoint(), failedTurn()];

		assert.equal(trailingModelErrorCount(branch), 2);
	});

	it("looks past the checkpoints written between the turns", () => {
		const branch = [checkpoint(), failedTurn(), checkpoint(), failedTurn(), checkpoint()];

		assert.equal(trailingModelErrorCount(branch), 2);
	});

	it("stops at a turn that worked", () => {
		const branch = [failedTurn(), failedTurn(), goodTurn()];

		assert.equal(trailingModelErrorCount(branch), 0);
	});

	it("stops at a person stepping in", () => {
		const branch = [failedTurn(), failedTurn(), { type: "message", message: { role: "user", content: "try again" } }];

		assert.equal(trailingModelErrorCount(branch), 0);
	});

	it("ignores entries that are not turns", () => {
		const branch = [failedTurn(), { type: "model_change" }, { type: "thinking_level_change" }];

		assert.equal(trailingModelErrorCount(branch), 1);
	});

	it("reports nothing for a branch it cannot read", () => {
		assert.equal(trailingModelErrorCount([]), 0);
		assert.equal(trailingModelErrorCount([null, "not an entry", 7]), 0);
	});
});

function activeGoal(): GoalRecord {
	const goal = createGoal({ objective: "keep going", autoContinue: true, sisyphus: false });
	return { ...goal, id: "g1", status: "active", autoContinue: true, revision: 378 };
}

function ctxWithBranch(branch: readonly unknown[]): ExtensionContext {
	return {
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
}

function runtimeSending(sent: string[], goal: GoalRecord): GoalRuntime {
	return new GoalRuntime({
		sendFollowUp: (content) => { sent.push(content); },
		getGoal: () => goal,
		isActionable: () => true,
	});
}

describe("driving a goal whose turns keep dying", () => {
	it("wakes the agent while the failures are still worth another try", () => {
		const goal = activeGoal();
		const sent: string[] = [];
		const runtime = runtimeSending(sent, goal);

		runtime.flushContinuationForTest(ctxWithBranch([checkpoint(), failedTurn()]), goal.id);

		assert.equal(sent.length, 1);
	});

	/**
	 * The guard this replaces counted on an instance that does not survive. A
	 * fresh runtime for every checkpoint is exactly the case that produced the
	 * seven-in-a-row burst, so each attempt here gets one.
	 */
	it("stops once the same wall has been hit twice, however often it is rebuilt", () => {
		const goal = activeGoal();
		const branch: unknown[] = [];
		const sent: string[] = [];

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const before = sent.length;
			runtimeSending(sent, goal).flushContinuationForTest(ctxWithBranch(branch), goal.id);
			if (sent.length > before) branch.push(checkpoint());
			branch.push(failedTurn());
		}

		assert.equal(sent.length, MAX_CONSECUTIVE_MODEL_ERRORS);
		assert.equal(trailingModelErrorCount(branch) >= MAX_CONSECUTIVE_MODEL_ERRORS, true);
	});

	it("drives again after a turn that worked", () => {
		const goal = activeGoal();
		const sent: string[] = [];
		const dead = [checkpoint(), failedTurn(), checkpoint(), failedTurn()];

		runtimeSending(sent, goal).flushContinuationForTest(ctxWithBranch(dead), goal.id);
		assert.equal(sent.length, 0);

		runtimeSending(sent, goal).flushContinuationForTest(ctxWithBranch([...dead, goodTurn()]), goal.id);
		assert.equal(sent.length, 1);
	});
});
