import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { uuidv7 } from "@earendil-works/pi-ai";
import { GoalStorage, knownWorkspaces } from "./storage.ts";
import { parseGoalTemplate, readGoalTemplate, serializeGoalTemplate, validateApprovals, writeGoalTemplate, type Approval, type GoalTemplate } from "./sexp.ts";
import { listSnippets, saveSnippet, validateSnippetName, type GoalSnippet } from "./snippets.ts";
import { chooseMany, chooseOne, chooseYesNo } from "./choice.ts";
import { showGoalPicker, showTodoList, type PickerView } from "./picker.ts";
import { approvalSummary, goalListLabel, goalStatusText, sortGoals, statusCounts, statusHeader, LABELS, plain, runningWidget, statusBarText, statusDetails, statusSummary, TODO_LABELS, todoLine, todoListLines, todoNote, trackElapsed, type Paint } from "./status.ts";

/** Unfinished goals listed in the idle summary widget; the rest fold into one count line. */
const SUMMARY_LIMIT = 3;
const RUN_NOW = "确认并立即执行";
const RUN_LATER = "确认，稍后从 /goal 执行";
const EDIT_TODOS = "编辑 TODO";
const CANCEL_PLAN = "取消";

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
  /** Execution time of finished runs in milliseconds; paused time is excluded. */
  elapsedMs?: number;
  /** Start of the current run while the goal is running. */
  runStartedAt?: string;
  /** High-impact actions with exact commands, listed for one-time approval at plan confirmation. */
  approvals?: Approval[];
  /** True only after the user confirmed the plan with these approvals; templates never set it. */
  approvalsConfirmed?: boolean;
}
interface GoalState {
  goals: Goal[];
  nextId: number;
}

const STATE_TYPE = "pi-goal-state";

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
      (goal.history === undefined || Array.isArray(goal.history)) &&
      (goal.elapsedMs === undefined || (typeof goal.elapsedMs === "number" && Number.isFinite(goal.elapsedMs) && goal.elapsedMs >= 0)) &&
      (goal.approvalsConfirmed === undefined || typeof goal.approvalsConfirmed === "boolean") &&
      (goal.approvals === undefined || (Array.isArray(goal.approvals) && (() => { try { validateApprovals(goal.approvals); return true; } catch { return false; } })())) &&
      (goal.runStartedAt === undefined || (typeof goal.runStartedAt === "string" && Number.isFinite(Date.parse(goal.runStartedAt)))))) continue;
    try { for (const goal of data.goals) serializeGoalTemplate(templateFromGoal(goal)); }
    catch { continue; }
    state = structuredClone({ goals: data.goals, nextId: data.nextId });
  }
  // A saved running flag cannot resume work by itself after reload or branching.
  for (const goal of state.goals) {
    if (goal.status === "running") goal.status = "paused";
    for (const todo of goal.todos ?? []) if (todo.status === "running") todo.status = "pending";
    // An interrupted run (crash, killed process) ends at its last recorded update, not at reload time.
    if (goal.runStartedAt) trackElapsed(goal, Math.max(Date.parse(goal.runStartedAt), Date.parse(goal.updatedAt ?? goal.runStartedAt)));
  }
  return state;
}

/**
 * Validate goal files one at a time so a single bad file cannot hide every goal in a workspace.
 * Duplicate display IDs (e.g. from concurrent sessions) keep the earliest UUIDv7 and renumber later goals.
 */
export function validateGoals(goals: readonly Goal[]): { goals: Goal[]; nextId: number; errors: string[]; renumbered: string[] } {
  const valid: Goal[] = [];
  const errors: string[] = [];
  for (const goal of goals) {
    const id = goal?.id;
    const nextId = Number.isSafeInteger(id) && id > 0 ? id + 1 : 1;
    const [restored] = restoreGoals([{ type: "custom", customType: STATE_TYPE, data: { goals: [goal], nextId } } as SessionEntry]).goals;
    if (restored) valid.push(restored);
    else errors.push(`${goal?.uuid ?? "unknown"}.json: invalid goal data`);
  }
  let max = Math.max(0, ...valid.map((goal) => goal.id));
  const seen = new Set<number>();
  const renumbered: string[] = [];
  for (const goal of valid) {
    if (seen.has(goal.id)) {
      const previous = goal.id;
      goal.id = ++max;
      renumbered.push(`#${previous} → #${goal.id} (${goal.uuid})`);
    }
    seen.add(goal.id);
  }
  return { goals: valid, nextId: max + 1, errors, renumbered };
}

