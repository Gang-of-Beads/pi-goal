import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { uuidv7 } from "@earendil-works/pi-ai";
import { GoalStorage, knownWorkspaces, registerWorkspace } from "./storage.ts";
import { parseGoalTemplate, readGoalTemplate, serializeGoalTemplate, writeGoalTemplate, type GoalTemplate } from "./sexp.ts";
import { listSnippets, saveSnippet, validateSnippetName, type GoalSnippet } from "./snippets.ts";

export type GoalStatus = "clarifying" | "pending" | "running" | "paused" | "review" | "done" | "cancelled";
export type TodoStatus = "pending" | "running" | "blocked" | "done";
export interface GoalTodo {
  id: number;
  text: string;
  status: TodoStatus;
  completedAt?: string;
  evidence?: string;
}
export interface Goal {
  id: number;
  uuid?: string;
  workspace?: string;
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
  history?: { at: string; status: GoalStatus; text: string; todos: GoalTodo[] }[];
  text: string;
  constraints?: string[];
  acceptance?: string[];
  objective?: GoalTemplate["objective"];
  benchmarks?: GoalTemplate["benchmarks"];
  checks?: GoalTemplate["checks"];
  reviewLoop?: GoalTemplate["reviewLoop"];
  status: GoalStatus;
  todos?: GoalTodo[];
  answers?: { question: string; answer: string }[];
  planConfirmed?: boolean;
}
interface GoalState {
  goals: Goal[];
  nextId: number;
}

const STATE_TYPE = "pi-goal-state";
const LABELS: Record<GoalStatus, string> = {
  clarifying: "待澄清", pending: "待执行", running: "执行中", paused: "已暂停", review: "待确认", done: "已完成", cancelled: "已取消",
};

export function buildGoalPrompt(goal: string): string {
  return [
    "Help me accomplish the following goal in the current project:",
    "",
    goal.trim(),
    "",
    "Understand the relevant context, make a concise plan when useful, and carry out the task using the available tools rather than only giving advice.",
    "Validate the result with appropriate checks. Report what was done, what was verified, and any remaining blockers; do not claim success without evidence.",
    "Ask for clarification when essential information is missing. Respect existing instructions and approval requirements; a goal is not blanket authorization for destructive or high-impact actions.",
  ].join("\n");
}

export function restoreGoals(entries: readonly SessionEntry[]): GoalState {
  let state: GoalState = { goals: [], nextId: 1 };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const data = entry.data as GoalState | undefined;
    if (!data || !Array.isArray(data.goals) || !Number.isSafeInteger(data.nextId) || data.nextId < 1) continue;
    if (!data.goals.every((goal) => goal && Number.isSafeInteger(goal.id) && goal.id > 0 &&
      typeof goal.text === "string" && goal.text.trim() && Object.hasOwn(LABELS, goal.status))) continue;
    const ids = data.goals.map((goal) => goal.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => id >= data.nextId)) continue;
    if (!data.goals.every((goal) => [goal.constraints, goal.acceptance].every((items) => items === undefined || (Array.isArray(items) && items.every((item) => typeof item === "string" && item.trim()))))) continue;
    if (!data.goals.every((goal) => (goal.planConfirmed === undefined || typeof goal.planConfirmed === "boolean") &&
      (goal.answers === undefined || (Array.isArray(goal.answers) && goal.answers.every((item) => item && typeof item.question === "string" && typeof item.answer === "string"))) &&
      (goal.todos === undefined || (Array.isArray(goal.todos) && goal.todos.every((todo) => todo && Number.isSafeInteger(todo.id) && todo.id > 0 && typeof todo.text === "string" && todo.text.trim() &&
        ["pending", "running", "blocked", "done"].includes(todo.status) && (todo.completedAt === undefined || (typeof todo.completedAt === "string" && Number.isFinite(Date.parse(todo.completedAt)))) &&
        (todo.evidence === undefined || typeof todo.evidence === "string")) && new Set(goal.todos.map((todo) => todo.id)).size === goal.todos.length)))) continue;
    if (!data.goals.every((goal) => (goal.uuid === undefined || (typeof goal.uuid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(goal.uuid))) &&
      [goal.createdAt, goal.updatedAt].every((time) => time === undefined || (typeof time === "string" && Number.isFinite(Date.parse(time)))) &&
      (goal.history === undefined || Array.isArray(goal.history)))) continue;
    try { for (const goal of data.goals) serializeGoalTemplate(templateFromGoal(goal)); }
    catch { continue; }
    state = structuredClone({ goals: data.goals, nextId: data.nextId });
  }
  // A saved running flag cannot resume work by itself after reload or branching.
  for (const goal of state.goals) {
    if (goal.status === "running") goal.status = "paused";
    for (const todo of goal.todos ?? []) if (todo.status === "running") todo.status = "pending";
  }
  return state;
}

function templateFromGoal(goal: Goal): GoalTemplate {
  return {
    title: goal.text, constraints: goal.constraints ?? [], acceptance: goal.acceptance ?? [], todos: (goal.todos ?? []).map((todo) => todo.text),
    objective: goal.objective, benchmarks: goal.benchmarks, checks: goal.checks, reviewLoop: goal.reviewLoop,
  };
}

