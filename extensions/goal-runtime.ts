/**
 * GoalRuntime — continuation scheduling, stale-checkpoint state, the turn-stop
 * guard, and one-time steering reminders (post-compaction, budget reached).
 *
 * The extension (`extensions/goal.ts`) instantiates one GoalRuntime with hooks
 * bound to its closure state and the pi API; every runtime decision is
 * encapsulated here so the scheduling/guarding behavior is independently
 * testable with a mock context.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asRecord } from "./goal-record.ts";
import type { GoalCheckpointDetailsV2, GoalRecord } from "./goal-record.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { POST_STOP_ALLOWED_TOOLS } from "./goal-tool-names.ts";
import { isNetworkErrorAssistantMessage } from "./goal-format.ts";
import { networkErrorBackoffPlan, type NetworkErrorBackoffPlan } from "./network-error-backoff.ts";

export const CONTINUATION_IDLE_RETRY_MS = 50;

/**
 * How often a continuation that is being held back by active background work
 * re-probes the in-process registries. The first quiescent probe delivers the
 * held follow-up; the poll is what re-triggers the injection when work ends.
 */
export const BACKGROUND_BUSY_POLL_MS = 2_000;

/**
 * How long a single queued continuation may be held back by (apparently)
 * active background work before the runtime falls back to the ordinary send.
 *
 * The deferral probes are authoritative in-process registries, but a run can
 * still be lost there — a husk that never reaches a terminal state. Waiting
 * forever on such a run would silently stall the goal, so the hold is bounded:
 * after this long the follow-up goes out through the unchanged guard path and
 * the user is notified once. A user message also always clears the wait
 * (before_agent_start cancels queued continuations on user-driven turns).
 */
export const MAX_BACKGROUND_DEFERRAL_MS = 15 * 60_000;

/**
 * How many checkpoints may pass without the goal changing before the runtime
 * stops driving it.
 *
 * A checkpoint exists to make the agent take the next step. If the goal's
 * revision has not moved after this many of them, the agent is not taking one
 * - it may be reading stale state, or refusing, or failing silently - and
 * sending more cannot help. Stopping turns an unbounded loop into a bounded
 * one that a person can see and act on.
 */
export const MAX_STALLED_CHECKPOINTS = 3;

/**
 * How many model turns may die in a row before the runtime stops waking the
 * agent.
 *
 * The stalled-checkpoint guard above counts in memory, on this instance. The
 * instance does not outlive the thing it is guarding against: measured on a
 * real session, five consecutive checkpoints were written with the same goal
 * revision *and* the same `checkpointSeq` of 1, which only happens if the
 * runtime - and with it the counter - was rebuilt between every one of them.
 * The guard could not fire, so a single unrecoverable model error was re-driven
 * until something else stopped it.
 *
 * A provider error is not always a passing one. `400 invalid_request_error` is
 * deliberately not retried by the model layer, because sending the same bytes
 * again gets the same answer; waking the agent to send them again is that retry
 * by another route, and it costs a request every time.
 *
 * So the count comes from the session instead of from memory. The transcript is
 * the one record that survives a rebuild.
 */
export const MAX_CONSECUTIVE_MODEL_ERRORS = 2;

/**
 * How many model turns at the end of this branch failed, counting back from the
 * newest.
 *
 * Only `message` entries are consulted: a checkpoint is a `custom_message` and
 * sits between every pair of them, and model/thinking-level changes are not
 * turns at all. Anything that is not a failed assistant turn - a reply that
 * worked, a tool result, or a person typing - ends the streak, which is what
 * makes a human stepping in enough to clear it.
 */
export function trailingModelErrorCount(entries: readonly unknown[]): number {
	let count = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = asRecord(entries[index]);
		if (!entry || entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message) continue;
		if (message.role !== "assistant") return count;
		if (message.stopReason !== "error") return count;
		count += 1;
	}
	return count;
}

