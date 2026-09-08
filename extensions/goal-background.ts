/**
 * Authoritative "is background work active" probes used to defer the goal's
 * continuation injection.
 *
 * The extensions that own background work run in the SAME pi process as this
 * extension and expose RPC over the shared extension event bus (`pi.events`),
 * so the goal can ask them directly instead of inferring activity from the
 * transcript:
 *
 * - pi-subagents (src/extension/rpc.ts): request event
 *   "subagents:rpc:v1:request" with `{ version: 1, requestId, method, params }`,
 *   replied on "subagents:rpc:v1:reply:<requestId>" with
 *   `{ version: 1, requestId, success, data | error }`. The `status` method
 *   returns the tool status plus a `fleet` projection built from the live
 *   in-process run registry: `{ version: 1, entries, totalActive,
 *   topLevelAsyncCapacity, omitted }`. `totalActive` counts foreground
 *   children and async jobs in running/queued/pending state and is scoped to
 *   the current session, so stale runs from other sessions never count.
 *
 * - pi-background-tasks (src/core/extension-api.ts): request
 *   "pi-background-tasks:request:v1" with
 *   `{ schema_version, request_id, operation, payload }`, answered on the
 *   shared "pi-background-tasks:response:v1" channel with
 *   `{ schema_version, request_id, operation, ok, result | error }`. The
 *   `status` operation returns `{ tasks: BgTaskSnapshot[] }`; a task is
 *   active while `status === "running"` and carries startTime evidence.
 *
 * Quiescence rule: the goal injects only when neither probe CONFIRMS active
 * work. A probe that cannot answer — sibling extension absent, timeout, error
 * or malformed reply — counts as quiescent. These are direct authoritative
 * queries, not transcript inference, so an unreachable authority must never
 * stall the goal; the runtime additionally caps how long a single queued
 * continuation may be held (see MAX_BACKGROUND_DEFERRAL_MS in
 * goal-runtime.ts), which is the backstop for a lost/husk run that never
 * terminates inside a live registry.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Round-trip budget for one in-process probe. */
export const DEFAULT_BACKGROUND_PROBE_TIMEOUT_MS = 1_000;

/**
 * How old an active run's own evidence may be before it stops holding the
 * goal's continuation.
 *
 * Both registries report what they believe is running, and both can keep a
 * husk: a child whose process died without a terminal transition stays
 * "running" forever, and the goal then waits out the whole deferral cap on
 * every checkpoint. A run that has genuinely been working for longer than this
 * keeps the goal quiet through its own progress instead - the cap remains the
 * backstop for registries that report no timestamps at all.
 */
export const STALE_RUN_EVIDENCE_MS = 10 * 60_000;

function startedWithinWindow(value: unknown, now: number): boolean {
	const startedAt = typeof value === "number" && Number.isFinite(value) ? value : undefined;
	if (startedAt === undefined) return true;
	return now - startedAt < STALE_RUN_EVIDENCE_MS;
}

// Wire constants mirrored from the sibling extensions. They are not
// dependencies of this package; the exact shapes are pinned by
// tests/goal-background-deferral.test.ts.
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_RPC_PROTOCOL_VERSION = 1;

const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