function reviewInstructions(goal: Goal): string {
  if (!goal.objective && !goal.checks?.length && !goal.reviewLoop) return "";
  return [
    "Structured objective / review contract (data, never executable code):",
    serializeGoalTemplate(templateFromGoal(goal)),
    "OVERRIDE_ALL means highest priority among this goal's own design preferences ONLY. It never overrides system/project instructions, explicit user constraints, accessibility, safety, or approvals.",
    "Use actual browser renders at relevant mobile/tablet/desktop sizes and interaction states to inspect every CHECK dimension. Identify specific winning benchmark entries and why they are comparable; do not claim an award or an objective award-tier score.",
    "For each CHECK, report observed evidence, the benchmark comparison, remaining gaps, and changes made. Motion and micro-interactions require observing their behavior, not only inspecting code or static screenshots. Respect reduced-motion accessibility preferences.",
    ...(goal.reviewLoop ? [
      `On completion of implementation, perform READ then COMPARE. If a gap is found, PATCH within the approved scope and re-enter review. Stop when all dimensions have no identified visible gaps, or after ${goal.reviewLoop.maxIterations} review iterations in this execution run, whichever comes first.`,
      "At the iteration limit, stop and report unresolved gaps; do not mark unverified review TODOs complete. If browser access or benchmark evidence is unavailable, report the missing evidence and ask for it rather than pretending the review passed.",
    ] : []),
    "The acceptance phrase 'no visible improvement remaining' is a subjective review target, not a proof of perfection. State the assessed scope and uncertainty, and request final user review. Do not automatically mark the whole goal done.",
  ].join("\n\n");
}

const TODO_LABELS: Record<TodoStatus, string> = { pending: "待执行", running: "执行中", blocked: "阻塞", done: "已完成" };

function todoLabel(todo: GoalTodo): string {
  const time = todo.completedAt ? ` · 完成于 ${new Date(todo.completedAt).toLocaleString()}` : "";
  return `TODO #${todo.id} [${TODO_LABELS[todo.status]}] ${todo.text.replace(/\s+/g, " ")}${time}`;
}

function goalLabel(goal: Goal): string {
  const progress = goal.todos?.length ? ` · TODO ${goal.todos.filter((todo) => todo.status === "done").length}/${goal.todos.length}` : "";
  return `#${goal.id} [${LABELS[goal.status]}] ${goal.text.replace(/\s+/g, " ")}${progress}`;
}