/**
 * How many of the turns at the end of this branch died of a network error,
 * counting back from the newest.
 *
 * The backoff ladder is bounded at five attempts, but it counted them on the
 * runtime instance, and that instance is rebuilt between checkpoints on this
 * host. Every rebuild put the count back to zero, so `networkErrorBackoffPlan`
 * was asked for attempt 1 forever: measured with a fresh runtime per attempt,
 * eight consecutive calls all returned a 5s delay instead of climbing
 * 5/10/20/40/80 and then stopping. An unavailable provider was polled every
 * five seconds without end.
 *
 * Counting from the branch makes the ladder independent of how often the
 * runtime is rebuilt, exactly as `trailingModelErrorCount` does for the
 * model-error guard. Both read the same durable record so the two guards can
 * never disagree about what just happened.
 */
export function trailingNetworkErrorCount(entries: readonly unknown[]): number {
	let count = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = asRecord(entries[index]);
		if (!entry || entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message) continue;
		if (!isNetworkErrorAssistantMessage(message)) return count;
		count += 1;
	}
	return count;
}

/**
 * The newest checkpoint this goal wrote, read back off the branch.
 *
 * A checkpoint is a `custom_message` carrying v2 details, which is how the loop
 * records that it asked the agent for a step. Reading it back is what lets a
 * runtime answer "did I already ask for this" without trusting memory that a
 * rebuild wiped.
 */
export function latestCheckpointForGoal(entries: readonly unknown[], goalId: string): GoalCheckpointDetailsV2 | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = asRecord(entries[index]);
		if (!entry || entry.type !== "custom_message") continue;
		const details = asRecord(entry.details);
		if (!details || details.kind !== "checkpoint" || details.goalId !== goalId) continue;
		return details as unknown as GoalCheckpointDetailsV2;
	}
	return undefined;
}

/**
 * Whether this goal's newest checkpoint is still waiting for an answer.
 *
 * The dedup markers live on the runtime instance, and that instance is rebuilt
 * between checkpoints on this host: after a rebuild `continuationPendingFor()`
 * reports false about a continuation that is genuinely in flight, so the loop
 * queues a second one and the turn is paid for twice. Measured with two
 * runtimes over one outstanding ask, the checkpoint went out twice.
 *
 * A turn following the checkpoint is the answer, whoever produced it — the
 * agent taking the step, or a person typing. Only an unanswered checkpoint
 * blocks, so the ordinary way forward still clears it.
 */
export function trailingCheckpointWithoutTurn(entries: readonly unknown[], goalId: string): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = asRecord(entries[index]);
		if (!entry) continue;
		if (entry.type === "message") return false;
		if (entry.type !== "custom_message") continue;
		const details = asRecord(entry.details);
		if (!details || details.kind !== "checkpoint") continue;
		if (details.goalId !== goalId) return false;
		return true;
	}
	return false;
}

/** The branch this session is on, or nothing when the host cannot supply it. */
function branchEntries(ctx: ExtensionContext): readonly unknown[] {
	try {
		const manager = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } }).sessionManager;
		return manager?.getBranch?.() ?? [];
	} catch {
		return [];
	}
}

const POST_STOP_ALLOWED = new Set<string>(POST_STOP_ALLOWED_TOOLS);

export interface GoalRuntimeHooks {
	/** Dispatch a hidden follow-up checkpoint message (pi.sendMessage + triggerTurn). */
	sendFollowUp(content: string, details: Record<string, unknown>): void;
	/** Current focused goal (state.goal). */
	getGoal(): GoalRecord | null;
	/** Whether a checkpointed goal id is still actionable (active + autoContinue). */
	isActionable(goalId: string | null | undefined): boolean;
	/**
	 * Report that a safety bound stopped the loop: notify, record it, and move
	 * the goal off "active" so its file stops claiming work is under way.
	 * Optional so an embedder that only schedules can omit it.
	 */
	onGuardStopped?(ctx: ExtensionContext, reason: string): void;

