/**
 * A rebuilt runtime must not send a checkpoint the previous one already sent.
 *
 * The dedup markers (`continuationQueuedFor` / `continuationScheduledFor`) live
 * on the GoalRuntime instance, and on this host that instance is rebuilt
 * between checkpoints — proved live by five consecutive checkpoints carrying
 * the same goal revision (378) *and* the same `checkpointSeq` of 1, a counter
 * that only ever increments. After a rebuild `continuationPendingFor()` answers
 * false about a continuation that is genuinely still in flight, so a second one
 * is queued for the same goal and the turn is paid for twice.
 *
 * The fix reads the same durable record the other two guards already read: a
 * checkpoint the loop wrote is on the branch, so "did I already ask for this
 * step" is answerable without trusting instance memory.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GoalRuntime,
	latestCheckpointForGoal,
	trailingCheckpointWithoutTurn,
} from "../extensions/goal-runtime.ts";
import { createGoal } from "../extensions/goal-record.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** What the goal loop writes when it asks the agent for the next step. */
function checkpoint(goalId = "g1", checkpointSeq = 1): unknown {
	return {
		type: "custom_message",
		customType: "pi-goal-event",
		content: `<pi_goal_continuation goal_id="${goalId}" kind="checkpoint" v="2"/>`,
		details: { version: 2, kind: "checkpoint", goalId, revision: 378, checkpointSeq },
	};
}

/** The agent answering the checkpoint: the step was taken. */
function assistantTurn(): unknown {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } };
}

function userTurn(): unknown {
	return { type: "message", message: { role: "user", content: "carry on" } };
}

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

describe("latestCheckpointForGoal", () => {
	it("finds the newest checkpoint this goal wrote", () => {
		const branch = [checkpoint("g1", 1), assistantTurn(), checkpoint("g1", 2)];

		assert.equal(latestCheckpointForGoal(branch, "g1")?.checkpointSeq, 2);
	});

	it("ignores checkpoints belonging to another goal", () => {
		const branch = [checkpoint("g1", 7), checkpoint("other", 9)];

		assert.equal(latestCheckpointForGoal(branch, "g1")?.checkpointSeq, 7);
	});

	it("reports nothing when the goal has never checkpointed", () => {
		assert.equal(latestCheckpointForGoal([assistantTurn()], "g1"), undefined);
		assert.equal(latestCheckpointForGoal([], "g1"), undefined);
	});
});

describe("trailingCheckpointWithoutTurn", () => {
	/**
	 * The shape of an unanswered ask: the loop wrote a checkpoint and nothing
	 * has spoken since. Asking again is asking twice for one step.
	 */
	it("sees a checkpoint that nothing has answered yet", () => {
		assert.equal(trailingCheckpointWithoutTurn([assistantTurn(), checkpoint()], "g1"), true);
	});

	it("sees the answer once a turn follows the checkpoint", () => {
		assert.equal(trailingCheckpointWithoutTurn([checkpoint(), assistantTurn()], "g1"), false);
	});

	it("treats a person speaking as an answer too", () => {
		assert.equal(trailingCheckpointWithoutTurn([checkpoint(), userTurn()], "g1"), false);
	});

	it("says nothing is outstanding when no checkpoint was written", () => {
		assert.equal(trailingCheckpointWithoutTurn([assistantTurn()], "g1"), false);
	});

	/**
	 * A checkpoint for a different goal is not this goal's outstanding ask;
	 * blocking on it would stall a goal that never asked for anything.
	 */
	it("ignores an unanswered checkpoint belonging to another goal", () => {
		assert.equal(trailingCheckpointWithoutTurn([assistantTurn(), checkpoint("other")], "g1"), false);
	});
});

describe("a continuation that is already in flight", () => {
	/**
	 * The regression, stated as the cost: two runtimes, one outstanding ask,
	 * and the branch says so. Before the branch was consulted this sent twice.
	 */
	it("is not sent again by a runtime that was rebuilt underneath it", () => {
		const goal = activeGoal();
		const sent: string[] = [];
		const branch: unknown[] = [];

		runtimeSending(sent, goal).flushContinuationForTest(ctxWithBranch(branch), goal.id);
		assert.equal(sent.length, 1);
		// The first runtime's checkpoint reached the transcript; the instance
		// that knew about it is gone.
		branch.push(checkpoint());

		runtimeSending(sent, goal).flushContinuationForTest(ctxWithBranch(branch), goal.id);

		assert.equal(sent.length, 1);
	});

	it("is sent again once the agent has answered the first one", () => {
		const goal = activeGoal();
		const sent: string[] = [];
		const branch: unknown[] = [checkpoint(), assistantTurn()];

		runtimeSending(sent, goal).flushContinuationForTest(ctxWithBranch(branch), goal.id);

		assert.equal(sent.length, 1);
	});

	/**
	 * The in-memory marker still has to work on a host that hands over no
	 * branch, or the dedup would be lost entirely where it used to exist.
	 */
	it("still dedups within one runtime when no branch is available", () => {
		const goal = activeGoal();
		const sent: string[] = [];
		const ctx = { cwd: "/tmp", isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
		const runtime = runtimeSending(sent, goal);

		runtime.flushContinuationForTest(ctx, goal.id);
		runtime.queueContinuation(ctx, goal);

		assert.equal(runtime.continuationPendingFor(goal.id), true);
		assert.equal(sent.length, 1);
	});

	/**
	 * The parked dedup assumes the request's owner is alive. A daemon restart
	 * breaks that assumption: the trailing checkpoint belongs to a dead
	 * process, the turn it waits for can never arrive, and the parked marker
	 * has no timer — the goal idles forever with nothing running. The one
	 * moment a rebuilt runtime can be certain of this is session start, so the
	 * restart re-arm re-sends across the stale checkpoint.
	 */
	it("re-sends across a stale trailing checkpoint when re-armed after a restart", async () => {
		const goal = activeGoal();
		const sent: string[] = [];
		const branch = [checkpoint()];
		const runtime = runtimeSending(sent, goal);

		runtime.rearmAfterRestart(ctxWithBranch(branch), goal);
		// rearmAfterRestart schedules through a (0ms idle) timer; let it fire.
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(sent.length, 1);
		assert.equal(runtime.continuationPendingFor(goal.id), true);
	});

	/** The restart re-arm keeps every other guard: an idle goal is not sent. */
	it("does not re-arm an inactive goal after a restart", () => {
		const goal = { ...activeGoal(), status: "paused" as const };
		const sent: string[] = [];
		const runtime = runtimeSending(sent, goal);

		runtime.rearmAfterRestart(ctxWithBranch([]), goal);

		assert.equal(sent.length, 0);
		assert.equal(runtime.continuationPendingFor(goal.id), false);
	});
});
