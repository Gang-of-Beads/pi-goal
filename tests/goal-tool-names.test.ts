import assert from "node:assert/strict";
import test from "node:test";

import {
	ALL_REGISTERED_GOAL_TOOLS,
	CORE_GOAL_TOOL_NAMES,
	CORE_GOAL_TOOLS,
	CREATE_GOAL_TOOL_NAME,
	DRAFTING_GOAL_TOOLS,
	FIVE_GOAL_TOOLS,
	FOCUS_GOAL_TOOL_NAME,
	UNFOCUS_GOAL_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	GOAL_WORK_TOOL_NAMES,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	TASK_TOOL_NAMES,
	UPDATE_GOAL_TASK_TOOL_NAME,
	UPDATE_GOAL_TOOL_NAME,
} from "../extensions/goal-tool-names.ts";

// The steady execution surface. Focus control joined it because focus was
// otherwise a user-only capability: an agent holding no goal could not take an
// existing one, and create_goal - its only other move - adds a second open goal
// describing the same work. The profile stays fixed; what changed is its
// membership, not whether it varies by lifecycle phase.
const CORE = ["create_goal", "get_goal", "update_goal", "focus_goal", "unfocus_goal"];

// Drafting tools belong to the separate transient user-started draft profile,
// never to the steady three/five execution surface.
const DRAFTING = ["goal_question", "goal_questionnaire", "propose_goal_draft"];

// Removed steady-state lifecycle tools — none may exist in the module.
const REMOVED_STEADY = [
	"propose_goal_tweak", "step_complete", "abort_goal", "propose_task_list",
	"complete_task", "skip_task", "complete_goal", "pause_goal",
];

test("the public tool names are preserved", () => {
	assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
	assert.equal(GET_GOAL_TOOL_NAME, "get_goal");
	assert.equal(UPDATE_GOAL_TOOL_NAME, "update_goal");
	assert.equal(SET_GOAL_TASKS_TOOL_NAME, "set_goal_tasks");
	assert.equal(UPDATE_GOAL_TASK_TOOL_NAME, "update_goal_task");
	assert.equal(FOCUS_GOAL_TOOL_NAME, "focus_goal");
	assert.equal(UNFOCUS_GOAL_TOOL_NAME, "unfocus_goal");
});

test("fixed profiles: core five, task two, all seven registered", () => {
	assert.deepEqual(CORE_GOAL_TOOL_NAMES, CORE);
	assert.deepEqual(TASK_TOOL_NAMES, ["set_goal_tasks", "update_goal_task"]);
	assert.deepEqual(FIVE_GOAL_TOOLS, [...CORE, ...TASK_TOOL_NAMES]);
	assert.deepEqual(CORE_GOAL_TOOLS, CORE);
	assert.deepEqual(DRAFTING_GOAL_TOOLS, DRAFTING);
	// The registry is the fixed execution set plus the transient drafting
	// profile; the INSTALLED profile (installGoalToolProfile) still only ever
	// installs the execution set, never a phase-dependent subset.
	assert.deepEqual(ALL_REGISTERED_GOAL_TOOLS, [...FIVE_GOAL_TOOLS, ...DRAFTING_GOAL_TOOLS]);
});

test("the module declares drafting names only in the transient profile", () => {
	assert.equal(QUESTION_TOOL_NAME, "goal_question");
	assert.equal(QUESTIONNAIRE_TOOL_NAME, "goal_questionnaire");
	assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	// Drafting tools must never leak into the fixed execution profiles.
	for (const name of DRAFTING) {
		assert.equal(CORE_GOAL_TOOL_NAMES.includes(name as never), false, `${name} must not be a core tool`);
		assert.equal(TASK_TOOL_NAMES.includes(name as never), false, `${name} must not be a task tool`);
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(name as never), false, `${name} must not be a work tool`);
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as never), false, `${name} must not be a progress tool`);
	}
});

test("no steady-state lifecycle tools or phase heuristics remain", async () => {
	const fs = await import("node:fs/promises");
	const source = await fs.readFile("extensions/goal-tool-names.ts", "utf8");
	for (const removed of REMOVED_STEADY) {
		assert.ok(!source.includes(`const ${removed.toUpperCase().replace(/-/g, "_")}_TOOL_NAME`),
			`removed constant ${removed} must not exist in goal-tool-names.ts`);
	}
	assert.ok(!source.includes("GoalToolPhase"), "GoalToolPhase must be gone");
	assert.ok(!source.includes("lifecycleToolNamesForGoalStatus"), "lifecycleToolNamesForGoalStatus must be gone");
	assert.ok(!source.includes("isQuestionLikeToolName"), "question heuristics must be gone");
});

test("progress tool set excludes read-only surface tools and workhorse includes them", () => {
	for (const name of ["get_goal", "create_goal"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false, name);
	}
	for (const name of [UPDATE_GOAL_TOOL_NAME, UPDATE_GOAL_TASK_TOOL_NAME, "write", "edit", "bash", "read"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), true, name);
	}
});

// Choosing which goal to work on is not working on it. The empty-turn gate asks
// "did this turn do anything for the goal"; a turn that only took or released
// focus did not, and counting it would let a session keep waking itself by
// re-focusing.
const FOCUS_CONTROL = [FOCUS_GOAL_TOOL_NAME, UNFOCUS_GOAL_TOOL_NAME];

test("work tool set covers the goal work tools plus common host work tools", () => {
	for (const name of FIVE_GOAL_TOOLS) {
		if (FOCUS_CONTROL.includes(name)) continue;
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), `work set must include ${name}`);
	}
	for (const name of FOCUS_CONTROL) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), false,
			`focus control ${name} must not count as goal work`);
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false,
			`focus control ${name} must not count as goal progress`);
	}
	for (const name of ["bash", "write", "read", "edit", "grep", "find", "ls"]) {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), `work set must include ${name}`);
	}
	for (const removed of REMOVED_STEADY) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(removed as typeof GOAL_WORK_TOOL_NAMES[number]), false,
			`work set must not include ${removed}`);
	}
	for (const name of DRAFTING) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), false,
			`steady work set must not include drafting tool ${name}`);
	}
});

test("POST_STOP_ALLOWED_TOOLS covers state reads and lifecycle control only", () => {
	// A stopped turn must not do work, but it must still be able to read the
	// goal and change its lifecycle: without update_goal here a paused goal can
	// never be resumed by the agent, so "continue the goal" would depend on the
	// user running a slash command.
	assert.deepEqual([...POST_STOP_ALLOWED_TOOLS].sort(), ["get_goal", "update_goal"]);
	// Execution tools stay blocked: a stopped turn reports and yields, it does
	// not keep editing the workspace.
	for (const name of ["write", "edit", "bash", "read", "grep", "find", "ls"]) {
		assert.equal(POST_STOP_ALLOWED_TOOLS.includes(name as typeof POST_STOP_ALLOWED_TOOLS[number]), false,
			`post-stop allowlist must not include execution tool ${name}`);
	}
});
