/**
 * Focus is exclusive, and the ledger is what settles it.
 *
 * Two sessions could each hold the same goal and both drive it: nothing read
 * the generation the ledger already maintains, so neither session ever learned
 * it had lost. `goal_focused` bumps a monotonic counter and records it against
 * the goal, so the newest focus wins by construction - the loser only has to
 * notice.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { focusLostToAnotherSession, reconstructGoalLedger } from "../extensions/goal-ledger.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

const AT = "2026-08-28T12:00:00.000Z";

function created(goalId: string): GoalLedgerEvent {
	return { type: "goal_created", goalId, objective: `do ${goalId}`, sisyphus: false, autoContinue: true, at: AT };
}

function focused(goalId: string): GoalLedgerEvent {
	return { type: "goal_focused", goalId, reason: "selected", at: AT };
}

function stateAfter(events: GoalLedgerEvent[]) {
	return reconstructGoalLedger(events);
}

describe("focusLostToAnotherSession", () => {
	it("says the holder still holds a goal nobody else focused", () => {
		const state = stateAfter([created("g1"), focused("g1")]);

		assert.equal(focusLostToAnotherSession(state, "g1"), false);
	});

	/**
	 * Two sessions on the same goal is the case that motivated this, and the
	 * ledger cannot name sessions: the goal stays current, so nobody is asked to
	 * let go. Exclusivity here comes from the later focus taking over the goal,
	 * not from evicting the earlier holder - which is why the eviction path has
	 * to be driven by a *different* goal or an unfocus, as the tests below do.
	 */
	it("keeps the goal current when the same goal is focused again", () => {
		const state = stateAfter([created("g1"), focused("g1"), focused("g1")]);

		assert.equal(focusLostToAnotherSession(state, "g1"), false);
	});

	it("sees the loss when a different goal takes the focus", () => {
		const state = stateAfter([created("g1"), created("g2"), focused("g1"), focused("g2")]);

		assert.equal(focusLostToAnotherSession(state, "g1"), true);
		assert.equal(focusLostToAnotherSession(state, "g2"), false);
	});

	it("reports a loss after an explicit unfocus moved the generation on", () => {
		const state = stateAfter([created("g1"), focused("g1"), { type: "goal_unfocused", reason: "unfocused", at: AT }]);

		assert.equal(focusLostToAnotherSession(state, "g1"), true);
	});

	/**
	 * A goal the ledger has never recorded is not evidence of a loss. Treating
	 * it as one would drop focus the moment a fresh goal is focused before its
	 * creation event has been read back.
	 */
	it("leaves focus alone for a goal the ledger has not recorded", () => {
		const state = stateAfter([created("g1"), focused("g1")]);

		assert.equal(focusLostToAnotherSession(state, "unknown-goal"), false);
	});

	it("leaves focus alone when the ledger is empty", () => {
		assert.equal(focusLostToAnotherSession(stateAfter([]), "g1"), false);
	});
});
