import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokenValue, statusLabel, truncateText } from "./goal-core.ts";
import { extractVerificationContract } from "./goal-contract.ts";
import { detailedSummary, goalDetails, renderGoalResult } from "./goal-format.ts";
import { budgetLine } from "./goal-accounting.ts";
import { buildGoalCreatedReport, buildTaskSummary, findTaskInTree, validateGoalAgentPause, validateGoalBlock, validateResumeGoal } from "./goal-policy.ts";
import { buildUnfocusedOpenGoalsSummary, otherOpenGoalCount } from "./goal-pool.ts";
import { readGoalLedger } from "./goal-ledger.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { buildGoalHistoryBlock, buildGoalTaskDetailBlock } from "./goal-format.ts";
import { sisyphusStepProgress } from "./goal-policy.ts";
import { deriveTasksFromObjective } from "./goal-task-derive.ts";
import { nowIso, type GoalRecord, type GoalTask, validateTokenBudgetInput } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";
import { promptProfile } from "./prompts/goal-prompts.ts";
import {
	armOracleAdvice,
	buildBlockerFingerprint,
	consumeOracleFollowupMarker,
	hasPendingOracleAdviceForFocusedGoal,
	oracleStateForFingerprint,
	renderActionableOracleAdvice,
	renderOracleAdviceReminder,
	runBlockerOracle,
} from "./goal-oracle.ts";
import { loadSettingsSnapshot, type ResolvedGoalOracleSettings } from "./goal-settings.ts";

/** Current + first-pending (excluding current) task pointers for concise get_goal. */
function conciseTaskPointers(goal: GoalRecord): { findCurrentTask?: GoalTask; firstPendingTask?: GoalTask } {
	if (!goal.taskList) return {};
	let firstPendingTask: GoalTask | undefined;
	const walk = (tasks: GoalTask[]): void => {
		for (const t of tasks) {
			if (!firstPendingTask && t.status === "pending" && t.id !== goal.currentTaskId) firstPendingTask = t;
			if (t.subtasks) walk(t.subtasks);
		}
	};
	walk(goal.taskList.tasks);
	const findCurrentTask = goal.currentTaskId ? findTaskInTree(goal.taskList.tasks, goal.currentTaskId) : undefined;
	return { findCurrentTask, firstPendingTask };
}