	/**
	 * Optional authoritative probe: does the session currently have active
	 * subagent runs or background tasks? Implemented over the in-process event
	 * bus (extensions/goal-background.ts). When absent, the runtime never
	 * defers; when it throws, the send proceeds (uncertainty must not stall).
	 */
	hasActiveBackgroundWork?(): Promise<boolean>;
}

/** What the reader is told when a bound stops the loop. */
export const GUARD_STOP_REASONS = {
	modelErrors: `the last ${String(MAX_CONSECUTIVE_MODEL_ERRORS)} model turns failed, so continuing would repeat a request the provider already refused`,
	stalledCheckpoints: `${String(MAX_STALLED_CHECKPOINTS)} checkpoints passed without the goal changing`,
	networkRecoveryExhausted: "provider network errors outlasted every bounded recovery attempt",
} as const;

export class GoalRuntime {
	// ── continuation scheduling ──────────────────────────────────────────
	private continuationQueuedFor: string | null = null;
	private continuationScheduledFor: string | null = null;
	private continuationTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Bumped on every schedule/clear so a callback that already fired (and is
	 * now awaiting the background-work probe) cannot act on superseded state —
	 * the await gap must not reopen the double-send race the synchronous path
	 * never had.
	 */
	private continuationEpoch = 0;
	/** When the current queued continuation first deferred to background work. */
	private backgroundDeferralSince: number | null = null;
	private networkErrorRetryGoalId: string | null = null;
	private networkErrorRetryAttempt = 0;
	private networkErrorRetryTimer: ReturnType<typeof setTimeout> | null = null;

	// ── turn-stop guard ──────────────────────────────────────────────────
	private turnSeq = 0;
	private turnStoppedFor: { goalId: string; turnSeq: number } | null = null;

	// ── stale checkpoint state ───────────────────────────────────────────
	private checkpointGoalId: string | null = null;

	/** Monotonic per-session counter persisted on v2 checkpoint details (issue #30). */
	private checkpointSeq = 0;

	// ── stalled-checkpoint breaker ───────────────────────────────────────
	private lastCheckpointRevision: number | null = null;
	private stalledCheckpoints = 0;

	// ── one-time steering reminders ──────────────────────────────────────
	private postCompactReminderPending = false;
	private postBudgetReminderPending = false;

	private readonly hooks: GoalRuntimeHooks;

	constructor(hooks: GoalRuntimeHooks) {
		this.hooks = hooks;
	}

	// ── continuation scheduling ──────────────────────────────────────────

	clearContinuationState(resetNetworkErrorBackoff = true): void {
		this.clearContinuationTimer();
		this.continuationQueuedFor = null;
		this.backgroundDeferralSince = null;
		if (resetNetworkErrorBackoff) this.clearNetworkErrorBackoff();
	}

	/** Clear the pending timer but keep the queued marker (used at session shutdown). */
	clearContinuationTimer(): void {
		this.continuationEpoch += 1; // in-flight probe waits belong to the cleared schedule
		if (this.continuationTimer) {
			clearTimeout(this.continuationTimer);
			this.continuationTimer = null;
		}
		this.continuationScheduledFor = null;
	}

	/** Whether a continuation is queued or scheduled for this goal id. */
	continuationPendingFor(goalId: string): boolean {
		return this.continuationQueuedFor === goalId || this.continuationScheduledFor === goalId;
	}

