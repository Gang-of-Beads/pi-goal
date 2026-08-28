/**
 * A goal stopped by one of the runtime's own safety bounds must say so on disk.
 *
 * The bounds used to return quietly: the continuation loop stopped, but nothing
 * was notified, no ledger event was appended, and the goal file still said
 * `status: active` with its last reported task still current. Anything reading
 * that file - the browser goals panel, or the next session - therefore showed
 * work in progress on a goal nothing was driving. This checks the durable side
 * of the fix: the file leaves "active" and the ledger records why.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoalService, type GoalServiceRef } from "../extensions/goal-service.ts";
import { createGoal, nowIso, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { GUARD_STOP_REASONS } from "../extensions/goal-runtime.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function makeRef(goal: GoalRecord): GoalServiceRef {
	let pool = new Map<string, GoalRecord>([[goal.id, goal]]);
	let focusedId: string | null = goal.id;
	let revision = 0;
	return {
		getFocused: () => (focusedId ? pool.get(focusedId) ?? null : null),
		setFocused: (next) => {
			if (next) { pool.set(next.id, next); focusedId = next.id; return; }
			if (focusedId) pool.delete(focusedId);
			focusedId = null;
		},
		getPool: () => pool,
		replacePool: (next) => { pool = next; },
		getFocusedGoalId: () => focusedId,
		assignFocusedGoalId: (id) => {
			if (focusedId !== id) { revision += 1; focusedId = id; }
		},
		focusToken: (goalId) => ({ goalId, revision }),
		isTokenCurrent: (token) => focusedId === token.goalId && revision === token.revision,
		appendFocusEntry: () => {},
		onFocusedGoalLost: () => {},
		onReconciled: () => {},
		onFocusChanged: () => {},
		onDiagnostic: () => {},
	};
}

function fixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-guard-stop-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({
		objective: "=== Goal ===\nObjective: keep going",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 7, 1, 9, 0, 0));
	const written = writeActiveGoalFile({ cwd }, goal);
	const service = new GoalService(makeRef(written));
	const ctx = { cwd } as unknown as ExtensionContext;
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };
	return { cwd, written, service, ctx, cleanup };
}

/** The whole active goal file, whatever it is currently called. */
function activeGoalText(cwd: string): string {
	const dir = path.join(cwd, ".pi", "goals");
	const name = readdirSync(dir).find((entry) => entry.startsWith("active_goal_"));
	return name === undefined ? "" : readFileSync(path.join(dir, name), "utf8");
}

function ledgerLines(cwd: string): Record<string, unknown>[] {
	const file = path.join(cwd, ".pi", "goals", "goal_events.jsonl");
	let raw: string;
	try { raw = readFileSync(file, "utf8"); } catch { return []; }
	const events: Record<string, unknown>[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* partial write */ }
	}
	return events;
}

/**
 * What `blockActiveGoalOnGuard` does through the service. Mirrors the wiring in
 * goal-state.ts so the durable outcome can be checked without booting the whole
 * extension.
 */
function blockOnGuard(service: GoalService, ctx: ExtensionContext, reason: string) {
	return service.apply(ctx, {
		reconcile: false,
		refreshFromDisk: true,
		mutate: (g) => ({ ...g, status: "blocked" as const, autoContinue: false, pauseReason: reason, updatedAt: nowIso() }),
		ledger: (written) => [{
			type: "goal_blocked" as const,
			goalId: written.id,
			reason: written.pauseReason ?? "blocked",
			source: "system" as const,
			at: written.updatedAt,
		}],
	});
}

describe("a goal stopped by a safety bound", () => {
	it("stops claiming to be active in the file a panel reads", () => {
		const { cwd, service, ctx, cleanup } = fixture();
		try {
			assert.match(activeGoalText(cwd), /"status":\s*"active"/, "precondition: starts active");

			const result = blockOnGuard(service, ctx, GUARD_STOP_REASONS.networkRecoveryExhausted);

			assert.equal(result.ok, true);
			const text = activeGoalText(cwd);
			assert.match(text, /"status":\s*"blocked"/);
			assert.doesNotMatch(text, /"status":\s*"active"/);
		} finally {
			cleanup();
		}
	});

	it("records why it stopped, and that no person asked for it", () => {
		const { cwd, service, ctx, cleanup } = fixture();
		try {
			blockOnGuard(service, ctx, GUARD_STOP_REASONS.networkRecoveryExhausted);

			const blocked = ledgerLines(cwd).filter((event) => event.type === "goal_blocked");
			assert.equal(blocked.length, 1);
			assert.equal(blocked[0]?.source, "system");
			assert.equal(blocked[0]?.reason, GUARD_STOP_REASONS.networkRecoveryExhausted);
		} finally {
			cleanup();
		}
	});

	it("turns auto-continue off so a reload cannot resume the same loop", () => {
		const { cwd, service, ctx, cleanup } = fixture();
		try {
			blockOnGuard(service, ctx, GUARD_STOP_REASONS.modelErrors);

			assert.match(activeGoalText(cwd), /"autoContinue":\s*false/);
		} finally {
			cleanup();
		}
	});
});