export function registerCoreTools(
	core: GoalCore,
	deps: {
		runGoalCompletionFlow: (core: GoalCore, ctx: ExtensionContext, completionSummary?: string) => Promise<AgentToolResult<unknown>>;
	},
): void {
	const { pi } = core;

pi.registerTool(defineTool({
	name: "get_goal",
	label: "Get Goal",
	description: "Get the current pi goal for this session: objective, status, auto-continue, usage, and local file paths.",
	promptSnippet: "Read the active pi goal state for the current session.",
	promptGuidelines: [
		"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
	],
	parameters: Type.Object({
		verbose: Type.Optional(Type.Boolean({ description: "Full detail mode." })),
		include_history: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		core.reconcileFocusedGoalFromDisk(ctx);
		if (core.state.goal) core.syncGoalPromptFromDisk(ctx);
		const view = core.goalForDisplay() ?? core.state.goal;
		const params = (_params ?? {}) as { verbose?: boolean; include_history?: boolean };
		// PR E profile: legacy-v1 keeps pre-optimization verbose-by-default output;
		// compact-v2 (default) returns a concise state line set because the full
		// policy already lives in the injected active-goal system block.
		const verbose = promptProfile() === "legacy-v1" || params.verbose === true;
		const includeHistory = params.include_history === true || verbose;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		if (!view) {
			const text = core.openGoals().length > 0
				? `${buildUnfocusedOpenGoalsSummary(core.openGoals().length)}\n\nCall create_goal with the objective to create and focus a new goal, or ask the user to run /goal-focus to choose an open goal.`
				: "No goal is set in this session. Call create_goal with the objective when the user explicitly asks to start a persistent goal.";
			return {
				content: [{ type: "text", text }],
				details: goalDetails(view),
			};
		}
		if (verbose) {
			const lines: string[] = [`Goal ${view.id}: ${statusLabel(view)}, ${view.sisyphus ? "sisyphus" : "regular"}`];
			lines.push(`Objective: ${view.objective}`, "");
			lines.push(`Status: ${statusLabel(view)}`);
			lines.push(`Mode: ${view.sisyphus ? "sisyphus" : "regular"}`);
			if (view.sisyphus) {
				// E6: sisyphus ordered-step progress.
				const steps = sisyphusStepProgress(view);
				if (steps) lines.push(`At step: ${steps.current} of ${steps.total}`);
			}
			const usageBits: string[] = [];
			if (view.usage.activeSeconds > 0) usageBits.push(formatDuration(view.usage.activeSeconds));
			if (view.usage.tokensUsed > 0) usageBits.push(formatTokenValue(view.usage.tokensUsed));
			lines.push(`Usage: ${usageBits.length > 0 ? usageBits.join(" · ") : "none"}`);
			const budget = budgetLine(view);
			if (budget) lines.push(`Budget: ${budget}`);
			if (view.taskList) {
				lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
				// F1: task-detail block mirroring the widget.
				const detail = buildGoalTaskDetailBlock(view);
				if (detail) lines.push("", detail);
			}
			if (view.verificationContract?.trim()) lines.push(`Verification contract: ${view.verificationContract.trim()}`);
			if (view.status === "paused" || view.status === "blocked") {
				if (view.pauseReason) lines.push(`Blocker: ${view.pauseReason}`);
				if (view.pauseSuggestedAction) lines.push(`Suggested action: ${view.pauseSuggestedAction}`);
			}
			if (view.activePath) lines.push(`Path: ${view.activePath}`);
			if (view.archivedPath) lines.push(`Archive: ${view.archivedPath}`);
			if (otherCount > 0) lines.push(`Other open goals: ${otherCount} (user can run /goal-list or /goal-focus)`);
			lines.push("");
			lines.push("Lifecycle: call update_goal({status: \"complete\"}) only when every requirement is satisfied — the independent auditor verifies from actual evidence. Call update_goal({status: \"blocked\"}) only after the same blocker recurs on three consecutive goal turns. User commands handle pause/resume/clear/focus.");
			// E1: goal history (last audit verdict + recent lifecycle events).
			if (includeHistory) {
				const history = buildGoalHistoryBlock(view, readGoalLedger(ctx).events);
				if (history) lines.push("", history);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: goalDetails(view),
			};
		}

		// compact-v2 default (PR E §53): concise state read. The full objective
		// is kept — get_goal is an explicit state-read tool — but duplicated task
		// headings and the lifecycle prose (already in the injected policy) are
		// omitted.
		const lines: string[] = [`Goal ${view.id}: ${statusLabel(view)}, ${view.sisyphus ? "sisyphus" : "regular"}`];
		lines.push(`Objective: ${view.objective}`);
		if (view.taskList) {
			const { findCurrentTask, firstPendingTask } = conciseTaskPointers(view);
			if (findCurrentTask) {
				const contract = findCurrentTask.verificationContract ? ` — contract: ${findCurrentTask.verificationContract}` : "";
				lines.push(`Current task: ${findCurrentTask.id} — ${findCurrentTask.title}${contract}`);
			}
			if (firstPendingTask) {
				lines.push(`Next pending: ${firstPendingTask.id} — ${firstPendingTask.title}`);
			}
			lines.push(`Tasks: ${buildTaskSummary(view.taskList)}`);
		} else if (view.currentTaskId) {
			lines.push(`Current task: ${view.currentTaskId}`);
		}
		const budget = budgetLine(view);
		if (budget) lines.push(`Budget: ${budget}`);
		if ((view.status === "paused" || view.status === "blocked") && view.pauseReason) {
			lines.push(`Blocker: ${view.pauseReason}`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: goalDetails(view),
		};
	},
	renderCall(_args, theme) {
		return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, _options, theme);
	},
}));

pi.registerTool(defineTool({
	name: "create_goal",
	label: "Create Goal",
	description: "Create and focus a new pi goal after an explicit user request. Only call this when the user has explicitly asked to make something a persistent goal (directly, or via /goal or /sisyphus); do NOT infer a goal from an ordinary task. Creating a goal focuses it and leaves other open goals untouched.",
	promptSnippet: "Create a persistent pi goal only when the user explicitly asks for one.",
	promptGuidelines: [
		"Call create_goal only when the user explicitly asks to start a long-running goal or hands you a concrete objective to pursue. Never infer a goal from an ordinary one-off task.",
		"Creating a new goal focuses it and leaves other open goals untouched. Do not archive or replace existing goals unless the user explicitly asks through a user command.",
		"Pass mode=\"sisyphus\" only when the user explicitly invoked Sisyphus mode.",
	],
	parameters: Type.Object({
		objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input. Length is capped by the `max objective length` goal setting (0/unset = no limit)." }),
		mode: Type.Optional(StringEnum(["regular", "sisyphus"] as const, { description: "Goal mode. Defaults to regular. Use sisyphus only when the user explicitly invoked Sisyphus mode." })),
		token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Optional token budget in whole tokens. Accept it only when the user explicitly supplied a budget; never invent one." })),
	}, { additionalProperties: false }),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		core.reconcileFocusedGoalFromDisk(ctx);
		const objective = params.objective.trim();
		if (!objective) throw new Error("create_goal requires a non-empty objective.");
		const objectiveMaxChars = loadGoalSettings(ctx.cwd).objectiveMaxChars ?? 0;
		if (objectiveMaxChars > 0 && objective.length > objectiveMaxChars) {
			return {
				content: [{ type: "text", text: `create_goal objective exceeds ${objectiveMaxChars} characters (${objective.length}). Shorten the objective or raise the max objective length setting.` }],
				details: goalDetails(core.state.goal),
			};
		}
		const sisyphusFlag = params.mode === "sisyphus";
		let tokenBudget: number | undefined;
		if (params.token_budget !== undefined) {
			// Tool callers are untrusted: re-validate the budget beyond the schema.
			const budgetGate = validateTokenBudgetInput(params.token_budget);
			if (!budgetGate.ok) {
				return {
					content: [{ type: "text", text: budgetGate.message }],
					details: goalDetails(core.state.goal),
				};
			}
			tokenBudget = budgetGate.value;
		}
		const { objective: cleanedObjective, verificationContract } = extractVerificationContract(objective);
		core.replaceGoal(
			{ objective: cleanedObjective, autoContinue: true, sisyphus: sisyphusFlag },
			ctx,
			true,
			verificationContract,
			tokenBudget,
		);
		const created = core.state.goal;
		const otherCount = otherOpenGoalCount(core.goalsById, core.focusedGoalId);
		const otherLine = otherCount > 0
			? `\n${otherCount} other open goal${otherCount === 1 ? "" : "s"} remain in .pi/goals — this goal is now the session focus.`
			: "";
		// F2: the agent path stays tool-driven — surface the derivable task plan
		// as guidance so the agent proposes it via set_goal_tasks.
		const derived = !created?.taskList ? deriveTasksFromObjective(cleanedObjective) : null;
		const bootstrapLine = derived && derived.length > 0
			? `\n\nThe objective contains ${derived.length} ordered step${derived.length === 1 ? "" : "s"}; propose them as the task tree with set_goal_tasks if the user wants tracked milestones.`
			: "";
		return {
			content: [{ type: "text", text: `${buildGoalCreatedReport({ objective: created?.objective ?? objective, detailedSummary: detailedSummary(created) })}${bootstrapLine}${otherLine}` }],
			details: goalDetails(created),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		const prefix = args?.mode === "sisyphus" ? "create_goal sisyphus " : "create_goal ";
		return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, _options, theme);
	},
}));

	// ── update_goal: the model's terminal-outcome surface (Stage 3) ────────
// complete → the independent auditor verifies from actual evidence (no
// paperwork field); blocked → a distinct agent-blocked state that stops
// continuation. The three-consecutive-turn blocker rule is prompt policy.
	async function runGoalBlockedFlow(ctx: ExtensionContext, reasonInput?: string, attemptedActions: string[] = []): Promise<AgentToolResult<unknown>> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateGoalBlock({ goal: core.state.goal, runningGoalId: core.runningGoalId });
	if (!gate.ok) {
		return {
			content: [{ type: "text", text: gate.message }],
			details: goalDetails(core.state.goal),
		};
	}
	if (!core.state.goal) throw new Error("Goal disappeared during blocked validation.");

	// Issue #26: the blocker reason is now required for update_goal(blocked) —
	// it feeds the fingerprint, the ledger event, and the user-facing report.
	const reason = reasonInput?.trim() ?? "";
	if (!reason) {
		return {
			content: [{ type: "text", text: 'update_goal({ status: "blocked" }) requires a "reason" describing the concrete blocker. The goal remains active.' }],
			details: goalDetails(core.state.goal),
			terminate: false,
		};
	}

	const commitBlocked = (): AgentToolResult<unknown> => {
		const result = core.goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({
				...g,
				status: "blocked" as const,
				stopReason: "agent" as const,
				pauseReason: reason,
				updatedAt: nowIso(),
			}),
			ledger: (written) => [{
				type: "goal_blocked",
				goalId: written.id,
				reason: written.pauseReason ?? "blocked",
				source: "agent",
				at: written.updatedAt,
			}],
		});
		if (!result.ok) {
			return {
				content: [{ type: "text", text: `Goal blocked state update failed: ${result.message ?? "the state mutation was rejected"}. The goal was NOT marked blocked. Retry after resolving the conflict.` }],
				details: goalDetails(core.state.goal),
				terminate: false,
			};
		}
		core.clearContinuationState();
		core.clearActiveAccounting();
		if (result.goal) core.runtime.markTurnStopped(result.goal.id);
		core.updateUI(ctx);
		return {
			content: [{
				type: "text",
				text: "Goal blocked. Continuation stopped; the goal is waiting for the user to resume, revise, or clear it. Stop now; do not start another tool call.",
			}],
			details: goalDetails(core.state.goal),
			terminate: true,
		};
	};

	// Oracle disabled: existing block transition, unchanged behavior.
	const settingsSnapshot = loadSettingsSnapshot(ctx.cwd);
	const oracleSettings = settingsSnapshot.value.oracle;
	if (!oracleSettings?.enabled) return commitBlocked();

	// ── opt-in Oracle flow (issue #26) ───────────────────────────────────
	const goalAtBlock = core.state.goal;
	const focusToken = core.focusedOperationToken(goalAtBlock.id);
	const fingerprint = buildBlockerFingerprint(goalAtBlock, reason);
	const consult = oracleStateForFingerprint(readGoalLedger(ctx).events, goalAtBlock.id, fingerprint);

	// One actionable result already exists.
	if (consult.result?.disposition === "actionable") {
		if (!consult.followupAttempted && !hasPendingOracleAdviceForFocusedGoal(goalAtBlock.id)) {
			// Re-arm without consulting again and refuse the block.
			const adviceText = renderOracleAdviceReminder({
				goalId: goalAtBlock.id,
				fingerprint,
				adviceId: consult.result.adviceId,
				text: consult.result.summary,
			});
			return {
				content: [{ type: "text", text: `${adviceText}\n\nThe goal was NOT marked blocked.` }],
				details: goalDetails(goalAtBlock),
				terminate: false,
			};
		}
		return commitBlocked();
	}
	if (consult.result?.disposition === "needs_human" || consult.result?.disposition === "insufficient_context") {
		return commitBlocked();
	}
	if (consult.failedAttempts >= oracleSettings.maxFailedAttemptsPerBlocker) {
		try {
			core.goalService.appendEvents(ctx, [{
				type: "oracle_failed",
				goalId: goalAtBlock.id,
				fingerprint,
				attempt: consult.failedAttempts,
				errorCode: consult.lastFailure?.errorCode ?? "provider",
				message: "failure limit reached; blocking with durable Oracle failure annotation",
				at: nowIso(),
			}]);
		} catch { /* best-effort annotation */ }
		return commitBlocked();
	}

	// Consult once.
	try {
		core.goalService.appendEvents(ctx, [{
			type: "oracle_started",
			goalId: goalAtBlock.id,
			fingerprint,
			provider: oracleSettings.provider ?? "(unresolved)",
			model: oracleSettings.model ?? "(unresolved)",
			thinkingLevel: oracleSettings.thinkingLevel,
			reason: reason.slice(0, 1000),
			at: nowIso(),
		}]);
	} catch { /* ledger append is best-effort for the started marker */ }

	const run = await runBlockerOracle({
		ctx,
		goal: goalAtBlock,
		reason,
		attemptedActions: attemptedActions.slice(0, 8),
		settings: oracleSettings as ResolvedGoalOracleSettings,
		recentEvidence: "",
	});

	if (!core.isFocusedOperationCurrent(focusToken)) {
		return core.focusedOperationCancelledResult("Blocker Oracle", focusToken);
	}

	if (!run.ok) {
		if (run.errorCode === "aborted") {
			try {
				core.goalService.appendEvents(ctx, [{
					type: "oracle_failed",
					goalId: goalAtBlock.id,
					fingerprint,
					attempt: consult.failedAttempts + 1,
					errorCode: "aborted",
					message: run.message.slice(0, 300),
					at: nowIso(),
				}]);
			} catch { /* best effort */ }
			return {
				content: [{ type: "text", text: "Oracle consultation was aborted; the goal remains active." }],
				details: goalDetails(goalAtBlock),
				terminate: false,
			};
		}
		try {
			core.goalService.appendEvents(ctx, [{
				type: "oracle_failed",
				goalId: goalAtBlock.id,
				fingerprint,
				attempt: consult.failedAttempts + 1,
				errorCode: run.errorCode,
				message: run.message.slice(0, 300),
				at: nowIso(),
			}]);
		} catch { /* best effort */ }
		const retryable = consult.failedAttempts + 1 < oracleSettings.maxFailedAttemptsPerBlocker;
		return {
			content: [{ type: "text", text: `Oracle consultation failed (${run.errorCode}): ${run.message.slice(0, 200)}${retryable ? " The goal remains active; try again or continue working." : ""}` }],
			details: goalDetails(goalAtBlock),
			terminate: false,
		};
	}

	// Persist bounded result + arm/remind per disposition.
	const advice = run.advice;
	const adviceId = armOracleAdvice(goalAtBlock.id, fingerprint, advice);
	const recommendedTitle = advice.alternatives[advice.recommendedIndex]?.title;
	try {
		core.goalService.appendEvents(ctx, [{
			type: "oracle_result",
			goalId: goalAtBlock.id,
			fingerprint,
			adviceId,
			disposition: advice.disposition,
			summary: advice.diagnosis.slice(0, 500),
			recommendedTitle: recommendedTitle?.slice(0, 200),
			at: nowIso(),
		}]);
	} catch { /* best effort */ }

	if (advice.disposition === "needs_human" || advice.disposition === "insufficient_context") {
		consumeOracleFollowupMarker(goalAtBlock.id);
		return commitBlocked();
	}

	return {
		content: [{ type: "text", text: renderActionableOracleAdvice(advice) }],
		details: goalDetails(goalAtBlock),
		terminate: false,
	};
}

