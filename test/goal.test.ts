import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import goalExtension, { buildGoalPrompt, restoreGoals, type Goal } from "../src/index.ts";
import { GoalStorage } from "../src/storage.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const temporaryDirectories: string[] = [];
after(() => { for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true }); });

function setup(options: { hasUI?: boolean; idle?: boolean; entries?: SessionEntry[] } = {}) {
  let command: Command | undefined;
  let idle = options.idle ?? true;
  let abortCalls = 0;
  const messages: string[] = [];
  const notifications: string[] = [];
  const entries = options.entries ?? [];
  const registry = mkdtempSync(join(tmpdir(), "pi-goal-registry-"));
  temporaryDirectories.push(registry);
  process.env.PI_CODING_AGENT_DIR = registry;
  const cwd = mkdtempSync(join(tmpdir(), "pi-goal-"));
  temporaryDirectories.push(cwd);
  const selections: (string | undefined)[] = [];
  const inputs: (string | undefined)[] = [];
  const confirmations: boolean[] = [];
  const handlers = new Map<string, (event: any, ctx: ExtensionCommandContext) => unknown>();
  const tools = new Map<string, Tool>();
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionCommandContext) => unknown) { handlers.set(name, handler); },
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    registerCommand(name: string, value: Command) { assert.equal(name, "goal"); command = value; },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data: structuredClone(data) } as SessionEntry);
    },
    sendUserMessage(message: string) { messages.push(message); idle = false; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    isIdle: () => idle,
    abort() { abortCalls++; },
    async waitForIdle() { handlers.get("agent_settled")!({ aborted: true }, ctx); idle = true; },
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session" },
    ui: {
      notify(message: string) { notifications.push(message); },
      setWidget() {},
      async select(_title: string, choices: string[]) {
        if (_title === "Goals · 选择范围" && !selections[0]?.startsWith("当前") && !selections[0]?.startsWith("所有") && selections[0]?.startsWith("#")) return choices[1];
        const selection = selections.shift();
        return selection?.startsWith("#") ? choices.find((choice) => choice.startsWith(`${selection} `)) :
          selection?.startsWith("TODO #") ? choices.find((choice) => choice.startsWith(`${selection} `)) : selection;
      },
      async editor() { return inputs.shift(); },
      async confirm() { return confirmations.shift() ?? false; },
    },
  } as unknown as ExtensionCommandContext;
  goalExtension(pi);
  handlers.get("session_start")!({}, ctx);
  const run = (args = "") => command!.handler(args, ctx);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  const tool = (name: string, params: object, signal?: AbortSignal) => tools.get(name)!.execute("test", params, signal, undefined, ctx as unknown as Parameters<Tool["execute"]>[4]);
  const settle = (aborted = false, outcome = "completed") => {
    emit("agent_before_settle", { outcome }); emit("agent_settled", { aborted }); idle = true;
  };
  async function plannedGoal() {
    await run("添加健康检查");
    inputs.push("实现健康检查接口\n验证健康检查结果");
    confirmations.push(true);
    await tool("goal_plan", { goalId: 1, action: "confirm", todos: ["实现接口", "验证"] });
    settle();
  }
  async function executeGoal() {
    await plannedGoal();
    selections.push("#1", "执行 / 继续");
    await run();
  }
  return {
    run, emit, tool, settle, plannedGoal, executeGoal,
    goals: () => {
      const directory = join(cwd, ".pi", "goals");
      try { return readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as Goal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    cwd, ctx, messages, notifications, entries, selections, inputs, confirmations,
    setIdle: (value: boolean) => { idle = value; },
    abortCalls: () => abortCalls,
  };
}

test("goal prompt requires validation and approvals", () => {
  const prompt = buildGoalPrompt("  修复测试\n补充文档  ");
  assert.ok(prompt.includes("\n\n修复测试\n补充文档\n\n"));
  assert.ok(prompt.includes("Validate the result"));
  assert.ok(prompt.includes("not blanket authorization"));
});

test("/goal text starts clarification, not execution", async () => {
  const app = setup();
  await app.run("目标");
  assert.equal(app.goals()[0]!.status, "clarifying");
  assert.equal(app.goals()[0]!.planConfirmed, false);
  assert.match(app.messages[0]!, /planning only/);
  assert.match(app.messages[0]!, /goal_plan action ask/);
});

test("AI questions save user answers and confirmed edited TODOs do not auto-execute", async () => {
  const app = setup();
  await app.run("目标");
  app.inputs.push("只做本地接口");
  await app.tool("goal_plan", { goalId: 1, action: "ask", question: "范围是什么？" });
  assert.deepEqual(app.goals()[0]!.answers, [{ question: "范围是什么？", answer: "只做本地接口" }]);
  app.inputs.push("实现接口\n验证输出");
  app.confirmations.push(true);
  await app.tool("goal_plan", { goalId: 1, action: "confirm", todos: ["AI 建议"] });
  assert.equal(app.goals()[0]!.status, "pending");
  assert.equal(app.goals()[0]!.planConfirmed, true);
  assert.deepEqual(app.goals()[0]!.todos?.map((todo) => todo.text), ["实现接口", "验证输出"]);
  assert.equal(app.messages.length, 1);
  app.settle();
  assert.equal(app.goals()[0]!.status, "pending");
});

test("cancelled question or rejected plan remains unconfirmed and stops further tool calls", async () => {
  for (const action of ["ask", "confirm"]) {
    const app = setup();
    await app.run("目标");
    app.inputs.push(action === "ask" ? undefined : "计划");
    app.confirmations.push(false);
    await app.tool("goal_plan", { goalId: 1, action, question: "范围？", todos: ["计划"] });
    assert.equal(app.goals()[0]!.planConfirmed, false);
    assert.equal(app.goals()[0]!.status, "clarifying");
    await assert.rejects(app.tool("goal_plan", { goalId: 1, action: "ask", question: "再次提问" }), /not currently/);
  }
});

test("busy agents only save drafts; panel creation starts clarification when idle", async () => {
  const busy = setup({ idle: false });
  await busy.run("目标");
  assert.equal(busy.messages.length, 0);
  assert.equal(busy.goals()[0]!.status, "clarifying");
  const app = setup();
  app.selections.push("＋ 新增目标");
  app.inputs.push("面板目标");
  await app.run();
  assert.equal(app.goals()[0]!.text, "面板目标");
  assert.equal(app.messages.length, 1);
});

test("confirmed execution includes TODOs and evidence updates record completion time", async () => {
  const app = setup();
  await app.executeGoal();
  assert.match(app.messages[1]!, /Confirmed TODOs/);
  assert.match(app.messages[1]!, /goal_todo/);
  await assert.rejects(app.tool("goal_todo", { goalId: 1, todoId: 1, status: "done" }), /evidence/);
  await app.tool("goal_todo", { goalId: 1, todoId: 1, status: "done", evidence: "curl returned 200" });
  const todo = app.goals()[0]!.todos![0]!;
  assert.equal(todo.status, "done");
  assert.ok(Number.isFinite(Date.parse(todo.completedAt!)));
  assert.equal(todo.evidence, "curl returned 200");
  const time = todo.completedAt;
  await app.tool("goal_todo", { goalId: 1, todoId: 1, status: "done", evidence: "verified again" });
  assert.equal(app.goals()[0]!.todos![0]!.completedAt, time);
  await app.tool("goal_todo", { goalId: 1, todoId: 1, status: "pending" });
  assert.equal(app.goals()[0]!.todos![0]!.completedAt, undefined);
  app.settle();
  assert.equal(app.goals()[0]!.status, "review");
  assert.equal(app.goals()[0]!.todos![0]!.status, "pending");
});

test("expanded TODOs support manual completion and reopening without completing the goal", async () => {
  const app = setup();
  await app.plannedGoal();
  app.selections.push("#1", "展开 TODO", "TODO #1", "标记 TODO 完成", "返回目标列表", "关闭");
  app.inputs.push("人工验证通过");
  await app.run();
  assert.equal(app.goals()[0]!.todos![0]!.status, "done");
  assert.ok(app.goals()[0]!.todos![0]!.completedAt);
  assert.equal(app.goals()[0]!.status, "pending");
  app.selections.push("#1", "展开 TODO", "TODO #1", "重新打开 TODO", "返回目标列表", "关闭");
  await app.run();
  assert.equal(app.goals()[0]!.todos![0]!.completedAt, undefined);
});

test("pausing rejects stale AI TODO updates; resuming preserves plan", async () => {
  const app = setup();
  await app.executeGoal();
  await app.tool("goal_todo", { goalId: 1, todoId: 1, status: "running" });
  app.selections.push("#1", "暂停", "关闭");
  await app.run();
  assert.equal(app.abortCalls(), 1);
  assert.equal(app.goals()[0]!.todos![0]!.status, "pending");
  await assert.rejects(app.tool("goal_todo", { goalId: 1, todoId: 1, status: "done", evidence: "old result" }), /not currently/);
  app.settle(true);
  app.selections.push("#1", "执行 / 继续");
  await app.run();
  assert.match(app.messages.at(-1)!, /Continue goal #1/);
});

test("goal edits require reclarification and unfinished TODOs prevent goal completion", async () => {
  const app = setup();
  await app.plannedGoal();
  app.selections.push("#1", "标记完成", "关闭");
  await app.run();
  assert.equal(app.goals()[0]!.status, "pending");
  app.selections.push("#1", "修改", "关闭");
  app.inputs.push("新目标");
  await app.run();
  assert.equal(app.goals()[0]!.planConfirmed, false);
  assert.equal(app.goals()[0]!.status, "clarifying");
});

test("cancellation preserves or requests scoped rollback and never completes cancelled TODOs", async () => {
  for (const rollback of [false, true]) {
    const app = setup();
    await app.executeGoal();
    app.selections.push("#1", "取消目标", rollback ? "取消目标，回滚所有操作" : "取消目标，保留已有操作", "关闭");
    await app.run();
    assert.equal(app.goals()[0]!.status, "cancelled");
    assert.equal(app.abortCalls(), 1);
    assert.equal(app.messages.length, rollback ? 3 : 2);
    if (rollback) assert.match(app.messages.at(-1)!, /request explicit approval/);
    app.settle();
    assert.equal(app.goals()[0]!.status, "cancelled");
  }
});

test("reload preserves plans and timestamps, pauses running flags, and supports legacy snapshots", async () => {
  const app = setup();
  await app.executeGoal();
  await app.tool("goal_todo", { goalId: 1, todoId: 1, status: "done", evidence: "checked" });
  await app.tool("goal_todo", { goalId: 1, todoId: 2, status: "running" });
  const snapshot = { type: "custom", customType: "pi-goal-state", data: { goals: app.goals(), nextId: 2 } } as unknown as SessionEntry;
  const restored = restoreGoals([snapshot]);
  assert.equal(restored.goals[0]!.status, "paused");
  assert.equal(restored.goals[0]!.todos![0]!.completedAt, app.goals()[0]!.todos![0]!.completedAt);
  assert.equal(restored.goals[0]!.todos![1]!.status, "pending");
  const legacy = { type: "custom", customType: "pi-goal-state", data: { goals: [{ id: 1, text: "旧目标", status: "pending" }], nextId: 2 } } as unknown as SessionEntry;
  assert.equal(restoreGoals([legacy]).goals[0]!.text, "旧目标");
  const invalid = structuredClone(legacy) as any;
  invalid.data.goals[0].todos = [{ id: 1, text: "TODO", status: "done", completedAt: "invalid" }];
  assert.deepEqual(restoreGoals([snapshot, invalid]), restored);
});

test("session changes and aborted question dialogs do not write stale answers", async () => {
  for (const abort of [false, true]) {
    const app = setup();
    await app.run("目标");
    const controller = new AbortController();
    app.ctx.ui.editor = async () => {
      if (abort) controller.abort(); else app.emit("session_start");
      return "旧答案";
    };
    await app.tool("goal_plan", { goalId: 1, action: "ask", question: "范围？" }, controller.signal);
    assert.deepEqual(app.goals()[0]!.answers, []);
  }
});

test("UUIDv7 JSON files contain full goal state and survive reload", async () => {
  const app = setup();
  await app.plannedGoal();
  const goal = app.goals()[0]!;
  assert.match(goal.uuid!, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(readFileSync(join(app.cwd, ".pi", "goals", `${goal.uuid}.json`), "utf8").includes("planConfirmed"));
  assert.ok(goal.createdAt);
  assert.ok(goal.history?.length);
  app.emit("session_start");
  assert.deepEqual(app.goals()[0]!.todos, goal.todos);
  app.selections.push("#1", "删除", "关闭");
  app.confirmations.push(true);
  await app.run();
  assert.deepEqual(app.goals(), []);
});

test("storage refuses to overwrite modifications from another loaded instance", async () => {
  const app = setup();
  await app.plannedGoal();
  const first = new GoalStorage(app.cwd);
  const second = new GoalStorage(app.cwd);
  const original = first.load()[0]!;
  const competing = second.load()[0]!;
  original.text = "first edit";
  first.write(original);
  competing.text = "second edit";
  assert.throws(() => second.write(competing), /another session/);
  assert.equal(first.load()[0]!.text, "first edit");
});

test("non-UI clients can save drafts but cannot bypass interactive confirmation", async () => {
  const app = setup({ hasUI: false });
  await app.run("目标");
  await assert.rejects(app.tool("goal_plan", { goalId: 1, action: "confirm", todos: ["TODO"] }), /requires a UI/);
  app.settle();
  await app.run();
  assert.match(app.notifications.at(-1)!, /待澄清/);
  assert.match(app.notifications.at(-1)!, /当前 Session/);
  assert.match(app.notifications.at(-1)!, /当前 Workspace/);
  assert.match(app.notifications.at(-1)!, /所有 Goal/);
});
