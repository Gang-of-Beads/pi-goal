/**
 * The bounded network-recovery ladder must stay bounded across runtime rebuilds.
 *
 * `networkErrorBackoffPlan` caps recovery at five attempts (5s/10s/20s/40s/80s),
 * but the attempt number was counted on the GoalRuntime instance, and that
 * instance is rebuilt between checkpoints on this host. Measured before the
 * fix with a fresh runtime per attempt: eight consecutive calls every one of
 * which returned a 5000ms delay, i.e. attempt #1 forever. An unavailable
 * provider was polled every five seconds without end and the ladder never
 * escalated or stopped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GoalRuntime,
	GUARD_STOP_REASONS,
	trailingNetworkErrorCount,
} from "../extensions/goal-runtime.ts";
import { NETWORK_ERROR_BACKOFF_DELAYS_MS } from "../extensions/network-error-backoff.ts";
import { createGoal } from "../extensions/goal-record.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The shape pi writes for a provider network failure. */
function networkErrorTurn(): unknown {
	return {
		type: "message",
		message: { role: "assistant", content: [], stopReason: "error", rawStopReason: "network_error" },
	};
}

/** A refusal that is not a network problem, so it must not feed this ladder. */
function invalidRequestTurn(): unknown {
	return {
		type: "message",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 invalid_request_error" },
	};
}

function goodTurn(): unknown {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
}

function checkpoint(): unknown {
	return {
		type: "custom_message",
		customType: "pi-goal-event",
		content: '<pi_goal_continuation goal_id="g1" kind="checkpoint" v="2"/>',
		details: { version: 2, kind: "checkpoint", goalId: "g1", revision: 1, checkpointSeq: 1 },
	};
}

describe("trailingNetworkErrorCount", () => {
	it("counts the network failures at the end of the branch", () => {
		assert.equal(trailingNetworkErrorCount([goodTurn(), networkErrorTurn(), networkErrorTurn()]), 2);
	});

	it("looks past the checkpoints written between the turns", () => {
		assert.equal(
			trailingNetworkErrorCount([checkpoint(), networkErrorTurn(), checkpoint(), networkErrorTurn(), checkpoint()]),
			2,
		);
	});

	it("stops at a turn that worked", () => {
		assert.equal(trailingNetworkErrorCount([networkErrorTurn(), networkErrorTurn(), goodTurn()]), 0);
	});

	/**
	 * The two guards read the same branch but must not feed each other: a 400
	 * the provider refused is not a transport problem and gets no backoff.
	 */
	it("does not count a refusal that was never a network problem", () => {
		assert.equal(trailingNetworkErrorCount([networkErrorTurn(), invalidRequestTurn()]), 0);
	});

	it("reports nothing for a branch it cannot read", () => {
		assert.equal(trailingNetworkErrorCount([]), 0);
		assert.equal(trailingNetworkErrorCount([null, "not an entry", 7]), 0);
	});
});

function activeGoal(): GoalRecord {
	const goal = createGoal({ objective: "keep going", autoContinue: true, sisyphus: false });
	return { ...goal, id: "g1", status: "active", autoContinue: true, revision: 1 };
}

function ctxWithBranch(branch: readonly unknown[]): ExtensionContext {
	return {
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
}

function runtimeFor(goal: GoalRecord, stopped: string[] = []): GoalRuntime {
	return new GoalRuntime({
		sendFollowUp: () => {},
		getGoal: () => goal,
		isActionable: () => true,
		onGuardStopped: (_ctx, reason) => { stopped.push(reason); },
	});
}

describe("recovering from a provider that keeps failing", () => {
	/**
	 * The regression. A fresh runtime per attempt is the documented host
	 * behaviour, and it used to restart the ladder at 5s every time.
	 */
	it("climbs the ladder even when the runtime is rebuilt between attempts", () => {
		const goal = activeGoal();
		const branch: unknown[] = [];
		const delays: number[] = [];

		for (let attempt = 0; attempt < NETWORK_ERROR_BACKOFF_DELAYS_MS.length; attempt += 1) {
			// The failure lands on the branch first, then recovery is scheduled.
			branch.push(networkErrorTurn());
			const plan = runtimeFor(goal).scheduleNetworkErrorRetry(ctxWithBranch(branch), goal);
			assert.ok(plan, `attempt ${String(attempt + 1)} should still be within the ladder`);
			delays.push(plan.delayMs);
			branch.push(checkpoint());
		}

		assert.deepEqual(delays, [...NETWORK_ERROR_BACKOFF_DELAYS_MS]);
	});

	it("gives up once the ladder is spent, however often it is rebuilt", () => {
		const goal = activeGoal();
		const branch: unknown[] = [];
		// One failure past the last rung: five is still recoverable, six is not.
		for (let i = 0; i < NETWORK_ERROR_BACKOFF_DELAYS_MS.length + 1; i += 1) branch.push(networkErrorTurn());

		const plan = runtimeFor(goal).scheduleNetworkErrorRetry(ctxWithBranch(branch), goal);

		assert.equal(plan, null);
	});

	it("starts again from the bottom after a turn that worked", () => {
		const goal = activeGoal();
		// Three failures, then a reply that landed, then one fresh failure.
		const recovered = [networkErrorTurn(), networkErrorTurn(), networkErrorTurn(), goodTurn(), networkErrorTurn()];

		const plan = runtimeFor(goal).scheduleNetworkErrorRetry(ctxWithBranch(recovered), goal);

		assert.equal(plan?.delayMs, NETWORK_ERROR_BACKOFF_DELAYS_MS[0]);
	});

	/**
	 * A host that cannot hand over a branch keeps the old in-memory behaviour
	 * rather than losing the bound altogether.
	 */
	it("still bounds a host that cannot supply a branch", () => {
		const goal = activeGoal();
		const runtime = runtimeFor(goal);
		const blind = { cwd: "/tmp", isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
		const delays: number[] = [];

		for (let i = 0; i < NETWORK_ERROR_BACKOFF_DELAYS_MS.length + 3; i += 1) {
			const plan = runtime.scheduleNetworkErrorRetry(blind, goal);
			if (!plan) break;
			delays.push(plan.delayMs);
			runtime.clearNetworkErrorRetryTimerForTest();
		}

		assert.deepEqual(delays, [...NETWORK_ERROR_BACKOFF_DELAYS_MS]);
	});
});

describe("what a tripped guard leaves behind", () => {
	/**
	 * The loop used to stop without a word: no notification, no ledger event,
	 * and a goal file still saying "active". A browser panel reading that file
	 * showed work in progress on a goal nothing was driving.
	 */
	it("names the reason when the model-error guard stops the loop", () => {
		const goal = activeGoal();
		const stopped: string[] = [];
		const dead = [networkErrorTurn(), invalidRequestTurn(), invalidRequestTurn()];

		runtimeFor(goal, stopped).flushContinuationForTest(ctxWithBranch(dead), goal.id);

		assert.deepEqual(stopped, [GUARD_STOP_REASONS.modelErrors]);
	});

	it("says nothing while the loop is still allowed to run", () => {
		const goal = activeGoal();
		const stopped: string[] = [];

		runtimeFor(goal, stopped).flushContinuationForTest(ctxWithBranch([goodTurn()]), goal.id);

		assert.deepEqual(stopped, []);
	});
});