/**
 * Agent-initiated immediate pause (Stage 5.1-C): update_goal({status:
 * "paused"}) with a required reason pauses an active goal right away and
 * records goal_paused with source "agent". It is distinct from blocked
 * (three-consecutive-turn gate) and from the user-owned pause/resume
 * commands.
 */
async function runGoalAgentPauseFlow(ctx: ExtensionContext, reason: string | undefined, suggestedAction: string | undefined): Promise<AgentToolResult<unknown>> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateGoalAgentPause({ goal: core.state.goal, runningGoalId: core.runningGoalId });
	if (!gate.ok) {
		return { content: [{ type: "text", text: gate.message }], details: goalDetails(core.state.goal) };
	}
	const trimmedReason = reason?.trim() ?? "";
	if (!trimmedReason) {
		return { content: [{ type: "text", text: 'update_goal({ status: "paused" }) requires a "reason" describing why the work is pausing.' }], details: goalDetails(core.state.goal) };
	}
	if (!core.state.goal) throw new Error("Goal disappeared during pause validation.");
	core.accountProgress(ctx);
	const trimmedAction = suggestedAction?.trim();
	const result = core.goalService.apply(ctx, {
		reconcile: false,
		refreshFromDisk: true,
		mutate: (g) => ({
			...g,
			status: "paused" as const,
			autoContinue: false,
			stopReason: "agent" as const,
			pauseReason: trimmedReason,
			pauseSuggestedAction: trimmedAction || undefined,
			updatedAt: nowIso(),
		}),
		ledger: (written) => [{
			type: "goal_paused" as const,
			goalId: written.id,
			reason: written.pauseReason ?? trimmedReason,
			suggestedAction: written.pauseSuggestedAction,
			source: "agent",
			at: written.updatedAt,
		}],
	});
	if (result.ok) {
		core.clearContinuationState();
		core.clearActiveAccounting();
		if (result.goal) core.runtime.markTurnStopped(result.goal.id);
		core.updateUI(ctx);
		const suggestion = trimmedAction ? ` Suggested next step: ${trimmedAction}` : "";
		return {
			content: [{ type: "text", text: `Goal paused by the agent: ${trimmedReason}.${suggestion} Stop now; the user can resume with /goal-resume or revise with /goal-tweak.` }],
			details: goalDetails(core.state.goal, `Pause reason: ${trimmedReason}${trimmedAction ? `\nSuggested action: ${trimmedAction}` : ""}`), // E7
			terminate: true,
		};
	}
	// The mutation failed: surface the conflict instead of claiming the goal is
	// paused, and keep the turn alive so the agent can retry.
	return {
		content: [{ type: "text", text: `Goal pause update failed: ${result.message ?? "the state mutation was rejected"}. The goal was NOT paused. Retry after resolving the conflict.` }],
		details: goalDetails(core.state.goal),
		terminate: false,
	};
}