function templateFromGoal(goal: Goal): GoalTemplate {
  return {
    title: goal.text, constraints: goal.constraints ?? [], acceptance: goal.acceptance ?? [], todos: (goal.todos ?? []).map((todo) => todo.text),
    objective: goal.objective, benchmarks: goal.benchmarks, checks: goal.checks, reviewLoop: goal.reviewLoop,
    approvals: goal.approvals?.length ? goal.approvals : undefined,
  };
}

/** Approval list as shown to the user and the model: "1. action" then the exact command. */
function approvalLines(approvals: readonly Approval[]): string[] {
  return approvals.flatMap((item, index) => [`${index + 1}. ${item.action}`, `   $ ${item.command}`]);
}

function approvalInstructions(goal: Goal): string {
  if (!goal.approvals?.length) return "No high-impact actions were pre-approved for this goal; any destructive, external, production or otherwise high-impact action still requires my explicit approval first.";
  if (!goal.approvalsConfirmed) return ["Suggested approvals (NOT approved; they came from a template or the plan changed). Ask me before running any of them:", ...approvalLines(goal.approvals)].join("\n");
  return [
    "Pre-approved actions: I approved these exact commands when confirming the plan. Run them when their TODO is reached without asking again:",
    ...approvalLines(goal.approvals),
    "Approval covers only these commands for this goal's confirmed scope. If a command must change materially, the scope changes, or another high-impact action is needed, ask me first. Steps that need my own credentials (e.g. 2FA/OTP) remain mine to perform. Existing approval rules (e.g. Terraform apply) still apply.",
  ].join("\n");
}

/** How to keep interruptions few: shared by the start prompt and continuation turns. */
const BLOCKER_GUIDANCE = [
  "Minimise interruptions. When a TODO is blocked on me, first complete every TODO that does not depend on it and prepare whatever can be prepared (drafts, commits, notes, commands), then ask all pending questions in a single message.",
  "When continuing, first check what has changed (files, remote state, my latest reply) and do not repeat a question that has no new information; proceed with whatever my reply unblocked.",
].join("\n");

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


function todoLabel(todo: GoalTodo): string {
  const time = todo.completedAt ? ` · 完成于 ${new Date(todo.completedAt).toLocaleString()}` : "";
  return `TODO #${todo.id} [${TODO_LABELS[todo.status]}] ${todo.text.replace(/\s+/g, " ")}${time}`;
}


/** A confirmed plan whose TODOs are all done: the goal itself is complete. */
function allTodosDone(goal: Goal): boolean {
  return !!goal.planConfirmed && !!goal.todos?.length && goal.todos.every((todo) => todo.status === "done");
}

/**
 * Whether finishing every TODO completes the goal on its own. Goals with a design objective or review
 * loop require the user's final review, so they stay awaiting review until marked done by hand.
 */
function autoCompletes(goal: Goal): boolean {
  return allTodosDone(goal) && !goal.objective && !goal.reviewLoop;
}

