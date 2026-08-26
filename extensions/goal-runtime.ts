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
import type { GoalCheckpointDetailsV2, GoalRecord } from "./goal-record.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { POST_STOP_ALLOWED_TOOLS } from "./goal-tool-names.ts";
import { networkErrorBackoffPlan, type NetworkErrorBackoffPlan } from "./network-error-backoff.ts";

export const CONTINUATION_IDLE_RETRY_MS = 50;

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

const POST_STOP_ALLOWED = new Set<string>(POST_STOP_ALLOWED_TOOLS);

export interface GoalRuntimeHooks {
	/** Dispatch a hidden follow-up checkpoint message (pi.sendMessage + triggerTurn). */
	sendFollowUp(content: string, details: Record<string, unknown>): void;
	/** Current focused goal (state.goal). */
	getGoal(): GoalRecord | null;
	/** Whether a checkpointed goal id is still actionable (active + autoContinue). */
	isActionable(goalId: string | null | undefined): boolean;
}

export class GoalRuntime {
	// ── continuation scheduling ──────────────────────────────────────────
	private continuationQueuedFor: string | null = null;
	private continuationScheduledFor: string | null = null;
	private continuationTimer: ReturnType<typeof setTimeout> | null = null;
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
		if (resetNetworkErrorBackoff) this.clearNetworkErrorBackoff();
	}

	/** Clear the pending timer but keep the queued marker (used at session shutdown). */
	clearContinuationTimer(): void {
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
		this.clearContinuationTimer();
		let delay = CONTINUATION_IDLE_RETRY_MS;
		try {
			delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : CONTINUATION_IDLE_RETRY_MS;
		} catch {
			return;
		}
		this.continuationScheduledFor = goalId;
		this.continuationTimer = setTimeout(() => this.sendQueuedContinuation(ctx, goalId), delay);
		this.continuationTimer.unref?.();
	}

	/** Deterministic entry point for the scheduled send, so tests need no timers. */
	flushContinuationForTest(ctx: ExtensionContext, goalId: string): void {
		this.sendQueuedContinuation(ctx, goalId);
	}

	/** Cancel a pending continuation for a goal id (e.g. after update/clear/focus change). */
	cancelContinuationFor(goalId: string): void {
		if (this.continuationQueuedFor === goalId) this.continuationQueuedFor = null;
		if (this.continuationScheduledFor === goalId) this.clearContinuationState();
		if (this.networkErrorRetryGoalId === goalId) this.clearNetworkErrorBackoff();
	}

	/**
	 * Schedule the next bounded recovery after Pi's built-in provider retries
	 * have failed. The counter stays in memory and is cleared on a successful
	 * turn or any user-owned cancellation path.
	 */
	scheduleNetworkErrorRetry(ctx: ExtensionContext, goal: GoalRecord): NetworkErrorBackoffPlan | null {
		if (goal.status !== "active" || !goal.autoContinue || this.networkErrorRetryTimer) return null;
		if (this.networkErrorRetryGoalId !== goal.id) {
			this.networkErrorRetryGoalId = goal.id;
			this.networkErrorRetryAttempt = 0;
		}
		const plan = networkErrorBackoffPlan(this.networkErrorRetryAttempt + 1);
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
	private sendQueuedContinuation(ctx: ExtensionContext, scheduledGoalId: string): void {
		this.continuationTimer = null;
		this.continuationScheduledFor = null;
		if (!this.hooks.isActionable(scheduledGoalId)) {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			return;
		}

		let ready: boolean;
		try {
			ready = !ctx.hasPendingMessages() && ctx.isIdle();
		} catch {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			return;
		}

		if (!ready) {
			this.continuationScheduledFor = scheduledGoalId;
			this.continuationTimer = setTimeout(() => this.sendQueuedContinuation(ctx, scheduledGoalId), CONTINUATION_IDLE_RETRY_MS);
			this.continuationTimer.unref?.();
			return;
		}
		const goal = this.hooks.getGoal();
		if (!goal || goal.id !== scheduledGoalId) {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
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
			return;
		}
		this.checkpointSeq += 1;
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
