import { strict as assert } from "node:assert";
import test from "node:test";
import { idleTurnDecision } from "../extensions/goal-idle-turns.ts";

/**
 * A turn that called no work tool used to end the goal's progress silently.
 *
 * The gate asked "did you call a tool", which is a proxy for "did anything
 * advance" and a bad one: reading a file counted, while thinking a problem
 * through and asking the user did not. Worse, it could not tell an agent
 * chatting to itself from an agent waiting for a decision. Both look like a
 * turn with no tool call, and they deserve opposite treatment - one should
 * stop, the other should be reported to the user.
 *
 * A goal was observed sitting at 0/11 for hours with nothing on screen saying
 * why. That is the real defect: absence rendered as nothing at all.
 *
 * The replacement lets continuations run, and watches for a goal that is not
 * moving. An agent that needs a decision is expected to say so by blocking,
 * which stops continuations on its own.
 */

test("an advancing turn keeps the goal running", () => {
  assert.equal(idleTurnDecision({ idleTurns: 0, limit: 3 }), "continue");
  assert.equal(idleTurnDecision({ idleTurns: 1, limit: 3 }), "continue");
});

test("a goal that has not moved for the limit asks for attention rather than stopping quietly", () => {
  assert.equal(idleTurnDecision({ idleTurns: 3, limit: 3 }), "needs-attention");
});

test("it stays needing attention rather than flapping back to running", () => {
  assert.equal(idleTurnDecision({ idleTurns: 9, limit: 3 }), "needs-attention");
});

test("a limit of zero disables the watch instead of firing on every turn", () => {
  assert.equal(idleTurnDecision({ idleTurns: 5, limit: 0 }), "continue");
});

test("the count is the turns since anything last changed, so one advance clears it", () => {
  assert.equal(idleTurnDecision({ idleTurns: 2, limit: 3 }), "continue");
  assert.equal(idleTurnDecision({ idleTurns: 0, limit: 3 }), "continue");
});
