/**
 * Headless command guards must fail loudly and durably, not vanish.
 *
 * The real incident: "/goal-tweak ..." typed in the pi-web composer with no
 * open goal hit the guard, fired a "warning" notify and returned. pi-web
 * flattens warning notifies into an ephemeral broadcast that is persisted
 * nowhere, so the command left no transcript entry, no reply, and no error —
 * the message just vanished. Every blocking guard now reports through
 * reportGuardBlock: an error-class notify (routed to the host notification
 * store) plus a durable, visible custom message entry ("pi-goal-guard")
 * while the session is idle. While a turn is running, the durable record
 * degrades to a bare custom entry: steering guard text into the agent loop
 * would change command semantics.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";

interface GuardHarness {
	ctx: ExtensionContext;
	commands: Map<string, any>;
	handlers: Map<string, Function>;
	notifications: Array<{ message: string; level?: string }>;
	sentMessages: Array<{ customType: string; content: unknown; display?: boolean }>;
	appendedEntries: Array<{ customType: string; data: unknown }>;
	userMessages: string[];
}

function createHarness(cwd: string, opts: { idle?: boolean } = {}): GuardHarness {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const sentMessages: Array<{ customType: string; content: unknown; display?: boolean }> = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const userMessages: string[] = [];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data?: unknown) => { appendedEntries.push({ customType, data }); },
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string) => { userMessages.push(message); },
		sendMessage: (message: { customType: string; content: unknown; display?: boolean }) => { sentMessages.push(message); },
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "guard-visibility-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string, level?: string) => { notifications.push({ message, level }); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => opts.idle ?? true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return { ctx, commands, handlers, notifications, sentMessages, appendedEntries, userMessages };
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

async function startedHarness(cwd: string, opts: { idle?: boolean } = {}): Promise<GuardHarness> {
	const h = createHarness(cwd, opts);
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	return h;
}

test("/goal-tweak with no goal fails loudly headlessly: error notify plus a durable visible pi-goal-guard entry", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-guard-tweak-"));
	try {
		const h = await startedHarness(cwd);
		await h.commands.get("goal-tweak")!.handler("polish the intro", h.ctx);

		const guard = h.sentMessages.find((m) => m.customType === "pi-goal-guard");
		assert.ok(guard, `expected a durable pi-goal-guard entry, got messages: ${JSON.stringify(h.sentMessages)}`);
		assert.equal(guard.display, true, "guard entry must be display:true so transcript hosts render it");
		assert.match(String(guard.content), /No goal is set/);
		assert.match(String(guard.content), /\/goal-direct/, "guard must tell the user what to do");

		const notify = h.notifications.find((n) => n.message.includes("No goal is set"));
		assert.ok(notify, `expected the guard notify, got: ${JSON.stringify(h.notifications)}`);
		assert.equal(notify.level, "error", "guard notify must be error-class (pi-web flattens warning notifies away)");

		// Semantics unchanged: the guard still creates nothing and prompts nobody.
		assert.equal(activeGoalFiles(cwd).length, 0, "guard must not create a goal");
		assert.equal(h.userMessages.length, 0, "guard must not prompt the agent");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/goal-tweak guard while a turn is running records a bare durable entry and never steers the agent", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-guard-tweak-busy-"));
	try {
		const h = await startedHarness(cwd, { idle: false });
		await h.commands.get("goal-tweak")!.handler("polish the intro", h.ctx);

		const entry = h.appendedEntries.find((e) => e.customType === "pi-goal-guard");
		assert.ok(entry, `expected a bare durable pi-goal-guard entry, got: ${JSON.stringify(h.appendedEntries)}`);
		assert.match(JSON.stringify(entry.data), /No goal is set/);
		assert.equal(h.sentMessages.length, 0, "must not steer guard text into a running turn");
		assert.equal(h.notifications.some((n) => n.level === "error" && n.message.includes("No goal is set")), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("other blocking no-goal guards are loud and durable too (/goal-pause, /goal-focus)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-guard-family-"));
	try {
		const h = await startedHarness(cwd);

		await h.commands.get("goal-pause")!.handler("", h.ctx);
		let guard = h.sentMessages.find((m) => m.customType === "pi-goal-guard");
		assert.ok(guard, "goal-pause no-goal guard must leave a durable entry");
		assert.match(String(guard.content), /No goal is set/);

		h.sentMessages.length = 0;
		await h.commands.get("goal-focus")!.handler("", h.ctx);
		guard = h.sentMessages.find((m) => m.customType === "pi-goal-guard");
		assert.ok(guard, "goal-focus no-open-goals guard must leave a durable entry");
		assert.match(String(guard.content), /No open goals/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("benign no-ops stay plain notifies: /goal-cancel without a draft leaves no guard artifact", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-guard-benign-"));
	try {
		const h = await startedHarness(cwd);
		await h.commands.get("goal-cancel")!.handler("", h.ctx);

		assert.ok(h.notifications.some((n) => n.message.includes("No active draft to cancel")), "benign no-op keeps its notify");
		assert.equal(h.sentMessages.length, 0, "benign no-op must not emit a guard entry");
		assert.equal(h.appendedEntries.length, 0, "benign no-op must not append an entry");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