	/**
	 * Schedule the next auto-continuation for the focused active goal.
	 * Only `active` + autoContinue goals can queue. `force` bypasses the
	 * already-queued/scheduled dedup (used right after creation/resume).
	 */
	queueContinuation(ctx: ExtensionContext, goal: GoalRecord, force = false): void {
		if (goal.status !== "active" || !goal.autoContinue) return;
		const goalId = goal.id;
		if (!force && this.continuationPendingFor(goalId)) return;
		this.clearContinuationTimer(); // also bumps the epoch: older fired callbacks abandon
		const epoch = this.continuationEpoch;
		let delay = CONTINUATION_IDLE_RETRY_MS;
		try {
			delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : CONTINUATION_IDLE_RETRY_MS;
		} catch {
			return;
		}
		this.continuationScheduledFor = goalId;
		this.continuationTimer = setTimeout(() => void this.sendQueuedContinuation(ctx, goalId, epoch), delay);
		this.continuationTimer.unref?.();
	}

	/** Deterministic entry point for the scheduled send, so tests need no timers. */
	flushContinuationForTest(ctx: ExtensionContext, goalId: string): Promise<void> {
		return this.sendQueuedContinuation(ctx, goalId);
	}

	/** Cancel a pending continuation for a goal id (e.g. after update/clear/focus change). */
	cancelContinuationFor(goalId: string): void {
		if (this.continuationQueuedFor === goalId) this.continuationQueuedFor = null;
		if (this.continuationScheduledFor === goalId) this.clearContinuationState();
		if (this.networkErrorRetryGoalId === goalId) this.clearNetworkErrorBackoff();
	}

	/**
	 * Schedule the next bounded recovery after Pi's built-in provider retries
	 * have failed.
	 *
	 * Which attempt this is comes from the branch rather than from this
	 * instance: the instance is rebuilt between checkpoints, and counting on it
	 * restarted the ladder at 5s forever. The in-memory counter is still kept as
	 * the floor, so a host that cannot supply a branch degrades to the old
	 * behaviour within one instance rather than losing the bound entirely.
	 */
	scheduleNetworkErrorRetry(ctx: ExtensionContext, goal: GoalRecord): NetworkErrorBackoffPlan | null {
		if (goal.status !== "active" || !goal.autoContinue || this.networkErrorRetryTimer) return null;
		if (this.networkErrorRetryGoalId !== goal.id) {
			this.networkErrorRetryGoalId = goal.id;
			this.networkErrorRetryAttempt = 0;
		}
		// The failure that triggered this call is already on the branch, so N
		// trailing errors means N failures have happened and this is recovery N.
		const attemptsOnBranch = trailingNetworkErrorCount(branchEntries(ctx));
		const nextAttempt = Math.max(this.networkErrorRetryAttempt + 1, attemptsOnBranch);
		const plan = networkErrorBackoffPlan(nextAttempt);
		if (!plan) return null;
		this.networkErrorRetryAttempt = plan.attempt;
		this.networkErrorRetryTimer = setTimeout(() => {
			this.networkErrorRetryTimer = null;
			if (!this.hooks.isActionable(goal.id)) return;
			const currentGoal = this.hooks.getGoal();
			if (!currentGoal || currentGoal.id !== goal.id) return;
			this.queueContinuation(ctx, currentGoal, true);
		}, plan.delayMs);
		this.networkErrorRetryTimer.unref?.();
		return plan;
	}

	/**
	 * Drop only the pending timer, keeping the attempt count. Lets a test walk
	 * the ladder without waiting out 5s..80s of real delays.
	 */
	clearNetworkErrorRetryTimerForTest(): void {
		if (this.networkErrorRetryTimer) clearTimeout(this.networkErrorRetryTimer);
		this.networkErrorRetryTimer = null;
	}

	/** Cancel and forget all goal-level network-error recovery state. */
	clearNetworkErrorBackoff(): void {
		if (this.networkErrorRetryTimer) clearTimeout(this.networkErrorRetryTimer);
		this.networkErrorRetryTimer = null;
		this.networkErrorRetryGoalId = null;
		this.networkErrorRetryAttempt = 0;
	}

