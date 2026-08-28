/**
 * The goal's continuation must not inject while background work is active.
 *
 * A queued continuation that fires while a subagent run or a background task
 * is still running interrupts work the user (or another extension) started on
 * purpose. Both siblings that own such work run in the SAME pi process and
 * expose RPC over the shared extension event bus, so the goal can ask them
 * directly instead of guessing from the transcript:
 *
 *   - pi-subagents:  request "subagents:rpc:v1:request", reply on
 *     "subagents:rpc:v1:reply:<requestId>"; the `status` method returns a
 *     `fleet` projection with `totalActive` (foreground children + async jobs
 *     in running/queued/pending state, session-scoped).
 *   - pi-background-tasks: request "pi-background-tasks:request:v1", response
 *     on the shared "pi-background-tasks:response:v1"; the `status` operation
 *     returns `{ tasks: [...] }` where `status === "running"` is active.
 *
 * Quiescence rule pinned here:
 *   1. With confirmed active work the follow-up is held (never sent), and the
 *      continuation stays queued so the ordinary dedup still applies.
 *   2. When the work ends, the held continuation is delivered unchanged.
 *   3. A probe that cannot answer (extension absent, timeout, error or
 *      malformed reply, hook throwing) counts as quiescent — an unreachable
 *      authority must never stall the goal.
 *   4. Deferrals do not consume the stalled-checkpoint budget, and a deferral
 *      older than the cap falls back to the ordinary send (a lost/husk run
 *      must not block the goal forever).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import { GoalRuntime, MAX_BACKGROUND_DEFERRAL_MS } from "../extensions/goal-runtime.ts";
import { probeActiveBackgroundWork } from "../extensions/goal-background.ts";
import { createGoal, goalFocusDetails, type GoalRecord, type GoalStateEntry } from "../extensions/goal-record.ts";

const PROBE_TIMEOUT_MS = 50;

// ── Fake in-process event bus and sibling RPC bridges ───────────────────────
// Shapes mirror the real wire protocols (pi-subagents src/extension/rpc.ts,
// pi-background-tasks src/core/extension-api.ts). The bridges reply on a later
// microtask like the real async handlers do.

type BusHandler = (data: unknown) => void;

function createEventBus() {
	const listeners = new Map<string, Set<BusHandler>>();
	return {
		emit(channel: string, data: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: BusHandler) {
			const set = listeners.get(channel) ?? new Set<BusHandler>();
			set.add(handler);
			listeners.set(channel, set);
			return () => {
				set.delete(handler);
			};
		},
	};
}

type EventBus = ReturnType<typeof createEventBus>;

interface SubagentFleetState {
	totalActive: number;
}

function installFakeSubagentsBridge(bus: EventBus, state: SubagentFleetState): void {
	bus.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as { version?: number; requestId?: string; method?: string };
		void Promise.resolve().then(() => {
			if (typeof request.requestId !== "string") return;
			bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				method: request.method ?? "status",
				success: true,
				data: {
					fleet: {
						version: 1,
						entries:
							state.totalActive > 0
								? [{
									key: "fleet-1",
									agent: "worker",
									startedAt: Date.now(),
									tokens: { input: 1, output: 2, total: 3 },
								}]
								: [],
						totalActive: state.totalActive,
						topLevelAsyncCapacity: { used: 0, limit: 0 },
						omitted: 0,
					},
				},
			});
		});
	});
}

interface BackgroundTasksState {
	running: number;
}

function fakeBgTask(status: string) {
	return {
		id: "bg1",
		command: "sleep 100",
		status,
		outputPath: "/tmp/bg1.out",
		cwd: "/tmp",
		startTime: Date.now(),
		bytesWritten: 0,
		isAgent: false,
		notified: false,
		notifyOnCompletion: false,
		triggerOnCompletion: false,
	};
}

function installFakeBackgroundTasksBridge(bus: EventBus, state: BackgroundTasksState): void {
	bus.on("pi-background-tasks:request:v1", (raw) => {
		const request = raw as { request_id?: string; operation?: string };
		void Promise.resolve().then(() => {
			if (typeof request.request_id !== "string") return;
			bus.emit("pi-background-tasks:response:v1", {
				schema_version: "pi-background-tasks.extension-response.v1",
				request_id: request.request_id,
				operation: request.operation ?? "status",
				ok: true,
				result: {
					tasks: state.running > 0 ? [fakeBgTask("running")] : [],
				},
			});
		});
	});
}

// ── Probe tests (wire shapes) ────────────────────────────────────────────────

function probePi(bus: EventBus): Parameters<typeof probeActiveBackgroundWork>[0] {
	return { events: bus } as unknown as Parameters<typeof probeActiveBackgroundWork>[0];
}

test("probe: an active pi-subagents fleet holds the continuation", async () => {
	const bus = createEventBus();
	installFakeSubagentsBridge(bus, { totalActive: 2 });
	installFakeBackgroundTasksBridge(bus, { running: 0 });
	assert.equal(await probeActiveBackgroundWork(probePi(bus), { timeoutMs: PROBE_TIMEOUT_MS }), true);
});

test("probe: an idle pi-subagents fleet is quiescent", async () => {
	const bus = createEventBus();
	installFakeSubagentsBridge(bus, { totalActive: 0 });
	installFakeBackgroundTasksBridge(bus, { running: 0 });
	assert.equal(await probeActiveBackgroundWork(probePi(bus), { timeoutMs: PROBE_TIMEOUT_MS }), false);
});

test("probe: a running background task holds the continuation", async () => {
	const bus = createEventBus();
	installFakeSubagentsBridge(bus, { totalActive: 0 });
	installFakeBackgroundTasksBridge(bus, { running: 1 });
	assert.equal(await probeActiveBackgroundWork(probePi(bus), { timeoutMs: PROBE_TIMEOUT_MS }), true);
});

test("probe: terminal background tasks are quiescent", async () => {
	const bus = createEventBus();
	installFakeSubagentsBridge(bus, { totalActive: 0 });
	installFakeBackgroundTasksBridge(bus, { running: 0 });
	assert.equal(await probeActiveBackgroundWork(probePi(bus), { timeoutMs: PROBE_TIMEOUT_MS }), false);
});

test("probe: an absent sibling (no reply) counts as quiescent, not as a stall", async () => {
	const bus = createEventBus();
	const startedAt = Date.now();
	assert.equal(await probeActiveBackgroundWork(probePi(bus), { timeoutMs: PROBE_TIMEOUT_MS }), false);
	assert.ok(Date.now() - startedAt < 5_000, "probe must resolve on its own timeout");
});

test("probe: an error reply counts as quiescent", async () => {
	const bus = createEventBus();
	bus.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as { requestId?: string };
		void Promise.resolve().then(() => {
			if (typeof request.requestId !== "string") return;
			bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				success: false,
				error: { code: "no_active_session", message: "No active extension context for subagent RPC." },
			});
		});
	});
	assert.equal(await probeActiveBackgroundWork(probePi(bus), { timeoutMs: PROBE_TIMEOUT_MS }), false);
});

test("probe: a context without an event bus counts as quiescent", async () => {
	assert.equal(await probeActiveBackgroundWork({} as Parameters<typeof probeActiveBackgroundWork>[0], { timeoutMs: PROBE_TIMEOUT_MS }), false);
});

// ── Runtime deferral tests ───────────────────────────────────────────────────

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

function runtimeWithProbe(
	sent: string[],
	goal: GoalRecord,
	probe: () => Promise<boolean>,
): GoalRuntime {
	return new GoalRuntime({
		sendFollowUp: (content) => {
			sent.push(content);
		},
		getGoal: () => goal,
		isActionable: () => true,
		hasActiveBackgroundWork: probe,
	});
}

test("runtime: holds the follow-up while background work is active, sends once quiescent", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	let active = true;
	const runtime = runtimeWithProbe(sent, goal, async () => active);
	const ctx = ctxWithBranch([]);

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 0, "must not inject while background work is active");
	assert.equal(
		runtime.continuationPendingFor(goal.id),
		true,
		"the deferred continuation stays queued so the ordinary dedup still applies",
	);
	runtime.cancelContinuationFor(goal.id); // stop the deferral poll timer for this test

	active = false;
	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 1, "must deliver the held continuation once the session is quiescent");
});

test("runtime: a probe that throws counts as quiescent", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const runtime = runtimeWithProbe(sent, goal, async () => {
		throw new Error("probe down");
	});

	await runtime.flushContinuationForTest(ctxWithBranch([]), goal.id);
	assert.equal(sent.length, 1, "an unreachable probe must never stall the goal");
});

test("runtime: deferrals do not consume the stalled-checkpoint budget", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	let active = true;
	const runtime = runtimeWithProbe(sent, goal, async () => active);
	const ctx = ctxWithBranch([]);

	for (let attempt = 0; attempt < 5; attempt += 1) {
		await runtime.flushContinuationForTest(ctx, goal.id);
		runtime.cancelContinuationFor(goal.id);
	}
	assert.equal(sent.length, 0);

	active = false;
	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 1, "held polls must not count as stalled checkpoints");
});

test("runtime: a deferral older than the cap falls back to the ordinary send", async () => {
	const goal = activeGoal();
	const sent: string[] = [];
	const notifications: string[] = [];
	const runtime = runtimeWithProbe(sent, goal, async () => true);
	const ctx = ctxWithBranch([], {
		ui: { notify: (message: string) => notifications.push(message) },
	});

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 0);
	runtime.cancelContinuationFor(goal.id);

	// White-box: pretend the current deferral started before the cap.
	(runtime as unknown as { backgroundDeferralSince: number | null }).backgroundDeferralSince =
		Date.now() - MAX_BACKGROUND_DEFERRAL_MS - 1;

	await runtime.flushContinuationForTest(ctx, goal.id);
	assert.equal(sent.length, 1, "a lost/husk run must not block the goal forever");
	assert.equal(notifications.length, 1, "the fallback must be visible, not silent");
});

// ── Extension-level tests (full wiring, real timers) ────────────────────────

const FIXTURE_GOAL = readFileSync(new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url), "utf8");

interface HandlerMap {
	[key: string]: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

function fixtureCwd(): string {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-background-deferral-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);
	return cwd;
}

function createHarness(
	cwd: string,
	fleet: SubagentFleetState & BackgroundTasksState,
	opts: { installBridges?: boolean } = {},
) {
	const handlers: HandlerMap = {};
	const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
	const bus = createEventBus();
	if (opts.installBridges !== false) {
		installFakeSubagentsBridge(bus, fleet);
		installFakeBackgroundTasksBridge(bus, fleet);
	}

	// The fixture goal, focused in this session via the branch entries that
	// loadState reads (same contract as the stale-continuation golden tests).
	const parsed = createGoal(
		{ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false },
		Date.UTC(2026, 7, 3, 9, 0, 0),
	);
	const goal: GoalRecord = { ...parsed, id: "golden_fixture_goal" };
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: {
			...goal,
			activePath: ".pi/goals/active_goal_fixture.md",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: undefined,
			verificationContract: undefined,
		},
	};
	const branch: unknown[] = [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];

	const mockPi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler as HandlerMap[string];
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (msg: { customType?: string; details?: unknown }) => {
			sentMessages.push(msg);
		},
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
		events: bus,
	};

	const ctx = {
		cwd,
		hasUI: false,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => branch,
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;

	piGoalExtension(mockPi as never);

	return { handlers, sentMessages, fleet, ctx, goal };
}

function checkpointCount(h: ReturnType<typeof createHarness>): number {
	return h.sentMessages.filter(
		(m) => m.customType === "pi-goal-event" && (m.details as { kind?: string } | undefined)?.kind === "checkpoint",
	).length;
}

async function driveWorkTurn(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.handlers["turn_start"]!({}, h.ctx);
	await h.handlers["tool_call"]!({ toolName: "bash", args: { command: "ls" } }, h.ctx);
	await h.handlers["tool_execution_end"]!({}, h.ctx);
	await h.handlers["turn_end"]!({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, h.ctx);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("extension: no injection while a subagent run is active; injection after it ends", async () => {
	const cwd = fixtureCwd();
	const fleet = { totalActive: 1, running: 0 };
	const h = createHarness(cwd, fleet);
	try {
		const ss = h.handlers["session_start"];
		assert.ok(ss, "session_start handler must be registered");
		await ss({ reason: "start" }, h.ctx);
		assert.ok(h.goal, "the fixture goal must be focused after session_start");

		// A work turn ends and would normally queue a continuation right away.
		await driveWorkTurn(h);

		await wait(300);
		assert.equal(
			checkpointCount(h),
			0,
			"the follow-up must be held while the subagent run is active",
		);

		fleet.totalActive = 0; // the run finishes
		await wait(2_700);
		assert.equal(checkpointCount(h), 1, "the held follow-up is delivered once the session is quiescent");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("extension: with no sibling answering, the continuation still fires (no silent stalling)", async () => {
	const cwd = fixtureCwd();
	// A bus exists but neither sibling extension is loaded: no bridge answers.
	const h = createHarness(cwd, { totalActive: 0, running: 0 }, { installBridges: false });
	try {
		const ss = h.handlers["session_start"];
		assert.ok(ss);
		await ss({ reason: "start" }, h.ctx);
		await driveWorkTurn(h);

		// The probe must time out (well under 5s) and the continuation fire.
		await wait(4_000);
		assert.equal(
			checkpointCount(h),
			1,
			"an absent authority must not stall the continuation",
		);
	} finally {
		// temp dir cleanup is best-effort.
	}
});