export default function goalExtension(pi: ExtensionAPI) {
  let state: GoalState = { goals: [], nextId: 1 };
  let activeId: number | undefined;
  let planningId: number | undefined;
  /** Goal confirmed with "run now"; started once the planning run settles. */
  let autoStartId: number | undefined;
  /**
   * Goal whose run ended with unfinished TODOs (usually waiting on my reply). My next ordinary message
   * continues it, once; a run that does not work on the goal does not re-arm this.
   */
  let resumableId: number | undefined;
  /** Goal continued by the current turn; its context is injected before the agent starts. */
  let continuingId: number | undefined;
  /** Whether the active run started from start() or updated a TODO, i.e. actually worked on the goal. */
  let runWorked = false;
  let runFailed = false;
  let generation = 0;
  let panelOpen = false;
  let storage: GoalStorage | undefined;
  let storageError: string | undefined;
  let persisted = new Map<string, string>();

  let ticker: ReturnType<typeof setInterval> | undefined;
  let tickerCtx: ExtensionContext | undefined;

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    tickerCtx = undefined;
  }

  /** Theme colors in the TUI only; RPC clients and plain-text output never receive escape codes. */
  function paintFor(ctx: ExtensionContext): Paint {
    return ctx.mode === "tui" ? (color, text) => ctx.ui.theme.fg(color, text) : plain;
  }

  /** The goal my next message would continue, if it is still waiting for review with unfinished TODOs. */
  function resumableGoal(): Goal | undefined {
    const goal = state.goals.find((item) => item.id === resumableId);
    return goal && goal.status === "review" && goal.planConfirmed && goal.todos?.some((todo) => todo.status !== "done") ? goal : undefined;
  }

  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const paint = paintFor(ctx);
    const running = state.goals.find((goal) => goal.status === "running" && goal.id === activeId);
    const resumable = running ? undefined : resumableGoal();
    ctx.ui.setStatus("pi-goal", running ? statusBarText(running, undefined, paint)
      : resumable ? paint("warning", `↩ 下条消息将续接目标 #${resumable.id} · /goal 暂停可取消`) : undefined);
    if (running) {
      // Elapsed time is shown in minutes, so a once-a-minute repaint keeps it current.
      tickerCtx = ctx;
      ticker ??= setInterval(() => {
        try { if (tickerCtx) refresh(tickerCtx); } catch { stopTicker(); }
      }, 60_000);
      ticker.unref?.();
      ctx.ui.setWidget("pi-goal", runningWidget(running, undefined, paint));
      return;
    }
    stopTicker();
    // Only unfinished goals are listed (active and recently updated first); done / cancelled
    // ones are just counted, so the widget stays small and active work is never folded away.
    const goals = sortGoals(state.goals);
    const open = goals.filter((goal) => goal.status !== "done" && goal.status !== "cancelled");
    const shown = open.slice(0, SUMMARY_LIMIT);
    const hidden = goals.filter((goal) => !shown.includes(goal));
    // The header already counts every status, so the fold line only says how many are not listed;
    // with nothing unfinished the header alone says so.
    ctx.ui.setWidget("pi-goal", goals.length ? [
      `Goals · ${goals.length} 个目标 · ${statusCounts(goals, paint)}${shown.length ? "" : " · 均已结束"} · /goal 管理`,
      ...shown.map((goal) => goalListLabel(goal, paint, 40)),
      ...(shown.length && hidden.length ? [paint("dim", `… 另有 ${hidden.length} 个未列出`)] : []),
    ] : undefined);
  }

  function save(ctx: ExtensionContext) {
    if (storageError) throw new Error(storageError);
    storage ??= new GoalStorage(getAgentDir(), ctx.cwd);
    for (const goal of state.goals) {
      goal.uuid ??= uuidv7();
      goal.createdAt ??= new Date().toISOString();
      trackElapsed(goal);
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
    autoStartId = undefined;
    resumableId = undefined;
    continuingId = undefined;
    runFailed = false;
    storage = new GoalStorage(getAgentDir(), ctx.cwd);
    storageError = undefined;
    persisted = new Map();
    try {
      const loaded = storage.load();
      for (const goal of loaded.goals) goal.workspace ??= resolve(ctx.cwd);
      const validated = validateGoals(loaded.goals);
      state = { goals: validated.goals, nextId: validated.nextId };
      for (const goal of loaded.goals) if (goal.uuid) persisted.set(goal.uuid, JSON.stringify(goal));
      for (const error of [...loaded.errors, ...validated.errors]) ctx.ui.notify(`目标文件无效，已跳过（文件未修改，请手动修复）：${error}`, "warning");
      if (validated.renumbered.length) ctx.ui.notify(`目标编号重复，已重新编号：${validated.renumbered.join("，")}`, "warning");
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
    storage ??= new GoalStorage(getAgentDir(), ctx.cwd);
    const id = Math.max(state.nextId, storage.maxId() + 1);
    state.nextId = id + 1;
    return id;
  }

  function add(text: string, ctx: ExtensionContext): Goal | undefined {
    const now = new Date().toISOString();
    // Reject text that could not be reloaded later (e.g. over the 64 KiB template limit).
    try { serializeGoalTemplate(templateFromGoal({ id: 1, text: text.trim(), status: "clarifying" })); } catch (error) {
      ctx.ui.notify(`目标文本无效，未创建：${String(error)}`, "warning");
      return undefined;
    }
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
    resumableId = undefined;
    goal.status = "running";
    activeId = goal.id;
    runFailed = false;
    runWorked = true;
    save(ctx);
    try {
      const prompt = `${buildGoalPrompt(goal.text)}\n\n${reviewInstructions(goal)}\n\n${approvalInstructions(goal)}\n\n${BLOCKER_GUIDANCE}\n\nGoal ID: ${goal.id}\nConfirmed TODOs:\n${goal.todos.map(todoLabel).join("\n")}\nClarifications:\n${JSON.stringify(goal.answers ?? [])}\nConstraints: ${JSON.stringify(goal.constraints ?? [])}\nAcceptance criteria: ${JSON.stringify(goal.acceptance ?? [])}\nUse goal_todo to mark each TODO running, blocked, or done as work progresses. For done, include concrete verification evidence; the plugin records the completion time. Do not mark TODOs complete merely because the agent turn ends.`;
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
    resumableId = undefined;
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
        "Before confirming, run read-only preflight checks for everything the plan depends on: logins and credentials (e.g. gh/npm/az/kubectl auth status), permissions, repository or resource visibility, and external platform rules, limits and deadlines (consult official docs when unsure). Turn any finding that needs my decision or action into a clarification question now, so execution is not interrupted later. Never change state during preflight.",
        "Collect every high-impact action the plan needs (push, tag, release, publish, deploy, delete, sending messages, cloud or production changes, ...) into goal_plan confirm's approvals, each with a short action description and the exact command. Confirming the plan approves them all at once. Mark steps only I can perform (2FA/OTP, browser login) as mine. If my instructions require approval at the moment of an action (e.g. Terraform apply), list it but say it will still be confirmed right before it runs.",
        "Use goal_plan action ask to ask a few focused, goal-specific questions one at a time: scope, desired output, acceptance criteria, constraints, and exclusions. Ask follow-up questions only for unresolved essentials; do not invent my answers.",
        "Make each question easy to answer by keyboard: ask one decision per call. When there are a few likely answers, pass them as options (concise, mutually distinct, recommended first; set multiple=true when several can apply). For a yes/no decision use kind \"confirm\" without options. The plugin always adds an 'other (custom input)' choice, so do not add one yourself. Use plain free-text questions only when answers cannot be enumerated.",
        "After clarification, use goal_plan action confirm with a concrete ordered TODO list including acceptance/verification steps, plus constraints and acceptance arrays reflecting my confirmed answers. The plugin will let me review/edit and choose to start execution now or later. Never execute the plan yourself in this turn, even after confirmation; if I choose to run now, the plugin starts execution in a new turn. If a dialog is cancelled, stop planning until I ask to continue. Preserve existing instructions and approval boundaries.",
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
    description: "Interactively clarify a goal and confirm its TODO plan. Use only for the goal currently being clarified. ask opens a question dialog: with options the user picks by keyboard (multiple=true for a checklist), kind=\"confirm\" asks yes/no, otherwise free text; an 'other (custom input)' choice is always added. confirm opens a TODO review where the user confirms and chooses to run now or later. Never execute a goal yourself during planning.",
    exposure: "model-only",
    parameters: Type.Object({
      goalId: Type.Integer({ minimum: 1 }),
      action: Type.Union([Type.Literal("ask"), Type.Literal("confirm")]),
      question: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "ask only: candidate answers chosen by keyboard. Do not include an 'other' option; the plugin adds it." })),
      multiple: Type.Optional(Type.Boolean({ description: "ask only: allow selecting several options." })),
      kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("confirm")], { description: "ask only: confirm asks a yes/no question; text (default) uses options when given, otherwise free text." })),
      todos: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      definition: Type.Optional(Type.String({ description: "Optional full data-only .goal.sexp definition, preserving the current title and any structured objective, benchmarks, checks and bounded review loop requested by the user." })),
      approvals: Type.Optional(Type.Array(Type.Object({
        action: Type.String({ minLength: 1, description: "What the action does and why, e.g. 'Publish v0.1.3 to npm via GitHub Release'." }),
        command: Type.String({ minLength: 1, description: "The exact command to run." }),
      }), { description: "confirm only: every high-impact action (push, release, publish, deploy, delete, external messages, ...) the plan needs, with exact commands. Confirming the plan approves them all at once." })),
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
        const question = params.question?.trim();
        if (!question) throw new Error("A question is required.");
        const title = `目标 #${goal.id} · ${question}`;
        let answer: string | undefined;
        if (params.kind === "confirm") answer = await chooseYesNo(ctx, title);
        else if (params.options?.length && params.multiple) answer = (await chooseMany(ctx, title, params.options))?.join("；");
        else if (params.options?.length) answer = await chooseOne(ctx, title, params.options);
        else answer = await ctx.ui.editor(title);
        if (!valid() || !answer?.trim()) return stopped();
        (goal.answers ??= []).push({ question, answer: answer.trim() });
        save(ctx);
        return { content: [{ type: "text", text: answer.trim() }], details: undefined };
      }
      if (!params.todos?.length || params.todos.some((text) => !text.trim())) throw new Error("A nonempty TODO list is required.");
      const definition = params.definition === undefined ? templateFromGoal(goal) : parseGoalTemplate(params.definition);
      if (definition.title !== goal.text) throw new Error("The proposed definition must preserve the current goal title.");
      const constraints = params.constraints?.map((text) => text.trim()) ?? definition.constraints;
      const acceptance = params.acceptance?.map((text) => text.trim()) ?? definition.acceptance;
      if ([...constraints, ...acceptance].some((text) => !text)) throw new Error("Constraints and acceptance criteria must not be blank.");
      const approvals = validateApprovals(params.approvals ?? definition.approvals ?? []);
      const approvalText = approvals.length
        ? ["审批清单（确认计划即一并批准以下操作，执行中不再逐一询问；清单外或范围变化仍会询问）：", ...approvalLines(approvals)].join("\n")
        : "审批清单：无。执行中如需高影响操作仍会单独询问。";
      let texts = params.todos.map((text) => text.trim());
      let choice: string | undefined;
      // One keyboard step: the first option (run now) is the default cursor position.
      for (;;) {
        choice = await ctx.ui.select(`确认目标 #${goal.id} 的 ${texts.length} 项 TODO？\n\n${approvalText}\n\n${serializeGoalTemplate({ ...definition, approvals: undefined, constraints, acceptance, todos: texts })}`, [RUN_NOW, RUN_LATER, EDIT_TODOS, CANCEL_PLAN]);
        if (!valid() || !choice || choice === CANCEL_PLAN) return stopped();
        if (choice !== EDIT_TODOS) break;
        const edited = await ctx.ui.editor(`目标 #${goal.id} · 编辑 TODO（每行一项）`, texts.join("\n"));
        if (!valid()) return stopped();
        const lines = edited?.split("\n").map((text) => text.trim()).filter(Boolean) ?? [];
        if (lines.length) texts = lines;
        else ctx.ui.notify("TODO 未修改（编辑已取消或内容为空）。", "info");
      }
      goal.todos = texts.map((text, index) => ({ id: index + 1, text, status: "pending" }));
      goal.constraints = constraints;
      goal.acceptance = acceptance;
      goal.objective = definition.objective;
      goal.benchmarks = definition.benchmarks;
      goal.checks = definition.checks;
      goal.reviewLoop = definition.reviewLoop;
      // Confirming the plan is the user's one-time approval of the listed actions.
      goal.approvals = approvals.length ? approvals : undefined;
      goal.approvalsConfirmed = approvals.length > 0;
      goal.planConfirmed = true;
      goal.status = "pending";
      planningId = undefined;
      save(ctx);
      if (choice === RUN_NOW) {
        autoStartId = goal.id;
        return { content: [{ type: "text", text: "TODO plan confirmed and saved. The user chose to run it now: the plugin starts execution automatically in a new turn after this one. End this turn now with a brief acknowledgement; do not start any task work here." }], details: undefined };
      }
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
      runWorked = true;
      todo.completedAt = params.status === "done" ? (todo.status === "done" ? todo.completedAt ?? new Date().toISOString() : new Date().toISOString()) : undefined;
      todo.status = params.status;
      todo.evidence = params.evidence?.trim() || undefined;
      save(ctx);
      return { content: [{ type: "text", text: todoLabel(todo) }], details: structuredClone(todo) };
    },
  });

  function pause(goal: Goal, ctx: ExtensionContext) {
    if (resumableId === goal.id) resumableId = undefined;
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
    if (autoStartId === goal.id) {
      autoStartId = undefined;
      if (goal.status !== "pending" || !goal.planConfirmed) return;
      // Prompts sent while settling are deferred by Pi until the planning run has fully ended.
      if (event.aborted || runFailed) ctx.ui.notify(`目标 #${goal.id} 已确认，但规划运行被中断，未自动执行；可在 /goal 中启动。`, "warning");
      else start(goal, ctx);
      return;
    }
    if (continuingId === goal.id) continuingId = undefined;
    if (goal.status !== "running") return;
    for (const todo of goal.todos ?? []) if (todo.status === "running") todo.status = "pending";
    goal.status = event.aborted || runFailed ? "paused" : "review";
    // Every TODO done (each with verification evidence): mark the goal done; it can be reopened.
    if (goal.status === "review" && autoCompletes(goal)) {
      goal.status = "done";
      ctx.ui.notify(`目标 #${goal.id} 的 TODO 已全部完成，已自动标记完成；如需继续可在 /goal 中重新打开。`, "info");
    }
    // Unfinished work after a run that worked on the goal: my next message continues it (once).
    resumableId = goal.status === "review" && runWorked && goal.todos?.some((todo) => todo.status !== "done") ? goal.id : undefined;
    runWorked = false;
    save(ctx);
  });

  /**
   * Continue the resumable goal with my next ordinary message (not a command or shell escape), so a
   * reply to a blocking question resumes execution and goal_todo works without another /goal step.
   */
  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || event.streamingBehavior || /^[/!]/.test(event.text.trim())) return;
    const goal = resumableGoal();
    resumableId = undefined;
    if (!goal || activeId !== undefined || !ctx.isIdle()) { if (!goal) refresh(ctx); return; }
    goal.status = "running";
    activeId = goal.id;
    continuingId = goal.id;
    runFailed = false;
    runWorked = false;
    save(ctx);
  });

  pi.on("before_agent_start", () => {
    const goal = state.goals.find((item) => item.id === continuingId && item.status === "running");
    if (!goal) return;
    return {
      message: {
        customType: "pi-goal-continue",
        display: false,
        content: [
          `[pi-goal] This turn continues goal #${goal.id}, which ended its previous run with unfinished TODOs. If my message answers or unblocks it, continue the goal and use goal_todo; if it is unrelated, handle my message and leave the goal's TODOs unchanged.`,
          `Goal: ${goal.text}`,
          `TODOs:\n${(goal.todos ?? []).map(todoLabel).join("\n")}`,
          approvalInstructions(goal),
          BLOCKER_GUIDANCE,
        ].join("\n\n"),
        details: { goalId: goal.id },
      },
    };
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const goal = state.goals.find((item) => item.id === activeId);
    if (goal?.status === "running" || goal?.status === "clarifying") {
      goal.status = "paused";
      save(ctx);
    }
    activeId = undefined;
    autoStartId = undefined;
    resumableId = undefined;
    continuingId = undefined;
    stopTicker();
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
    const paint = paintFor(ctx);
    let index = 0;
    while (isCurrent()) {
      const todos = goal.todos ?? [];
      // Status header (formerly the separate "s" view) above the TODO list.
      const header = statusHeader(goal, undefined, paint);
      const title = header.join("\n");
      let todo: GoalTodo | undefined;
      if (ctx.mode === "tui") {
        const picked = await showTodoList(ctx, header, todos, index);
        if (!isCurrent() || picked === undefined) return;
        index = picked;
        todo = todos[picked];
      } else {
        // Dialog-only clients: one line per TODO, symbol plus note.
        const labels = todos.map((item) => [todoLine(item), todoNote(item)].filter(Boolean).join(" · "));
        const selected = await ctx.ui.select(title, [...labels, "返回目标列表"]);
        if (!isCurrent() || !selected || selected === "返回目标列表") return;
        todo = todos[labels.indexOf(selected)];
      }
      if (!todo) continue;
      const action = await ctx.ui.select(todoListLines(todo, paint).join("\n"), [
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
        if (autoCompletes(goal) && goal.status !== "done") {
          goal.status = "done";
          ctx.ui.notify(`目标 #${goal.id} 的 TODO 已全部完成，已自动标记完成。`, "info");
        }
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
    let directories: string[] = [];
    try {
      const registry = knownWorkspaces(getAgentDir());
      directories = registry.workspaces;
      for (const error of registry.errors) ctx.ui.notify(`目标目录无效，已跳过：${error}`, "warning");
    } catch (error) {
      ctx.ui.notify(`无法读取目标目录：${String(error)}`, "warning");
    }
    for (const directory of directories) {
      if (directory === workspace) continue;
      try {
        const loaded = new GoalStorage(getAgentDir(), directory).load();
        const validated = validateGoals(loaded.goals);
        const errors = [...loaded.errors, ...validated.errors];
        if (errors.length) ctx.ui.notify(`workspace ${directory} 中有 ${errors.length} 个目标文件无效，已跳过`, "warning");
        all.push(...validated.goals.map((goal) => ({ ...goal, workspace: directory })));
      } catch (error) {
        ctx.ui.notify(`无法读取 workspace ${directory}：${String(error)}`, "warning");
      }
    }
    return [
      { title: "当前 Session", goals: sortGoals(state.goals.filter((goal) => goal.sessionId === ctx.sessionManager.getSessionId())) },
      { title: "当前 Workspace", goals: sortGoals(state.goals) },
      { title: "所有 Goal", goals: sortGoals(all) },
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
      // Imported approvals are suggestions only; the user approves them when confirming a plan.
      approvals: template.approvals, approvalsConfirmed: false,
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

  function goalDetails(goal: Goal, paint: Paint = plain): string {
    return [
      `${goalStatusText(goal, paint)} · #${goal.id} ${goal.text.replace(/\s+/g, " ")}`, `Workspace: ${goal.workspace}`, `Session: ${goal.sessionId ?? "未知"}`, `UUID: ${goal.uuid}`,
      ...(goal.todos ?? []).flatMap((todo) => todoListLines(todo, paint, "  ")),
      ...approvalSummary(goal, paint),
      "", serializeGoalTemplate(templateFromGoal(goal)),
    ].join("\n");
  }

  /**
   * Most likely action first (pause a running goal, reopen a done one, mark done once every TODO is
   * done, otherwise run / continue), then the other frequent actions, then sharing and destructive ones.
   */
  function menuActions(goal: Goal): string[] {
    const active = goal.status === "running" || activeId === goal.id;
    const run = goal.planConfirmed ? "执行 / 继续" : "继续澄清";
    const primary = active ? "暂停" : goal.status === "done" ? "重新打开" : allTodosDone(goal) ? "标记完成" : run;
    return [
      primary,
      ...(!active && primary !== run ? [run] : []),
      ...(!active && goal.status !== "done" && primary !== "标记完成" ? ["标记完成"] : []),
      "展开 TODO", "查看目标定义", "修改",
      ...(active || goal.status === "done" || goal.status === "paused" ? [] : ["暂停"]),
      "导出 Goal 模板", "保存为 Snippet", "取消目标", "删除", "返回列表",
    ];
  }

  /** One action on a goal in the current workspace. "exit" closes the panel (a run started). */
  async function goalMenu(goal: Goal, ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<"exit" | "back" | "done"> {
    const action = await ctx.ui.select(goalListLabel(goal, paintFor(ctx)), menuActions(goal));
    if (!isCurrent()) return "exit";
    if (!action || action === "返回列表") return "back";
    return runAction(goal, action, ctx, isCurrent);
  }

  /** Shared by the action menu and panel shortcuts, so both apply the same state checks. */
  async function runAction(goal: Goal, action: string, ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<"exit" | "back" | "done"> {
    // A run may have settled while a dialog was open; operations check live state.
    if (action === "查看目标定义") {
      await ctx.ui.select([...approvalSummary(goal, paintFor(ctx)), serializeGoalTemplate(templateFromGoal(goal))].join("\n"), ["返回列表"]);
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
        try { serializeGoalTemplate(templateFromGoal({ ...goal, text: text.trim() })); } catch (error) {
          ctx.ui.notify(`目标文本无效，未修改：${String(error)}`, "warning");
          return "done";
        }
        goal.text = text.trim();
        goal.planConfirmed = false;
        // A changed goal needs its approvals confirmed again with the new plan.
        goal.approvalsConfirmed = false;
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

  /** New goal from scratch, a snippet or an imported template. Returns true when an AI turn started. */
  async function newGoalMenu(ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<boolean> {
    const choice = await ctx.ui.select("新增目标", ["空白目标", "从 Snippet 创建", "导入 Goal 模板", "返回"]);
    if (!isCurrent() || !choice || choice === "返回") return false;
    if (choice === "从 Snippet 创建") {
      let started = false;
      await sharing(async () => { started = await pickSnippet(ctx); }, ctx);
      return started;
    }
    if (choice === "导入 Goal 模板") {
      const path = await ctx.ui.editor("导入 .goal.sexp 文件路径（相对 workspace 或绝对路径）");
      if (isCurrent() && path?.trim()) await sharing(() => importTemplate(path.trim(), ctx), ctx);
      return false;
    }
    const text = await ctx.ui.editor("新增目标（接下来由 AI 提问澄清并确认 TODO）");
    if (!isCurrent() || !text?.trim()) return false;
    const goal = add(text, ctx);
    return !!goal && clarify(goal, ctx);
  }

  /** Panel shortcut on a goal of the current workspace; mirrors the action menu's availability. */
  async function shortcut(goal: Goal, key: string, ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<"exit" | "back" | "done"> {
    const active = goal.status === "running" || activeId === goal.id;
    if (key === "r" && active) {
      ctx.ui.notify(`目标 #${goal.id} 正在执行；按 p 暂停。`, "info");
      return "done";
    }
    if (key === "p" && !active && (goal.status === "done" || goal.status === "paused")) {
      ctx.ui.notify(`目标 #${goal.id} 未在执行，无需暂停。`, "info");
      return "done";
    }
    const action = { r: goal.planConfirmed ? "执行 / 继续" : "继续澄清", p: "暂停", t: "展开 TODO", e: "修改", c: "取消目标", d: "删除" }[key];
    return action ? runAction(goal, action, ctx, isCurrent) : "done";
  }

  /** TUI goal manager: one bordered picker; actions return to it with scope, search and selection kept. */
  async function tuiPanel(ctx: ExtensionCommandContext, isCurrent: () => boolean) {
    const view: PickerView = { scope: 0, query: "", searching: false };
    while (isCurrent()) {
      const result = await showGoalPicker(ctx, sections(ctx), view);
      if (!isCurrent() || result.type === "close") return;
      if (result.type === "key" && result.key === "n") {
        if (await newGoalMenu(ctx, isCurrent)) return;
        continue;
      }
      const goal = result.goal;
      if (!goal) {
        ctx.ui.notify("当前范围没有目标；按 n 新增或 Tab 切换范围。", "info");
        continue;
      }
      if (!state.goals.includes(goal)) {
        // Goals of other workspaces are read-only here.
        if (result.type === "open") await ctx.ui.select(goalDetails(goal, paintFor(ctx)), ["返回面板"]);
        else if (result.key === "t") await showTodoList(ctx, statusHeader(goal, undefined, paintFor(ctx)), goal.todos ?? [], 0, true);
        else ctx.ui.notify(`此目标属于 ${goal.workspace}，只读；请在对应 workspace 中执行或修改。`, "info");
        continue;
      }
      const outcome = result.type === "open" ? await goalMenu(goal, ctx, isCurrent) : await shortcut(goal, result.key, ctx, isCurrent);
      if (outcome === "exit") return;
    }
  }

  /** The /goal panel. With initial, it opens that goal's action menu directly and closes when the user leaves it. */
  async function panel(ctx: ExtensionCommandContext, initial?: Goal) {
    if (!ctx.hasUI) {
      ctx.ui.notify(initial ? goalDetails(initial) : sections(ctx).map((section) => `${section.title} (${section.goals.length})\n${section.goals.map((goal) => [goalListLabel(goal), ...(goal.todos ?? []).flatMap((todo) => todoListLines(todo, plain, "  "))].join("\n")).join("\n") || "暂无目标"}`).join("\n\n"), "info");
      return;
    }
    if (panelOpen) return;
    panelOpen = true;
    const currentGeneration = generation;
    const isCurrent = () => generation === currentGeneration;
    try {
      if (initial) {
        while (isCurrent() && state.goals.includes(initial)) {
          if (await goalMenu(initial, ctx, isCurrent) !== "done") return;
        }
        return;
      }
      if (ctx.mode === "tui") return await tuiPanel(ctx, isCurrent);
      // Dialog-only clients (RPC): select lists, starting with the current session.
      let scope = 0;
      while (isCurrent()) {
        const groups = sections(ctx);
        const group = groups[scope]!;
        const choices = group.goals.map((goal) => `${goalListLabel(goal)}${scope === 2 ? ` · ${goal.workspace} · ${goal.uuid?.slice(0, 8)}` : ""}`);
        const switches = groups.map((other, index) => ({ index, label: `切换到：${other.title} (${other.goals.length})` })).filter((item) => item.index !== scope);
        const selected = await ctx.ui.select(`Goals · ${group.title} · ${group.goals.length} 个目标`, ["＋ 新增目标", ...choices, ...switches.map((item) => item.label), "关闭"]);
        if (!isCurrent() || !selected || selected === "关闭") return;
        const target = switches.find((item) => item.label === selected);
        if (target) { scope = target.index; continue; }
        if (selected === "＋ 新增目标") {
          if (await newGoalMenu(ctx, isCurrent)) return;
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
    "/goal                          打开目标面板（默认当前 Session；TUI 中 Tab 切换 Workspace / 所有 Goal）",
    "/goal <任务>                   新增目标并交互式澄清 TODO",
    "/goal #<编号>                  直接打开当前 workspace 的某个目标",
    "/goal status [#编号]           查看目标状态（默认：执行中目标或当前 Session 未完成目标）",
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

  function statusCommand(id: string | undefined, ctx: ExtensionContext) {
    if (id) {
      const goal = findGoal(id, ctx);
      if (goal) ctx.ui.notify(statusDetails(goal, undefined, paintFor(ctx)), "info");
      return;
    }
    const running = state.goals.find((goal) => goal.status === "running" && goal.id === activeId);
    ctx.ui.notify(running ? statusDetails(running, undefined, paintFor(ctx)) : statusSummary(state.goals.filter((goal) => goal.sessionId === ctx.sessionManager.getSessionId()), undefined, paintFor(ctx)), "info");
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
    if ((match = /^status(?:\s+#?(\d+))?$/.exec(text))) {
      statusCommand(match[1], ctx);
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
    if (goal && !clarify(goal, ctx)) ctx.ui.notify(`目标 #${goal.id} 已保存为待澄清，可在 /goal 面板继续。`, "info");
  }

  pi.registerCommand("goal", {
    description: "目标统一入口：/goal [任务 | #编号 | status | @snippet | import | export | help]",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      if (trimmed.startsWith("@")) {
        try {
          return listSnippets(getAgentDir()).snippets.filter((snippet) => `@${snippet.name}`.startsWith(trimmed))
            .map((snippet) => ({ value: `@${snippet.name} `, label: `@${snippet.name}`, description: snippet.template.title.split("\n")[0] }));
        } catch { return null; }
      }
      const items = [
        { value: "status", label: "status [#编号]", description: "查看目标状态与 TODO 进度" },
        ...(trimmed.startsWith("status ") ? state.goals : []).map((goal) => ({ value: `status #${goal.id}`, label: `status #${goal.id}`, description: goal.text.split("\n")[0] })),
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