/**
 * Agent-owned resume: update_goal({status: "active"}) restarts a goal the
 * agent (or the user) paused, so "continue the goal" is something the agent
 * can act on with its own tool instead of waiting for /goal-resume. The
 * mutation mirrors the resume command exactly - status, continuation flag and
 * every stale pause field - and records goal_resumed with source "agent".
 */
async function runGoalAgentResumeFlow(ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const gate = validateResumeGoal(core.state.goal);
	if (!gate.ok) {
		return { content: [{ type: "text", text: gate.message }], details: goalDetails(core.state.goal) };
	}
	if (!core.state.goal) throw new Error("Goal disappeared during resume validation.");
	const result = core.goalService.apply(ctx, {
		reconcile: false,
		refreshFromDisk: true,
		mutate: (g) => ({
			...g,
			status: "active" as const,
			autoContinue: true,
			stopReason: undefined,
			pauseReason: undefined,
			pauseSuggestedAction: undefined,
			updatedAt: nowIso(),
		}),
		ledger: (written) => [{
			type: "goal_resumed" as const,
			goalId: written.id,
			reason: "agent",
			at: written.updatedAt,
		}],
	});
	if (result.ok) {
		core.beginAccounting();
		core.updateUI(ctx);
		core.queueContinuation(ctx, true);
		return {
			content: [{ type: "text", text: "Goal resumed. Continue the objective now; the checkpoint loop is armed again." }],
			details: goalDetails(core.state.goal),
			terminate: false,
		};
	}
	// The mutation failed: say so instead of claiming the goal is running, and
	// keep the turn alive so the agent can retry.
	return {
		content: [{ type: "text", text: `Goal resume failed: ${result.message ?? "the state mutation was rejected"}. The goal is NOT active.` }],
		details: goalDetails(core.state.goal),
		terminate: false,
	};
}