	/**
	 * Issue #30: the delivered follow-up must trigger the turn, but it no longer
	 * carries goal state. The persisted content is a tiny v2 marker and the
	 * details are a bounded structured record; before_agent_start injects the
	 * authoritative full prompt once per turn.
	 */
	private async sendQueuedContinuation(ctx: ExtensionContext, scheduledGoalId: string, epoch: number = this.continuationEpoch): Promise<void> {
		if (epoch !== this.continuationEpoch) return; // superseded by a newer schedule/clear
		this.continuationTimer = null;
		this.continuationScheduledFor = null;
		if (!this.hooks.isActionable(scheduledGoalId)) {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			this.backgroundDeferralSince = null;
			return;
		}

		let ready: boolean;
		try {
			ready = !ctx.hasPendingMessages() && ctx.isIdle();
		} catch {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			this.backgroundDeferralSince = null;
			return;
		}

		if (!ready) {
			this.continuationScheduledFor = scheduledGoalId;
			this.continuationTimer = setTimeout(() => void this.sendQueuedContinuation(ctx, scheduledGoalId, epoch), CONTINUATION_IDLE_RETRY_MS);
			this.continuationTimer.unref?.();
			return;
		}
		// Background-work deferral: with an active subagent run or background
		// task the follow-up must not interrupt; hold it (poll BACKGROUND_BUSY_POLL_MS)
		// until the registries report quiescence. Evaluated before the goal/stall
		// guards below so held polls never consume their budgets.
		if (this.hooks.hasActiveBackgroundWork) {
			if (await this.deferWhileBackgroundWorkActive(ctx, scheduledGoalId, epoch)) return;
			if (epoch !== this.continuationEpoch) return; // superseded while probing
		}
		const goal = this.hooks.getGoal();
		if (!goal || goal.id !== scheduledGoalId || goal.status !== "active" || !goal.autoContinue) {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			this.continuationScheduledFor = null;
			return;
		}
		const branch = branchEntries(ctx);
		// The dedup markers on this instance say nothing about a checkpoint an
		// earlier instance sent. An unanswered checkpoint on the branch does, and
		// asking twice for one step pays for the turn twice.
		if (trailingCheckpointWithoutTurn(branch, scheduledGoalId)) {
			this.continuationQueuedFor = scheduledGoalId;
			this.continuationScheduledFor = null;
			return;
		}
		// Read before the in-memory counters, because this is the one that still
		// knows what happened before this runtime existed.
		const failedTurns = trailingModelErrorCount(branch);
		if (failedTurns >= MAX_CONSECUTIVE_MODEL_ERRORS) {
			this.continuationQueuedFor = null;
			this.continuationScheduledFor = null;
			this.hooks.onGuardStopped?.(ctx, GUARD_STOP_REASONS.modelErrors);
			return;
		}
		const revision = goal.revision ?? 0;
		if (this.lastCheckpointRevision === revision) {
			this.stalledCheckpoints += 1;
		} else {
			this.lastCheckpointRevision = revision;
			this.stalledCheckpoints = 0;
		}
		if (this.stalledCheckpoints >= MAX_STALLED_CHECKPOINTS) {
			this.continuationQueuedFor = null;
			this.hooks.onGuardStopped?.(ctx, GUARD_STOP_REASONS.stalledCheckpoints);
			return;
		}
		// Continue the sequence the branch already carries rather than this
		// instance's counter: five checkpoints all numbered 1 is what proved the
		// rebuild, and a sequence that restarts cannot serve as evidence again.
		const lastSeq = latestCheckpointForGoal(branch, goal.id)?.checkpointSeq ?? 0;
		this.checkpointSeq = Math.max(this.checkpointSeq, lastSeq) + 1;
		this.continuationQueuedFor = goal.id;
		const details: GoalCheckpointDetailsV2 = {
			version: 2,
			kind: "checkpoint",
			goalId: goal.id,
			status: "active",
			revision: goal.revision ?? 0,
			checkpointSeq: this.checkpointSeq,
			timestamp: Date.now(),
		};
		this.hooks.sendFollowUp(checkpointTriggerPrompt(goal.id, goal.status), details as unknown as Record<string, unknown>);
	}