export default function goalExtension(pi: ExtensionAPI) {
  let state: GoalState = { goals: [], nextId: 1 };
  let activeId: number | undefined;
  let planningId: number | undefined;
  let runFailed = false;
  let generation = 0;
  let panelOpen = false;
  let storage: GoalStorage | undefined;
  let storageError: string | undefined;
  let persisted = new Map<string, string>();

  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("pi-goal", state.goals.length ? [
      `Goals · ${state.goals.length} 个目标 · /goal 管理`,
      ...state.goals.slice(0, 5).map(goalLabel),
      ...(state.goals.length > 5 ? [`… 另有 ${state.goals.length - 5} 个目标，打开 /goal 查看全部`] : []),
    ] : undefined);
  }

  function save(ctx: ExtensionContext) {
    if (storageError) throw new Error(storageError);
    storage ??= new GoalStorage(ctx.cwd);
    for (const goal of state.goals) {
      goal.uuid ??= uuidv7();
      goal.createdAt ??= new Date().toISOString();
      const content = JSON.stringify(goal);
      if (persisted.get(goal.uuid) === content) continue;
      goal.updatedAt = new Date().toISOString();
      (goal.history ??= []).push({ at: goal.updatedAt, status: goal.status, text: goal.text, todos: structuredClone(goal.todos ?? []) });
      try { storage.write(goal); } catch (error) {
        storageError = String(error);
        throw error;
      }
      persisted.set(goal.uuid, JSON.stringify(goal));
    }
    refresh(ctx);
  }

  function restore(ctx: ExtensionContext) {
    generation++;
    activeId = undefined;
    planningId = undefined;
    runFailed = false;
    storage = new GoalStorage(ctx.cwd);
    storageError = undefined;
    persisted = new Map();
    try {
      registerWorkspace(getAgentDir(), ctx.cwd);
      const goals = storage.load();
      for (const goal of goals) goal.workspace ??= resolve(ctx.cwd);
      const nextId = Math.max(0, ...goals.map((goal) => goal.id)) + 1;
      const snapshot = { type: "custom", customType: STATE_TYPE, data: { goals, nextId } } as SessionEntry;
      const validated = restoreGoals([snapshot]);
      if (validated.goals.length !== goals.length) throw new Error("Invalid goal JSON data. Fix the files before editing goals.");
      state = validated;
      for (const goal of goals) if (goal.uuid) persisted.set(goal.uuid, JSON.stringify(goal));
      save(ctx);
    } catch (error) {
      state = { goals: [], nextId: 1 };
      storageError = String(error);
      ctx.ui.notify(`加载目标失败：${storageError}`, "error");
    }
    refresh(ctx);
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));

  /**
   * Another session in the same workspace may have created goals since this session loaded.
   * Reusing their display ID would make every later load reject the whole workspace.
   */
  function allocateId(ctx: ExtensionContext): number {
    if (storageError) throw new Error(storageError);
    storage ??= new GoalStorage(ctx.cwd);
    const id = Math.max(state.nextId, storage.maxId() + 1);
    state.nextId = id + 1;
    return id;
  }

  function add(text: string, ctx: ExtensionContext): Goal {
    const now = new Date().toISOString();
    const goal: Goal = { id: allocateId(ctx), uuid: uuidv7(), workspace: resolve(ctx.cwd), sessionId: ctx.sessionManager.getSessionId(), createdAt: now, updatedAt: now, text: text.trim(), status: "clarifying", todos: [], answers: [], planConfirmed: false };
    state.goals.push(goal);
    save(ctx);
    return goal;
  }

  /** A turn can only start when a model with configured credentials is selected. */
  function modelReady(ctx: ExtensionContext): boolean {
    return !!ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model);
  }

  function start(goal: Goal, ctx: ExtensionContext): boolean {
    if (!ctx.isIdle() || activeId !== undefined) {
      ctx.ui.notify("AI 正在执行，请等待或先暂停当前目标。", "warning");
      return false;
    }
    if (!goal.planConfirmed || !goal.todos?.length) return clarify(goal, ctx);
    if (!modelReady(ctx)) {
      ctx.ui.notify("未选择可用模型（或缺少凭据），无法执行目标。", "warning");
      return false;
    }
    const previousStatus = goal.status;
    planningId = undefined;
    goal.status = "running";
    activeId = goal.id;
    runFailed = false;
    save(ctx);
    try {
      const prompt = `${buildGoalPrompt(goal.text)}\n\n${reviewInstructions(goal)}\n\nGoal ID: ${goal.id}\nConfirmed TODOs:\n${goal.todos.map(todoLabel).join("\n")}\nClarifications:\n${JSON.stringify(goal.answers ?? [])}\nConstraints: ${JSON.stringify(goal.constraints ?? [])}\nAcceptance criteria: ${JSON.stringify(goal.acceptance ?? [])}\nUse goal_todo to mark each TODO running, blocked, or done as work progresses. For done, include concrete verification evidence; the plugin records the completion time. Do not mark TODOs complete merely because the agent turn ends.`;
      pi.sendUserMessage(previousStatus === "pending" ? prompt :
        `Continue goal #${goal.id} using the existing conversation. The goal text below is the current version; inspect what has already been done and do not blindly repeat prior actions.\n\n${prompt}`);
    } catch (error) {
      activeId = undefined;
      goal.status = previousStatus;
      save(ctx);
      throw error;
    }
    return true;
  }

  function clarify(goal: Goal, ctx: ExtensionContext): boolean {
    if (!modelReady(ctx)) {
      ctx.ui.notify(`未选择可用模型（或缺少凭据）；目标 #${goal.id} 已保存为待澄清，配置后可在面板继续。`, "warning");
      return false;
    }
    if (!ctx.isIdle() || activeId !== undefined) {
      ctx.ui.notify("AI 正在执行；目标已保存，可稍后在面板继续澄清。", "warning");
      return false;
    }
    const previousStatus = goal.status;
    goal.status = "clarifying";
    planningId = goal.id;
    activeId = goal.id;
    save(ctx);
    try {
      pi.sendUserMessage([
        `Clarify goal #${goal.id} with me before executing anything:`, goal.text,
        `Existing answers: ${JSON.stringify(goal.answers ?? [])}`,
        `Existing TODOs: ${JSON.stringify(goal.todos ?? [])}`,
        `Constraints: ${JSON.stringify(goal.constraints ?? [])}`,
        `Acceptance criteria: ${JSON.stringify(goal.acceptance ?? [])}`,
        `Structured goal definition: ${serializeGoalTemplate(templateFromGoal(goal))}`,
        "If the user's brief specifies an objective, priority, benchmarks, CHECK dimensions or a self-review LOOP, use goal_plan confirm's definition field with a complete .goal.sexp definition to capture them structurally, not only in TODO prose. Preserve the current goal title. Use the data schema: (objective (name \"site_design\") (priority \"OVERRIDE_ALL\") (target \"...\")), (benchmarks \"...\"), (checks (check \"dimension\" (standard \"award_tier\"))), (review-loop (name \"self_review\") (trigger \"on_completion\") (read \"...\") (compare \"...\") (on-gap \"patch-and-repeat\") (on-pass \"stop\") (max-iterations 3)). Explain any finite review budget to the user before confirmation; never promise perfection or override higher-priority instructions.",
        "Preserve the structured objective, benchmarks, checks and bounded review loop when planning TODOs. Clarify the actual page URL, reference entries, target devices and access needed for visual verification. A review loop here is a plan, not authorization to execute it during clarification.",
        "This is planning only. Do not change files, resources, install dependencies, or execute the goal. Read relevant project context only when necessary.",
        "Use goal_plan action ask to ask a few focused, goal-specific questions one at a time: scope, desired output, acceptance criteria, constraints, and exclusions. Ask follow-up questions only for unresolved essentials; do not invent my answers.",
        "After clarification, use goal_plan action confirm with a concrete ordered TODO list including acceptance/verification steps, plus constraints and acceptance arrays reflecting my confirmed answers. The plugin will let me review/edit and explicitly confirm it. Never execute the plan in this turn, even after confirmation. If a dialog is cancelled, stop planning until I ask to continue. Preserve existing instructions and approval boundaries.",
      ].join("\n\n"));
    } catch (error) {
      activeId = undefined;
      planningId = undefined;
      goal.status = previousStatus;
      save(ctx);
      throw error;
    }
    return true;
  }

  pi.registerTool({
    name: "goal_plan",
    label: "Goal planning",
    description: "Interactively clarify a goal and confirm its TODO plan. Use only for the goal currently being clarified. ask opens a question dialog; confirm opens an editable TODO review and requires user confirmation. Never execute a goal during planning.",
    exposure: "model-only",
    parameters: Type.Object({
      goalId: Type.Integer({ minimum: 1 }),
      action: Type.Union([Type.Literal("ask"), Type.Literal("confirm")]),
      question: Type.Optional(Type.String()),
      todos: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      definition: Type.Optional(Type.String({ description: "Optional full data-only .goal.sexp definition, preserving the current title and any structured objective, benchmarks, checks and bounded review loop requested by the user." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const goal = state.goals.find((item) => item.id === params.goalId);
      if (!goal || planningId !== goal.id || goal.status !== "clarifying") throw new Error("Goal is not currently being clarified.");
      if (!ctx.hasUI) throw new Error("Interactive planning requires a UI. Resume clarification in interactive Pi or an RPC client supporting dialogs.");
      const currentGeneration = generation;
      const valid = () => !signal?.aborted && generation === currentGeneration && planningId === goal.id && goal.status === "clarifying";
      const stopped = () => {
        if (valid()) planningId = undefined;
        return { content: [{ type: "text" as const, text: "Planning stopped. Do not execute or ask more questions until the user resumes." }], details: undefined };
      };
      if (params.action === "ask") {
        if (!params.question?.trim()) throw new Error("A question is required.");
        const answer = await ctx.ui.editor(`目标 #${goal.id} · ${params.question.trim()}`);
        if (!valid() || !answer?.trim()) return stopped();
        (goal.answers ??= []).push({ question: params.question.trim(), answer: answer.trim() });
        save(ctx);
        return { content: [{ type: "text", text: answer.trim() }], details: undefined };
      }
      if (!params.todos?.length || params.todos.some((text) => !text.trim())) throw new Error("A nonempty TODO list is required.");
      const definition = params.definition === undefined ? templateFromGoal(goal) : parseGoalTemplate(params.definition);
      if (definition.title !== goal.text) throw new Error("The proposed definition must preserve the current goal title.");
      const constraints = params.constraints?.map((text) => text.trim()) ?? definition.constraints;
      const acceptance = params.acceptance?.map((text) => text.trim()) ?? definition.acceptance;
      if ([...constraints, ...acceptance].some((text) => !text)) throw new Error("Constraints and acceptance criteria must not be blank.");
      const edited = await ctx.ui.editor(`目标 #${goal.id} · 审阅 TODO（每行一项，可修改）`, params.todos.map((text) => text.trim()).join("\n"));
      if (!valid() || !edited?.trim()) return stopped();
      const texts = edited.split("\n").map((text) => text.trim()).filter(Boolean);
      if (!texts.length) return stopped();
      const confirmed = await ctx.ui.confirm(`确认目标 #${goal.id} 的 ${texts.length} 项 TODO？`, `${serializeGoalTemplate({ ...definition, constraints, acceptance, todos: texts })}\n\n确认后仅保存，不自动执行。`);
      if (!valid() || !confirmed) return stopped();
      goal.todos = texts.map((text, index) => ({ id: index + 1, text, status: "pending" }));
      goal.constraints = constraints;
      goal.acceptance = acceptance;
      goal.objective = definition.objective;
      goal.benchmarks = definition.benchmarks;
      goal.checks = definition.checks;
      goal.reviewLoop = definition.reviewLoop;
      goal.planConfirmed = true;
      goal.status = "pending";
      planningId = undefined;
      save(ctx);
      return { content: [{ type: "text", text: "TODO plan confirmed and saved. Stop here; the user will start execution from /goal. Do not execute any tasks now." }], details: undefined };
    },
  });

  pi.registerTool({
    name: "goal_todo",
    label: "Goal TODO",
    description: "Update a confirmed TODO of the currently running goal. done requires verification evidence; completion time is recorded by the plugin. Never update paused/cancelled goals or claim completion without evidence.",
    parameters: Type.Object({
      goalId: Type.Integer({ minimum: 1 }),
      todoId: Type.Integer({ minimum: 1 }),
      status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("blocked"), Type.Literal("done")]),
      evidence: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Execution aborted.");
      const goal = state.goals.find((item) => item.id === params.goalId);
      if (!goal || activeId !== goal.id || goal.status !== "running" || !goal.planConfirmed) throw new Error("Goal is not currently running with a confirmed plan.");
      const todo = goal.todos?.find((item) => item.id === params.todoId);
      if (!todo) throw new Error("TODO not found.");
      if (params.status === "done" && !params.evidence?.trim()) throw new Error("Verification evidence is required to complete a TODO.");
      todo.completedAt = params.status === "done" ? (todo.status === "done" ? todo.completedAt ?? new Date().toISOString() : new Date().toISOString()) : undefined;
      todo.status = params.status;
      todo.evidence = params.evidence?.trim() || undefined;
      save(ctx);
      return { content: [{ type: "text", text: todoLabel(todo) }], details: structuredClone(todo) };
    },
  });

  function pause(goal: Goal, ctx: ExtensionContext) {
    goal.status = "paused";
    if (planningId === goal.id) planningId = undefined;
    for (const todo of goal.todos ?? []) if (todo.status === "running") todo.status = "pending";
    save(ctx);
    // Keep activeId until settlement to avoid attributing an old run to a new goal.
    if (activeId === goal.id) ctx.abort();
  }

  pi.on("agent_before_settle", (event) => {
    if (activeId !== undefined) runFailed = event.outcome === "error";
  });
  pi.on("agent_settled", (event, ctx) => {
    const goal = state.goals.find((item) => item.id === activeId);
    activeId = undefined;
    if (!goal) return;
    if (goal.status === "clarifying") {
      if (planningId === goal.id) planningId = undefined;
      return;
    }
    if (goal.status !== "running") return;
    for (const todo of goal.todos ?? []) if (todo.status === "running") todo.status = "pending";
    goal.status = event.aborted || runFailed ? "paused" : "review";
    save(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const goal = state.goals.find((item) => item.id === activeId);
    if (goal?.status === "running" || goal?.status === "clarifying") {
      goal.status = "paused";
      save(ctx);
    }
    activeId = undefined;
    generation++;
  });

  async function cancel(goal: Goal, ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<boolean> {
    const choice = await ctx.ui.select(`取消目标 #${goal.id}：是否回滚所有操作？`, [
      "取消目标，保留已有操作",
      "取消目标，回滚所有操作",
      "返回",
    ]);
    if (!isCurrent() || !choice || choice === "返回") return false;
    const rollback = choice === "取消目标，回滚所有操作";
    if (rollback && activeId !== goal.id && (!ctx.isIdle() || activeId !== undefined)) {
      ctx.ui.notify("其他任务正在执行，无法安全启动回滚。请等待其结束后重试。", "warning");
      return false;
    }
    const wasActive = activeId === goal.id;
    if (planningId === goal.id) planningId = undefined;
    for (const todo of goal.todos ?? []) if (todo.status === "running") todo.status = "pending";
    goal.status = "cancelled";
    save(ctx);
    if (wasActive) ctx.abort();
    if (!rollback) return false;

    // Command-only wait: finish in-flight tool calls before examining their effects.
    if (wasActive) await ctx.waitForIdle();
    if (!isCurrent()) return true;
    if (!ctx.isIdle() || activeId !== undefined) {
      ctx.ui.notify("目标已取消，但 AI 尚未空闲；未启动回滚。请稍后在目标面板重试。", "warning");
      return true;
    }
    pi.sendUserMessage([
      `Goal #${goal.id} has been cancelled. Stop pursuing it and roll back all operations attributable to this goal only.`,
      "Goal text:", goal.text,
      "Use the conversation's tool calls and actual current state to identify the operations from this goal, including earlier runs before pauses or edits. If attribution or the original state is uncertain, ask me before making changes.",
      "Revert only clearly attributable, safely reversible local changes. Preserve pre-existing work, unrelated goals, and subsequent user changes. Do not use blanket git reset --hard, git clean, or discard the entire working tree. Cancelling a goal or navigating the session tree does not undo operations.",
      "Before destructive, external, production, or otherwise high-impact reversals, present the specific rollback plan and request explicit approval. Respect all existing approval requirements, including Terraform apply approval. Do not treat this request as blanket authorization for such actions.",
      "Verify each reversal. Report what was rolled back, what remains, what is irreversible or uncertain, and what requires approval. Do not claim all operations were rolled back without evidence. Do not resume the cancelled goal.",
    ].join("\n\n"));
    return true;
  }

  async function todoPanel(goal: Goal, ctx: ExtensionCommandContext, isCurrent: () => boolean) {
    while (isCurrent()) {
      const todos = goal.todos ?? [];
      const labels = todos.map(todoLabel);
      const selected = await ctx.ui.select(`目标 #${goal.id} · TODO ${todos.filter((todo) => todo.status === "done").length}/${todos.length}`, [...labels, "返回目标列表"]);
      if (!isCurrent() || !selected || selected === "返回目标列表") return;
      const todo = todos[labels.indexOf(selected)];
      if (!todo) continue;
      const action = await ctx.ui.select(`${todoLabel(todo)}${todo.evidence ? `\n完成 / 阻塞说明：${todo.evidence}` : ""}`, [
        todo.status === "done" ? "重新打开 TODO" : "标记 TODO 完成", "返回 TODO",
      ]);
      if (!isCurrent()) return;
      if (action !== "标记 TODO 完成" && action !== "重新打开 TODO") continue;
      if (activeId !== undefined || goal.status === "cancelled" || !goal.planConfirmed) {
        ctx.ui.notify("请先确认计划并暂停执行；已取消的目标须先重新打开。", "warning");
        continue;
      }
      if (action === "标记 TODO 完成") {
        const evidence = await ctx.ui.editor(`TODO #${todo.id} · 完成说明 / 验证依据`);
        if (!isCurrent()) return;
        if (!evidence?.trim()) continue;
        todo.status = "done";
        todo.completedAt = new Date().toISOString();
        todo.evidence = evidence.trim();
      } else {
        todo.status = "pending";
        todo.completedAt = undefined;
        todo.evidence = undefined;
        if (goal.status === "done") goal.status = "pending";
      }
      save(ctx);
    }
  }

  function sections(ctx: ExtensionContext) {
    const workspace = resolve(ctx.cwd);
    const all = [...state.goals];
    for (const directory of knownWorkspaces(getAgentDir())) {
      if (directory === workspace) continue;
      try {
        const goals = new GoalStorage(directory).load();
        const nextId = Math.max(0, ...goals.map((goal) => goal.id)) + 1;
        const snapshot = { type: "custom", customType: STATE_TYPE, data: { goals, nextId } } as SessionEntry;
        if (restoreGoals([snapshot]).goals.length !== goals.length) throw new Error("Invalid goal data");
        all.push(...goals.map((goal) => ({ ...goal, workspace: directory })));
      } catch (error) {
        ctx.ui.notify(`无法读取 workspace ${directory}：${String(error)}`, "warning");
      }
    }
    return [
      { title: "当前 Session", goals: state.goals.filter((goal) => goal.sessionId === ctx.sessionManager.getSessionId()) },
      { title: "当前 Workspace", goals: state.goals },
      { title: "所有 Goal", goals: all },
    ];
  }

  /** Create a new goal from a data-only template after explicit confirmation. */
  async function createFromTemplate(template: GoalTemplate, title: string, ctx: ExtensionCommandContext): Promise<Goal | undefined> {
    if (!ctx.hasUI) throw new Error("需要交互式确认，请使用 TUI 或支持对话框的 RPC 客户端。");
    const currentGeneration = generation;
    const confirmed = await ctx.ui.confirm(title, `${serializeGoalTemplate(template)}\n仅作为目标数据导入，不执行表达式或自动执行任务。请确认内容可信；旧状态和完成记录不会导入。`);
    if (!confirmed || generation !== currentGeneration) return undefined;
    const now = new Date().toISOString();
    const goal: Goal = {
      id: allocateId(ctx), uuid: uuidv7(), workspace: resolve(ctx.cwd), sessionId: ctx.sessionManager.getSessionId(),
      createdAt: now, updatedAt: now, text: template.title, constraints: template.constraints, acceptance: template.acceptance,
      objective: template.objective, benchmarks: template.benchmarks, checks: template.checks, reviewLoop: template.reviewLoop,
      todos: template.todos.map((text, index) => ({ id: index + 1, text, status: "pending" })), answers: [],
      status: template.todos.length ? "pending" : "clarifying", planConfirmed: template.todos.length > 0,
    };
    state.goals.push(goal);
    save(ctx);
    return goal;
  }

  async function importTemplate(path: string, ctx: ExtensionCommandContext) {
    const goal = await createFromTemplate(readGoalTemplate(resolve(ctx.cwd, path)), "导入 Goal 模板并确认计划？", ctx);
    if (goal) ctx.ui.notify(`已导入目标 #${goal.id}，未自动执行。`, "info");
  }

  function snippetLabel(snippet: GoalSnippet): string {
    return `${snippet.name} [${snippet.source === "user" ? "我的" : "内置"}] ${snippet.template.title.replace(/\s+/g, " ")}`;
  }

  function loadSnippets(ctx: ExtensionContext): GoalSnippet[] {
    const { snippets, errors } = listSnippets(getAgentDir());
    for (const error of errors) ctx.ui.notify(`Snippet 无效，已跳过：${error}`, "warning");
    return snippets;
  }

  /** Instantiate a reusable snippet in the current workspace; project context is appended to the goal text. */
  async function useSnippet(snippet: GoalSnippet, context: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const template = { ...snippet.template, title: context.trim() ? `${snippet.template.title}\n\n${context.trim()}` : snippet.template.title };
    const goal = await createFromTemplate(template, `使用 Snippet「${snippet.name}」创建目标？`, ctx);
    if (!goal) return false;
    if (goal.planConfirmed) {
      ctx.ui.notify(`已从 Snippet 创建目标 #${goal.id}，计划已确认，未自动执行。`, "info");
      return false;
    }
    if (clarify(goal, ctx)) return true;
    ctx.ui.notify(`已从 Snippet 创建目标 #${goal.id}，保存为待澄清。`, "info");
    return false;
  }

  async function pickSnippet(ctx: ExtensionCommandContext): Promise<boolean> {
    const currentGeneration = generation;
    const snippets = loadSnippets(ctx);
    if (!snippets.length) { ctx.ui.notify("暂无 Snippet。可用 /goal export <编号> @<名称> 保存。", "info"); return false; }
    const labels = snippets.map(snippetLabel);
    const selected = await ctx.ui.select("Goal Snippets", [...labels, "返回"]);
    const snippet = snippets[labels.indexOf(selected ?? "")];
    if (!snippet || generation !== currentGeneration) return false;
    const context = await ctx.ui.editor(`Snippet「${snippet.name}」· 补充本项目信息（页面、URL、范围等，可留空）`);
    if (context === undefined || generation !== currentGeneration) return false;
    return useSnippet(snippet, context, ctx);
  }

  async function saveAsSnippet(goal: Goal, name: string, ctx: ExtensionCommandContext) {
    validateSnippetName(name);
    const currentGeneration = generation;
    let template = templateFromGoal(goal);
    if (ctx.hasUI) {
      const edited = await ctx.ui.editor(`审阅 Snippet「${name}」（将用于所有项目；请移除项目专属信息和敏感内容）`, serializeGoalTemplate(template));
      if (edited === undefined || generation !== currentGeneration) return;
      template = parseGoalTemplate(edited);
    }
    ctx.ui.notify(`已保存 Snippet ${saveSnippet(getAgentDir(), name, template)}`, "info");
  }

  async function exportTemplate(goal: Goal, path: string, ctx: ExtensionCommandContext) {
    const currentGeneration = generation;
    let template = templateFromGoal(goal);
    if (ctx.hasUI) {
      const edited = await ctx.ui.editor("审阅分享内容（不含执行记录；请自行移除文本中的敏感信息）", serializeGoalTemplate(template));
      if (edited === undefined || generation !== currentGeneration) return;
      template = parseGoalTemplate(edited);
    }
    const destination = resolve(ctx.cwd, path);
    writeGoalTemplate(destination, template);
    ctx.ui.notify(`已导出 ${destination}`, "info");
  }

  async function sharing(action: () => Promise<void>, ctx: ExtensionContext) {
    try { await action(); } catch (error) { ctx.ui.notify(`Goal 模板操作失败：${String(error)}`, "error"); }
  }

  function goalDetails(goal: Goal): string {
    return [
      goalLabel(goal), `Workspace: ${goal.workspace}`, `Session: ${goal.sessionId ?? "未知"}`, `UUID: ${goal.uuid}`,
      ...(goal.todos ?? []).map((todo) => `${todoLabel(todo)}${todo.evidence ? ` · ${todo.evidence}` : ""}`),
      "", serializeGoalTemplate(templateFromGoal(goal)),
    ].join("\n");
  }

  /** One action on a goal in the current workspace. "exit" closes the panel (a run started). */
  async function goalMenu(goal: Goal, ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<"exit" | "back" | "done"> {
    const actions = [
      "查看目标定义", "展开 TODO",
      ...(goal.status === "running" || activeId === goal.id ? ["暂停"] : [goal.planConfirmed ? "执行 / 继续" : "继续澄清"]),
      "修改",
      ...(goal.status === "running" || goal.status === "done" || goal.status === "paused" ? [] : ["暂停"]),
      ...(goal.status === "running" ? [] : [goal.status === "done" ? "重新打开" : "标记完成"]),
      "导出 Goal 模板", "保存为 Snippet", "取消目标", "删除", "返回列表",
    ];
    const action = await ctx.ui.select(goalLabel(goal), actions);
    if (!isCurrent()) return "exit";
    if (!action || action === "返回列表") return "back";
    // A run may have settled while a dialog was open; operations check live state.
    if (action === "查看目标定义") {
      await ctx.ui.select(serializeGoalTemplate(templateFromGoal(goal)), ["返回列表"]);
    } else if (action === "展开 TODO") {
      await todoPanel(goal, ctx, isCurrent);
    } else if (action === "执行 / 继续" || action === "继续澄清") {
      if (start(goal, ctx)) return "exit";
    } else if (action === "导出 Goal 模板") {
      const path = await ctx.ui.editor("导出文件路径（.goal.sexp，不覆盖已有文件）", `${goal.uuid}.goal.sexp`);
      if (!isCurrent()) return "exit";
      if (path?.trim()) await sharing(() => exportTemplate(goal, path.trim(), ctx), ctx);
    } else if (action === "保存为 Snippet") {
      const name = await ctx.ui.input("Snippet 名称（小写字母、数字、连字符）", "site-design");
      if (!isCurrent()) return "exit";
      if (name?.trim()) await sharing(() => saveAsSnippet(goal, name.trim(), ctx), ctx);
    } else if (action === "取消目标") {
      if (await cancel(goal, ctx, isCurrent)) return "exit";
    } else if (action === "暂停") {
      if (goal.status !== "done") pause(goal, ctx);
    } else if (action === "修改") {
      if (activeId !== undefined) {
        ctx.ui.notify("请先暂停目标，等待 AI 停止后再修改。", "warning");
        return "done";
      }
      const text = await ctx.ui.editor(`修改目标 #${goal.id}`, goal.text);
      if (!isCurrent()) return "exit";
      if (text?.trim()) {
        goal.text = text.trim();
        goal.planConfirmed = false;
        goal.status = "clarifying";
        save(ctx);
      }
    } else if (action === "删除") {
      if (await ctx.ui.confirm(`删除目标 #${goal.id}？`, "只删除目标记录，不撤销文件或资源改动；正在执行的目标会被暂停。")) {
        if (!isCurrent()) return "exit";
        if (activeId === goal.id) pause(goal, ctx);
        storage!.remove(goal);
        if (goal.uuid) persisted.delete(goal.uuid);
        state.goals = state.goals.filter((item) => item.id !== goal.id);
        save(ctx);
        return "back";
      }
    } else if (action === "标记完成" || action === "重新打开") {
      if (goal.status === "running" || activeId === goal.id) {
        ctx.ui.notify("请先暂停目标，等待 AI 停止。", "warning");
        return "done";
      }
      if (action === "标记完成" && (!goal.planConfirmed || !goal.todos?.length || goal.todos.some((todo) => todo.status !== "done"))) {
        ctx.ui.notify("请先确认计划并完成所有 TODO，再标记目标完成。", "warning");
        return "done";
      }
      goal.status = action === "标记完成" ? "done" : goal.planConfirmed ? "pending" : "clarifying";
      save(ctx);
    }
    return "done";
  }

  /** The /goal panel. With initial, it opens that goal's action menu directly and closes when the user leaves it. */
  async function panel(ctx: ExtensionCommandContext, initial?: Goal) {
    if (!ctx.hasUI) {
      ctx.ui.notify(initial ? goalDetails(initial) : sections(ctx).map((section) => `${section.title} (${section.goals.length})\n${section.goals.map((goal) => [goalLabel(goal), ...(goal.todos ?? []).map((todo) => `  ${todoLabel(todo)}`)].join("\n")).join("\n") || "暂无目标"}`).join("\n\n"), "info");
      return;
    }
    if (panelOpen) return;
    panelOpen = true;
    const currentGeneration = generation;
    const isCurrent = () => generation === currentGeneration;
    let scope: number | undefined;
    try {
      if (initial) {
        while (isCurrent() && state.goals.includes(initial)) {
          if (await goalMenu(initial, ctx, isCurrent) !== "done") return;
        }
        return;
      }
      while (isCurrent()) {
        const groups = sections(ctx);
        if (scope === undefined) {
          const labels = groups.map((group) => `${group.title} (${group.goals.length})`);
          const selectedScope = await ctx.ui.select("Goals · 选择范围", [...labels, "＋ 新增目标", "从 Snippet 创建", "导入 Goal 模板", "关闭"]);
          if (!isCurrent() || !selectedScope || selectedScope === "关闭") return;
          if (selectedScope === "从 Snippet 创建") {
            let started = false;
            await sharing(async () => { started = await pickSnippet(ctx); }, ctx);
            if (started || !isCurrent()) return;
            continue;
          }
          if (selectedScope === "导入 Goal 模板") {
            const path = await ctx.ui.editor("导入 .goal.sexp 文件路径（相对 workspace 或绝对路径）");
            if (!isCurrent()) return;
            if (path?.trim()) await sharing(() => importTemplate(path.trim(), ctx), ctx);
            continue;
          }
          if (selectedScope === "＋ 新增目标") {
            const text = await ctx.ui.editor("新增目标（接下来由 AI 提问澄清并确认 TODO）");
            if (!isCurrent()) return;
            if (text?.trim() && clarify(add(text, ctx), ctx)) return;
            continue;
          }
          scope = labels.indexOf(selectedScope);
          if (scope < 0) { scope = undefined; continue; }
        }
        const group = groups[scope]!;
        const choices = group.goals.map((goal) => `${goalLabel(goal)}${scope === 2 ? ` · ${goal.workspace} · ${goal.uuid?.slice(0, 8)}` : ""}`);
        const selected = await ctx.ui.select(`Goals · ${group.title} · ${group.goals.length} 个目标`, ["＋ 新增目标", ...choices, "返回分区", "关闭"]);
        if (!isCurrent() || !selected || selected === "关闭") return;
        if (selected === "返回分区") { scope = undefined; continue; }
        if (selected === "＋ 新增目标") {
          const text = await ctx.ui.editor("新增目标（接下来由 AI 提问澄清并确认 TODO）");
          if (!isCurrent()) return;
          if (text?.trim()) {
            const goal = add(text, ctx);
            if (clarify(goal, ctx)) return;
          }
          continue;
        }
        const goal = group.goals[choices.indexOf(selected)];
        if (!goal) continue;
        if (goal.workspace !== resolve(ctx.cwd)) {
          await ctx.ui.select(goalDetails(goal), ["返回列表"]);
          if (isCurrent()) ctx.ui.notify(`此目标属于 ${goal.workspace}，请在对应 workspace 中执行或修改。`, "info");
          continue;
        }
        if (await goalMenu(goal, ctx, isCurrent) === "exit") return;
      }
    } finally {
      panelOpen = false;
    }
  }

  const USAGE = [
    "/goal                          打开目标面板（Session / Workspace / 所有 Goal）",
    "/goal <任务>                   新增目标并交互式澄清 TODO",
    "/goal #<编号>                  直接打开当前 workspace 的某个目标",
    "/goal @                        选择 Snippet 创建目标",
    "/goal @<snippet> [补充信息]    用 Snippet 创建目标",
    "/goal import <文件.goal.sexp>  导入模板",
    "/goal export <编号> [文件.goal.sexp]  导出模板",
    "/goal export <编号> @<名称>    保存为全局 Snippet",
    "/goal help                     显示本帮助",
  ].join("\n");

  function findGoal(id: string, ctx: ExtensionContext): Goal | undefined {
    const goal = state.goals.find((item) => item.id === Number(id));
    if (!goal) ctx.ui.notify(`当前 workspace 没有目标 #${id}。用 /goal 查看列表。`, "warning");
    return goal;
  }

  async function snippetCommand(name: string, context: string, ctx: ExtensionCommandContext) {
    await sharing(async () => {
      if (!name) {
        if (ctx.hasUI) { await pickSnippet(ctx); return; }
        const snippets = loadSnippets(ctx);
        ctx.ui.notify(snippets.length ? snippets.map(snippetLabel).join("\n") : "暂无 Snippet。", "info");
        return;
      }
      validateSnippetName(name);
      const snippet = loadSnippets(ctx).find((item) => item.name === name);
      if (!snippet) throw new Error(`未找到 Snippet：${name}`);
      await useSnippet(snippet, context, ctx);
    }, ctx);
  }

  async function exportCommand(goal: Goal, target: string | undefined, ctx: ExtensionCommandContext) {
    if (target?.startsWith("@")) await sharing(() => saveAsSnippet(goal, target.slice(1), ctx), ctx);
    else await sharing(() => exportTemplate(goal, target ?? `${goal.uuid}.goal.sexp`, ctx), ctx);
  }

  /**
   * /goal is the single entry point. Subcommands only match strict shapes (numeric IDs, @snippet,
   * import/export with .goal.sexp paths), so ordinary task text still creates a goal.
   */
  async function goalCommand(args: string, ctx: ExtensionCommandContext) {
    if (storageError) { ctx.ui.notify(storageError, "error"); return; }
    const text = args.trim();
    if (!text) return panel(ctx);
    if (text === "help") { ctx.ui.notify(USAGE, "info"); return; }
    let match: RegExpExecArray | null;
    if ((match = /^#(\d+)$/.exec(text))) {
      const goal = findGoal(match[1]!, ctx);
      if (goal) await panel(ctx, goal);
      return;
    }
    if (/^\d+$/.test(text)) {
      // A bare number is ambiguous (task text vs. goal ID); require the explicit #<id> form.
      ctx.ui.notify(`打开目标请用 /goal #${text}；如需新建目标，请写明任务内容。`, "warning");
      return;
    }
    if ((match = /^@(\S*)(?:\s+([\s\S]+))?$/.exec(text))) return snippetCommand(match[1]!, match[2] ?? "", ctx);
    if ((match = /^import\s+(\S[\s\S]*\.goal\.sexp)$/.exec(text))) return sharing(() => importTemplate(match![1]!, ctx), ctx);
    if ((match = /^export\s+#?(\d+)(?:\s+(@\S+|\S[\s\S]*\.goal\.sexp))?$/.exec(text))) {
      const goal = findGoal(match[1]!, ctx);
      if (goal) await exportCommand(goal, match[2], ctx);
      return;
    }
    const goal = add(text, ctx);
    if (!clarify(goal, ctx)) ctx.ui.notify(`目标 #${goal.id} 已保存为待澄清，可在 /goal 面板继续。`, "info");
  }

  pi.registerCommand("goal", {
    description: "目标统一入口：/goal [任务 | 编号 | @snippet | import | export | help]",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      if (trimmed.startsWith("@")) {
        try {
          return listSnippets(getAgentDir()).snippets.filter((snippet) => `@${snippet.name}`.startsWith(trimmed))
            .map((snippet) => ({ value: `@${snippet.name} `, label: `@${snippet.name}`, description: snippet.template.title.split("\n")[0] }));
        } catch { return null; }
      }
      const items = [
        { value: "@", label: "@<snippet>", description: "用 Snippet 创建目标" },
        { value: "import ", label: "import <文件.goal.sexp>", description: "导入模板" },
        { value: "export ", label: "export <编号> [文件 | @名称]", description: "导出模板或保存为 Snippet" },
        { value: "help", label: "help", description: "显示用法" },
        ...state.goals.map((goal) => ({ value: `#${goal.id}`, label: `#${goal.id}`, description: goal.text.split("\n")[0] })),
      ];
      const matches = items.filter((item) => item.value.startsWith(trimmed));
      return matches.length ? matches : null;
    },
    handler: goalCommand,
  });

  // Auxiliary aliases for discoverability; all behavior is reachable through /goal.
  pi.registerCommand("goal-snippet", {
    description: "等同 /goal @<snippet> [补充信息]",
    handler: (args, ctx) => goalCommand(`@${args.trim()}`, ctx),
  });
  pi.registerCommand("goal-snippet-save", {
    description: "等同 /goal export <编号> @<名称>",
    handler: async (args, ctx) => {
      const match = /^#?(\d+)\s+@?(\S+)$/.exec(args.trim());
      if (!match) { ctx.ui.notify("用法：/goal export <编号> @<名称>", "warning"); return; }
      await goalCommand(`export ${match[1]} @${match[2]}`, ctx);
    },
  });
  pi.registerCommand("goal-import", {
    description: "等同 /goal import <文件.goal.sexp>",
    handler: async (args, ctx) => {
      if (storageError) { ctx.ui.notify(storageError, "error"); return; }
      if (!args.trim()) { ctx.ui.notify("用法：/goal import <文件.goal.sexp>", "warning"); return; }
      await sharing(() => importTemplate(args.trim(), ctx), ctx);
    },
  });
  pi.registerCommand("goal-export", {
    description: "等同 /goal export <编号> [文件.goal.sexp | @名称]",
    handler: async (args, ctx) => {
      if (storageError) { ctx.ui.notify(storageError, "error"); return; }
      const match = /^#?(\d+)(?:\s+([\s\S]+))?$/.exec(args.trim());
      const goal = match ? findGoal(match[1]!, ctx) : undefined;
      if (!match) ctx.ui.notify("用法：/goal export <编号> [文件.goal.sexp | @名称]", "warning");
      if (goal) await exportCommand(goal, match![2]?.trim(), ctx);
    },
  });
}
