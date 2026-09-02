import { strict as assert } from "node:assert";
import test from "node:test";
import { focusEntryNeededAfterCompaction } from "../extensions/goal-focus-durability.ts";

/**
 * A compaction must not take the session's focus with it.
 *
 * Focus is not stored in the goal file. It is a `pi-goal-focus` custom entry
 * appended to the session transcript, and it is recovered by scanning that
 * transcript backwards for the most recent one. Compaction replaces the
 * transcript with a summary, and the summary is prose: it may mention the
 * focused goal, but the scan is looking for a structured entry, not for words.
 *
 * So the entry is gone and nothing writes another. The focus survives in memory
 * until the next reload, which is why the loss looks delayed and arbitrary - the
 * goal reads "created and focused", work continues, and then some later reload
 * reports no goal focused at all. A goal was observed sitting at revision 2 for
 * hours while real work happened against it, none of which was recorded.
 */

test("a focused session re-appends its focus entry after compaction", () => {
  assert.equal(focusEntryNeededAfterCompaction({ focusedGoalId: "g1", hasExplicitSessionFocus: true }), true);
});

test("a session with no focus has nothing to preserve", () => {
  assert.equal(focusEntryNeededAfterCompaction({ focusedGoalId: null, hasExplicitSessionFocus: false }), false);
});

/**
 * An explicit release is itself recorded as a focus entry, and losing that to a
 * compaction would silently re-adopt whatever the pool auto-selects.
 */
test("an explicit release is preserved too", () => {
  assert.equal(focusEntryNeededAfterCompaction({ focusedGoalId: null, hasExplicitSessionFocus: true }), true);
});

test("an implicit focus nobody asked for is not written back", () => {
  assert.equal(focusEntryNeededAfterCompaction({ focusedGoalId: "g1", hasExplicitSessionFocus: false }), false);
});