pi.registerTool(defineTool({
	name: "update_goal",
	label: "Update Goal",
	description: "Report a terminal or pausing outcome for the current run: \"complete\" runs the independent completion auditor (completion_summary is an untrusted claim only); \"blocked\" records a distinct agent-blocked state and stops continuation per the active-goal policy; \"paused\" pauses immediately with a required reason. Never archive or abandon a goal yourself — ask the user to run /goal-clear.",
	promptSnippet: "Report the current run as complete (audited) or blocked per the active-goal lifecycle policy; paused is immediate with a required reason.",
	promptGuidelines: [
		// PR E §54: capability + hard boundary here; the WHEN rules (evidence,
		// third-identical-blocker, objective immutability) live once in the
		// canonical active-goal policy block — do not restate them in all four
		// schema surfaces.
		"An optional completion_summary is passed to the auditor as an UNTRUSTED claim — it is never evidence and can never substitute for real artifacts.",
	],
	parameters: Type.Object({
		status: StringEnum(["complete", "blocked", "paused", "active"] as const, { description: "complete runs the independent auditor; blocked records a distinct agent-blocked state; paused is an immediate agent pause with a required reason." }),
		reason: Type.Optional(Type.String({ description: "Required when status is paused or blocked: describe the concrete blocker." })),
		attempted_actions: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 8, description: "Optional: up to 8 concrete actions already attempted against this blocker." })),
		suggested_action: Type.Optional(Type.String({ description: "Optional suggested next step when status is paused." })),
		completion_summary: Type.Optional(Type.String({ description: "Optional untrusted executor claim shown to the auditor; never evidence." })),
	}, { additionalProperties: false }),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		// P1-3: persist any buffered in-turn mutations now so the auditor and
		// status transitions observe the current task/state, not the stale disk.
		core.flushGoalTransaction(ctx);
		if (params.status === "blocked") {
			const attempted = Array.isArray((params as { attempted_actions?: unknown }).attempted_actions)
				? ((params as { attempted_actions: unknown[] }).attempted_actions.filter((a): a is string => typeof a === "string"))
				: [];
			return runGoalBlockedFlow(ctx, params.reason, attempted);
		}
		if (params.status === "paused") {
			return runGoalAgentPauseFlow(ctx, params.reason, params.suggested_action);
		}
		if (params.status === "active") {
			return runGoalAgentResumeFlow(ctx);
		}
		return deps.runGoalCompletionFlow(core, ctx, params.completion_summary);
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("muted", args?.status ?? ""), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, _options, theme);
	},
}));
}