	/**
	 * Hold the follow-up while background work is active. Returns true when the
	 * continuation was rescheduled (still held), false when the send may
	 * proceed: quiescent registries, a probe that cannot answer, or the
	 * deferral cap reached (a lost/husk run must not stall the goal forever).
	 */
	private async deferWhileBackgroundWorkActive(ctx: ExtensionContext, scheduledGoalId: string, epoch: number): Promise<boolean> {
		const probe = this.hooks.hasActiveBackgroundWork;
		if (!probe) return false;
		let active = false;
		try {
			active = await probe();
		} catch {
			active = false; // uncertain detection must never stall the goal
		}
		if (epoch !== this.continuationEpoch) return true; // superseded while probing
		if (!active) {
			this.backgroundDeferralSince = null;
			return false;
		}
		const since = this.backgroundDeferralSince ?? Date.now();
		if (Date.now() - since >= MAX_BACKGROUND_DEFERRAL_MS) {
			this.backgroundDeferralSince = null;
			try {
				ctx.ui.notify(
					`Goal continuation deferred ${Math.round(MAX_BACKGROUND_DEFERRAL_MS / 60_000)}m by active background work; resuming the goal now.`,
					"warning",
				);
			} catch {
				// Notify is best-effort; the fallback send itself must not fail.
			}
			return false;
		}
		this.backgroundDeferralSince = since;
		this.continuationScheduledFor = scheduledGoalId;
		this.continuationTimer = setTimeout(() => void this.sendQueuedContinuation(ctx, scheduledGoalId, epoch), BACKGROUND_BUSY_POLL_MS);
		this.continuationTimer.unref?.();
		return true;
	}

	// ── turn-stop guard ──────────────────────────────────────────────────

	advanceTurn(): void {
		this.turnSeq += 1;
		if (this.turnStoppedFor?.turnSeq !== this.turnSeq) this.turnStoppedFor = null;
	}

	/** Mark the current turn stopped after a terminal/mutating goal tool. */
	markTurnStopped(goalId: string): void {
		this.turnStoppedFor = { goalId, turnSeq: this.turnSeq };
	}

	/** Goal id that stopped the current turn, or null. Stale markers are dropped. */
	currentTurnStoppedGoalId(): string | null {
		if (!this.turnStoppedFor) return null;
		if (this.turnStoppedFor.turnSeq !== this.turnSeq) {
			this.turnStoppedFor = null;
			return null;
		}
		return this.turnStoppedFor.goalId;
	}

	// ── stale checkpoint state ───────────────────────────────────────────

	setCheckpoint(goalId: string | null): void {
		this.checkpointGoalId = goalId;
	}

	getCheckpointGoalId(): string | null {
		return this.checkpointGoalId;
	}

	/** Tools blocked when a stale checkpoint triggered the current turn. */
	isStaleCheckpointBlocked(toolName: string): boolean {
		return !POST_STOP_ALLOWED.has(toolName);
	}

	// ── one-time steering reminders ──────────────────────────────────────

	armPostCompactReminder(): void {
		this.postCompactReminderPending = true;
	}

	/** Whether a post-compaction reminder is pending (read-only). */
	isPostCompactReminderPending(): boolean {
		return this.postCompactReminderPending;
	}

	clearPostCompactReminder(): void {
		this.postCompactReminderPending = false;
	}

	/** True once if a post-compaction reminder is pending; clears it. */
	consumePostCompactReminder(): boolean {
		if (!this.postCompactReminderPending) return false;
		this.postCompactReminderPending = false;
		return true;
	}

	armPostBudgetReminder(): void {
		this.postBudgetReminderPending = true;
	}

	/** True once if a post-budget-limit reminder is pending; clears it. */
	consumePostBudgetReminder(): boolean {
		if (!this.postBudgetReminderPending) return false;
		this.postBudgetReminderPending = false;
		return true;
	}
}