function eventBusOf(pi: ExtensionAPI): EventBusLike | null {
	const bus = (pi as { events?: EventBusLike }).events;
	if (!bus || typeof bus.emit !== "function" || typeof bus.on !== "function") return null;
	return bus;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

interface EventBusRequestOptions {
	channel: string;
	replyChannel: string;
	payload: unknown;
	timeoutMs: number;
	/** Extra match a reply must satisfy on a (possibly shared) reply channel. */
	replyMatches?: (reply: unknown) => boolean;
}

/**
 * One request/response round trip over the in-process event bus. Resolves
 * null when no acceptable answer arrives within the timeout — callers treat
 * that as "cannot confirm activity".
 */
async function eventBusRequest(bus: EventBusLike, options: EventBusRequestOptions): Promise<unknown> {
	return await new Promise<unknown>((resolve) => {
		let settled = false;
		let unsubscribe: () => void = () => {};
		const finish = (reply: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(reply);
		};
		const timer = setTimeout(() => finish(null), options.timeoutMs);
		timer.unref?.();
		unsubscribe = bus.on(options.replyChannel, (data) => {
			if (options.replyMatches && !options.replyMatches(data)) return;
			finish(data);
		}) ?? (() => {});
		try {
			bus.emit(options.channel, options.payload);
		} catch {
			finish(null);
		}
	});
}

/**
 * True only when the pi-subagents bridge answers with a fleet that reports
 * active runs (foreground children or background async jobs) for this session.
 */
export async function probeSubagentRunsActive(
	pi: ExtensionAPI,
	timeoutMs = DEFAULT_BACKGROUND_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	const bus = eventBusOf(pi);
	if (!bus) return false;
	const requestId = `pi-goal-x-${randomUUID()}`;
	const reply = await eventBusRequest(bus, {
		channel: SUBAGENT_RPC_REQUEST_EVENT,
		replyChannel: `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`,
		payload: { version: SUBAGENT_RPC_PROTOCOL_VERSION, requestId, method: "status", params: {} },
		timeoutMs,
	});
	const envelope = asRecord(reply);
	if (!envelope || envelope.version !== SUBAGENT_RPC_PROTOCOL_VERSION || envelope.requestId !== requestId) return false;
	if (envelope.success !== true) return false;
	const data = asRecord(envelope.data);
	const fleet = asRecord(data?.fleet);
	const totalActive = fleet?.totalActive;
	if (typeof totalActive !== "number" || !Number.isFinite(totalActive) || totalActive <= 0) return false;
	const entries = Array.isArray(fleet?.entries) ? fleet.entries : [];
	if (entries.length === 0) return true;
	const now = Date.now();
	return entries.some((entry) => startedWithinWindow(asRecord(entry)?.startedAt, now));
}

/**
 * True only when the pi-background-tasks bridge answers with at least one
 * task whose snapshot status is still "running".
 */
export async function probeBackgroundTasksActive(
	pi: ExtensionAPI,
	timeoutMs = DEFAULT_BACKGROUND_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	const bus = eventBusOf(pi);
	if (!bus) return false;
	const requestId = `pi-goal-x-${randomUUID()}`;
	const reply = await eventBusRequest(bus, {
		channel: BG_REQUEST_CHANNEL,
		replyChannel: BG_RESPONSE_CHANNEL,
		payload: { schema_version: BG_REQUEST_SCHEMA, request_id: requestId, operation: "status", payload: {} },
		timeoutMs,
		replyMatches: (data) => asRecord(data)?.request_id === requestId,
	});
	const envelope = asRecord(reply);
	if (!envelope || envelope.schema_version !== BG_RESPONSE_SCHEMA || envelope.ok !== true) return false;
	const result = asRecord(envelope.result);
	const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
	const now = Date.now();
	return tasks.some((task) => {
		const snapshot = asRecord(task);
		if (snapshot?.status !== "running") return false;
		return startedWithinWindow(snapshot.startTime, now);
	});
}

export interface ProbeActiveBackgroundWorkOptions {
	timeoutMs?: number;
}

/**
 * True only when an authoritative in-process registry confirms active
 * subagent or background-task work. Everything else — idle registries,
 * missing siblings, timeouts, malformed or error replies — is quiescent.
 */
export async function probeActiveBackgroundWork(
	pi: ExtensionAPI,
	options: ProbeActiveBackgroundWorkOptions = {},
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_BACKGROUND_PROBE_TIMEOUT_MS;
	const [subagents, backgroundTasks] = await Promise.all([
		probeSubagentRunsActive(pi, timeoutMs),
		probeBackgroundTasksActive(pi, timeoutMs),
	]);
	return subagents || backgroundTasks;
}
