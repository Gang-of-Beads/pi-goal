import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

class PiRpc {
  records = [];
  waiters = new Set();
  stderr = "";
  sequence = 0;

  constructor(workspace, agentDirectory) {
    this.process = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "-e", join(root, "src/index.ts")], {
      cwd: workspace,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory, PI_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { this.records.push(JSON.parse(line)); }
        catch (error) { this.failure = new Error(`Invalid RPC output: ${line}`, { cause: error }); }
        this.wake();
      }
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.process.on("error", (error) => { this.failure = error; this.wake(); });
    this.process.on("exit", (code, signal) => {
      this.failure = new Error(`Pi exited: ${code ?? signal}\n${this.stderr}`);
      this.wake();
    });
  }

  wake() { for (const waiter of this.waiters) waiter(); }

  wait(predicate) {
    return new Promise((resolveWait, reject) => {
      const finish = (error, record) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error); else resolveWait(record);
      };
      const check = () => {
        if (this.failure) return finish(this.failure);
        const index = this.records.findIndex(predicate);
        if (index >= 0) finish(undefined, this.records.splice(index, 1)[0]);
      };
      const timer = setTimeout(() => finish(new Error(`RPC timeout\n${this.stderr}\n${JSON.stringify(this.records)}`)), 15000);
      this.waiters.add(check);
      check();
    });
  }

  send(record) { this.process.stdin.write(`${JSON.stringify(record)}\n`); }
  command(type, data = {}) {
    const id = `command-${++this.sequence}`;
    this.send({ id, type, ...data });
    return this.wait((record) => record.type === "response" && record.id === id).then((record) => {
      assert.equal(record.success, true, record.error);
      return record.data;
    });
  }
  dialog(method) {
    return this.wait((record) => record.type === "extension_ui_request" && record.method === method);
  }
  respond(request, data) { this.send({ type: "extension_ui_response", id: request.id, ...data }); }
  async select(text) {
    const request = await this.dialog("select");
    // List labels start with a status symbol, e.g. "○ #1 …"; match the label after it as well.
    const value = request.options.find((option) => option === text || option.startsWith(text) || option.replace(/^\S+ /, "").startsWith(text));
    assert.ok(value, `Missing ${text} in ${JSON.stringify(request.options)}`);
    this.respond(request, { value });
    return request;
  }
  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = once(this.process, "exit");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 5000);
    this.process.stdin.end();
    try { await exited; } finally { clearTimeout(timer); }
  }
}

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pi-goal-e2e-")));
  const workspace = join(temporary, "workspace");
  const agent = join(temporary, "agent");
  await mkdir(workspace, { recursive: true });
  await mkdir(agent, { recursive: true });
  const processes = [];
  t.after(async () => {
    try { for (const process of processes) await process.close(); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  });
  const start = async () => {
    const rpc = new PiRpc(workspace, agent);
    processes.push(rpc);
    const state = await rpc.command("get_state");
    const commands = await rpc.command("get_commands");
    assert.ok(commands.commands.some((command) => command.name === "goal"));
    return { rpc, state };
  };
  return { workspace, agent, start };
}

async function seed(workspace, sessionId, uuid = "01900000-0000-7000-8000-000000000001") {
  const directory = join(workspace, ".pi", "goals");
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  const goal = {
    id: 1, uuid, workspace, sessionId, text: "真实 RPC 面板测试目标", status: "pending",
    createdAt: now, updatedAt: now, answers: [{ question: "验收标准？", answer: "人工核验" }],
    planConfirmed: true, todos: [{ id: 1, text: "核验结果", status: "pending" }], history: [],
  };
  const path = join(directory, `${uuid}.json`);
  await writeFile(path, `${JSON.stringify(goal, null, 2)}\n`);
  return path;
}

async function openGoal(rpc, scope = "当前 Workspace") {
  const pending = rpc.command("prompt", { message: "/goal" });
  // RPC fallback opens on the current session; other scopes are list items.
  if (scope !== "当前 Session") await rpc.select(`切换到：${scope}`);
  await rpc.select("#1 ");
  return { pending };
}

test("real Pi RPC: TODO completion, timestamp, cancellation, restart and deletion", { timeout: 60000 }, async (t) => {
  const fixtureData = await fixture(t);
  const { rpc, state } = await fixtureData.start();
  const path = await seed(fixtureData.workspace, state.sessionId);
  await rpc.command("new_session");

  let { pending } = await openGoal(rpc);
  await rpc.select("展开 TODO");
  await rpc.select("TODO #1 ");
  await rpc.select("标记 TODO 完成");
  const editor = await rpc.dialog("editor");
  rpc.respond(editor, { value: "实际 RPC 人工验证通过" });
  const todoList = await rpc.select("返回目标列表");
  assert.ok(todoList.options.some((option) => option.startsWith("✓ TODO #1 ") && option.includes("完成于") && option.includes("说明：实际 RPC 人工验证通过")));
  // Dialog-only clients must not receive terminal escape codes.
  assert.ok(!JSON.stringify(rpc.records).includes("\\u001b"));
  await rpc.select("关闭");
  await pending;
  const completed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(completed.todos[0].status, "done");
  assert.ok(Number.isFinite(Date.parse(completed.todos[0].completedAt)));
  assert.equal(completed.todos[0].evidence, "实际 RPC 人工验证通过");
  assert.ok(completed.history.length > 0);

  ({ pending } = await openGoal(rpc));
  await rpc.select("取消目标");
  const cancellation = await rpc.select("取消目标，保留已有操作");
  assert.ok(cancellation.options.includes("取消目标，回滚所有操作"));
  await rpc.select("关闭");
  await pending;
  assert.equal(JSON.parse(await readFile(path, "utf8")).status, "cancelled");

  await rpc.close();
  const restarted = (await fixtureData.start()).rpc;
  ({ pending } = await openGoal(restarted));
  const actions = await restarted.select("删除");
  assert.match(actions.title, /^✗ #1 /);
  const confirm = await restarted.dialog("confirm");
  restarted.respond(confirm, { confirmed: true });
  await restarted.select("关闭");
  await pending;
  assert.deepEqual((await readdir(join(fixtureData.workspace, ".pi", "goals"))).filter((file) => file.endsWith(".json")), []);
});

test("real Pi RPC: S-expression sharing round-trips definitions without execution state", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc, state } = await data.start();
  const originalPath = await seed(data.workspace, state.sessionId);
  const original = JSON.parse(await readFile(originalPath, "utf8"));
  original.text = '目标 "引号" (括号)\n第二行 \\ 路径';
  original.status = "done";
  original.constraints = ["不改生产配置"];
  original.acceptance = ["HTTP 200"];
  original.todos[0] = { ...original.todos[0], text: '检查 "状态"\n下一步', status: "done", completedAt: new Date().toISOString(), evidence: "SECRET-EVIDENCE" };
  original.answers = [{ question: "秘密问题", answer: "SECRET-ANSWER" }];
  await writeFile(originalPath, JSON.stringify(original));
  await rpc.command("new_session");

  const exportPath = join(data.workspace, "shared goal.goal.sexp");
  let pending = rpc.command("prompt", { message: `/goal export 1 ${exportPath}` });
  const review = await rpc.dialog("editor");
  assert.ok(review.prefill.includes('(version 1)'));
  assert.ok(!review.prefill.includes("SECRET"));
  assert.ok(!review.prefill.includes(original.uuid));
  assert.ok(!review.prefill.includes(data.workspace));
  rpc.respond(review, { value: review.prefill });
  await pending;
  const exported = await readFile(exportPath, "utf8");
  assert.equal(exported, review.prefill);

  pending = rpc.command("prompt", { message: `/goal import ${exportPath}` });
  const confirmation = await rpc.dialog("confirm");
  assert.match(confirmation.message, /不执行表达式/);
  rpc.respond(confirmation, { confirmed: true });
  await pending;
  const files = (await readdir(join(data.workspace, ".pi", "goals"))).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 2);
  const importedFile = files.find((file) => file !== `${original.uuid}.json`);
  const imported = JSON.parse(await readFile(join(data.workspace, ".pi", "goals", importedFile), "utf8"));
  assert.notEqual(imported.uuid, original.uuid);
  assert.match(imported.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(imported.text, original.text);
  assert.deepEqual(imported.constraints, original.constraints);
  assert.deepEqual(imported.acceptance, original.acceptance);
  assert.equal(imported.status, "pending");
  assert.equal(imported.planConfirmed, true);
  assert.deepEqual(imported.answers, []);
  assert.equal(imported.todos[0].text, original.todos[0].text);
  assert.equal(imported.todos[0].status, "pending");
  assert.equal(imported.todos[0].completedAt, undefined);
  assert.equal(imported.todos[0].evidence, undefined);
  assert.equal((await rpc.command("get_state")).isStreaming, false);

  // Export never overwrites an existing file, even after user review.
  pending = rpc.command("prompt", { message: `/goal export 1 ${exportPath}` });
  const duplicate = await rpc.dialog("editor");
  rpc.respond(duplicate, { value: duplicate.prefill });
  await pending;
  assert.equal(await readFile(exportPath, "utf8"), exported);
  const failure = await rpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error");
  assert.match(failure.message, /EEXIST/);
});

test("real Pi RPC: design objective, all CHECK dimensions and bounded review survive import/restart/export", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc } = await data.start();
  const templatePath = join(root, "snippets/site-design.goal.sexp");
  let pending = rpc.command("prompt", { message: `/goal import ${templatePath}` });
  const confirmation = await rpc.dialog("confirm");
  assert.match(confirmation.message, /OVERRIDE_ALL/);
  assert.match(confirmation.message, /max-iterations 3/);
  rpc.respond(confirmation, { confirmed: true });
  await pending;
  const files = await readdir(join(data.workspace, ".pi", "goals"));
  assert.equal(files.length, 1);
  const path = join(data.workspace, ".pi", "goals", files[0]);
  const goal = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(goal.objective, { name: "site_design", priority: "OVERRIDE_ALL", target: "build page to award-tier visual standard" });
  assert.equal(goal.acceptance[0], "no visible improvement remaining across all CHECK dimensions");
  assert.deepEqual(goal.checks.map((check) => check.dimension), ["typography", "whitespace", "visual_hierarchy", "color", "motion", "micro_interaction", "responsive", "originality"]);
  assert.ok(goal.checks.every((check) => check.standard === "award_tier"));
  assert.equal(goal.benchmarks.length, 3);
  assert.equal(goal.reviewLoop.trigger, "on_completion");
  assert.equal(goal.reviewLoop.onGap, "patch-and-repeat");
  assert.equal(goal.reviewLoop.onPass, "stop");
  assert.equal(goal.reviewLoop.maxIterations, 3);
  assert.equal(goal.status, "clarifying");
  assert.equal(goal.planConfirmed, false);
  await rpc.close();
  const restarted = (await data.start()).rpc;
  ({ pending } = await openGoal(restarted));
  await restarted.select("查看目标定义");
  const definition = await restarted.select("返回列表");
  assert.match(definition.title, /micro_interaction/);
  assert.match(definition.title, /self_review/);
  await restarted.select("关闭");
  await pending;
  const exportedPath = join(data.workspace, "design.goal.sexp");
  pending = restarted.command("prompt", { message: `/goal export 1 ${exportedPath}` });
  const review = await restarted.dialog("editor");
  restarted.respond(review, { value: review.prefill });
  await pending;
  const exported = await readFile(exportedPath, "utf8");
  for (const dimension of goal.checks.map((check) => check.dimension)) assert.ok(exported.includes(`(check "${dimension}"`));
  assert.ok(exported.includes('(on-gap "patch-and-repeat")'));
  assert.ok(exported.includes('(on-pass "stop")'));
  assert.ok(exported.includes('(max-iterations 3)'));
  assert.equal((await restarted.command("get_state")).isStreaming, false);
});

test("real Pi RPC: snippets are reusable across workspaces, user snippets shadow built-ins and never overwrite", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc } = await data.start();

  // Built-in snippet through the picker, with project-specific context.
  let pending = rpc.command("prompt", { message: "/goal @" });
  const list = await rpc.select("site-design");
  assert.ok(list.options.some((option) => option.startsWith("site-design [\u5185\u7f6e]")));
  const context = await rpc.dialog("editor");
  rpc.respond(context, { value: "\u9996\u9875 https://example.test" });
  const confirmation = await rpc.dialog("confirm");
  assert.match(confirmation.message, /micro_interaction/);
  rpc.respond(confirmation, { confirmed: true });
  await pending;
  const goalsDirectory = join(data.workspace, ".pi", "goals");
  let goal = JSON.parse(await readFile(join(goalsDirectory, (await readdir(goalsDirectory))[0]), "utf8"));
  assert.match(goal.text, /^Build page to award-tier visual standard\n\n\u9996\u9875 https:\/\/example.test$/);
  assert.equal(goal.checks.length, 8);
  assert.equal(goal.status, "clarifying");
  assert.equal((await rpc.command("get_state")).isStreaming, false);

  // Save as a global user snippet (reviewed + edited), refusing duplicates.
  pending = rpc.command("prompt", { message: "/goal export 1 @site-design" });
  const review = await rpc.dialog("editor");
  rpc.respond(review, { value: review.prefill.replace(/\\n\\n\u9996\u9875 https:\/\/example.test/, "").replace("(max-iterations 3)", "(max-iterations 5)") });
  await pending;
  const saved = join(data.agent, "pi-goal", "snippets", "site-design.goal.sexp");
  const savedContent = await readFile(saved, "utf8");
  assert.ok(savedContent.includes("(max-iterations 5)"));
  assert.ok(!savedContent.includes("example.test"));
  pending = rpc.command("prompt", { message: "/goal export 1 @site-design" });
  const duplicate = await rpc.dialog("editor");
  rpc.respond(duplicate, { value: duplicate.prefill });
  await pending;
  const failure = await rpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error");
  assert.match(failure.message, /EEXIST/);
  assert.equal(await readFile(saved, "utf8"), savedContent);

  await rpc.command("prompt", { message: "/goal export 1 @Bad_Name" });
  const invalid = await rpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error");
  assert.match(invalid.message, /Snippet \u540d\u79f0/);
  await rpc.close();

  // Another workspace sharing the same Pi agent directory sees the user snippet, which shadows the built-in.
  const other = join(dirname(data.workspace), "other-frontend");
  await mkdir(other, { recursive: true });
  const otherRpc = new PiRpc(other, data.agent);
  t.after(() => otherRpc.close());
  await otherRpc.command("get_state");
  pending = otherRpc.command("prompt", { message: "/goal @site-design \u843d\u5730\u9875" });
  const otherConfirmation = await otherRpc.dialog("confirm");
  assert.match(otherConfirmation.message, /max-iterations 5/);
  otherRpc.respond(otherConfirmation, { confirmed: true });
  await pending;
  const otherGoals = join(other, ".pi", "goals");
  goal = JSON.parse(await readFile(join(otherGoals, (await readdir(otherGoals))[0]), "utf8"));
  assert.equal(goal.workspace, other);
  assert.equal(goal.reviewLoop.maxIterations, 5);
  assert.match(goal.text, /\u843d\u5730\u9875$/);

  await otherRpc.command("prompt", { message: "/goal @missing-snippet" });
  const missing = await otherRpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error");
  assert.match(missing.message, /missing-snippet/);

  // Cancelled use creates nothing.
  pending = otherRpc.command("prompt", { message: "/goal @site-design" });
  otherRpc.respond(await otherRpc.dialog("confirm"), { confirmed: false });
  await pending;
  assert.equal((await readdir(otherGoals)).filter((file) => file.endsWith(".json")).length, 1);
});

test("real Pi RPC: /goal is the single entry point; auxiliary commands are aliases", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc, state } = await data.start();
  const path = await seed(data.workspace, state.sessionId);
  await rpc.command("new_session");
  const notice = (type) => rpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === type);

  await rpc.command("prompt", { message: "/goal help" });
  const help = await notice("info");
  for (const usage of ["/goal @<snippet>", "/goal import", "/goal export <\u7f16\u53f7> @<\u540d\u79f0>"]) assert.ok(help.message.includes(usage), usage);
  assert.ok(help.message.includes("/goal #<\u7f16\u53f7>"));

  // /goal #<id> opens the goal's action menu directly; actions keep it open, leaving closes the panel.
  let pending = rpc.command("prompt", { message: "/goal #1" });
  const menu = await rpc.select("\u5c55\u5f00 TODO");
  assert.match(menu.title, /^○ #1 /);
  await rpc.select("\u8fd4\u56de\u76ee\u6807\u5217\u8868");
  await rpc.select("\u53d6\u6d88\u76ee\u6807");
  await rpc.select("\u53d6\u6d88\u76ee\u6807\uff0c\u4fdd\u7559\u5df2\u6709\u64cd\u4f5c");
  const updated = await rpc.select("\u8fd4\u56de\u5217\u8868");
  assert.match(updated.title, /^✗ #1 /);
  await pending;
  assert.equal(JSON.parse(await readFile(path, "utf8")).status, "cancelled");

  await rpc.command("prompt", { message: "/goal #99" });
  assert.match((await notice("warning")).message, /#99/);

  // Bare numbers are ambiguous: rejected with a hint, never opened or created as a goal.
  await rpc.command("prompt", { message: "/goal 1" });
  assert.match((await notice("warning")).message, /\/goal #1/);
  assert.deepEqual((await readdir(join(data.workspace, ".pi", "goals"))).filter((file) => file.endsWith(".json")), [path.split("/").pop()]);

  // Text that only resembles a subcommand creates an ordinary goal (no model: saved as draft).
  await rpc.command("prompt", { message: "/goal import the customer data" });
  assert.match((await notice("warning")).message, /\u5f85\u6f84\u6e05/);
  const goals = await Promise.all((await readdir(join(data.workspace, ".pi", "goals"))).map(async (file) => JSON.parse(await readFile(join(data.workspace, ".pi", "goals", file), "utf8"))));
  const created = goals.find((goal) => goal.id === 2);
  assert.equal(created.text, "import the customer data");
  assert.equal(created.status, "clarifying");

  // Invalid snippet names are rejected instead of becoming tasks.
  await rpc.command("prompt", { message: "/goal @Bad_Name" });
  assert.match((await notice("error")).message, /Snippet \u540d\u79f0/);

  // Auxiliary aliases route to the same behavior.
  const aliasPath = join(data.workspace, "alias.goal.sexp");
  pending = rpc.command("prompt", { message: `/goal-export 1 ${aliasPath}` });
  const review = await rpc.dialog("editor");
  rpc.respond(review, { value: review.prefill });
  await pending;
  pending = rpc.command("prompt", { message: `/goal-import ${aliasPath}` });
  rpc.respond(await rpc.dialog("confirm"), { confirmed: true });
  await pending;
  pending = rpc.command("prompt", { message: "/goal-snippet-save 1 alias-snippet" });
  const snippetReview = await rpc.dialog("editor");
  rpc.respond(snippetReview, { value: snippetReview.prefill });
  await pending;
  await readFile(join(data.agent, "pi-goal", "snippets", "alias-snippet.goal.sexp"), "utf8");
  pending = rpc.command("prompt", { message: "/goal-snippet alias-snippet" });
  rpc.respond(await rpc.dialog("confirm"), { confirmed: true });
  await pending;
  assert.equal((await readdir(join(data.workspace, ".pi", "goals"))).filter((file) => file.endsWith(".json")).length, 4);
  assert.equal((await rpc.command("get_state")).isStreaming, false);
});

test("real Pi RPC: invalid or cancelled template imports do not create goals", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc } = await data.start();
  const path = join(data.workspace, "invalid.goal.sexp");
  for (const content of [
    '(goal (version 2) (title "wrong version"))',
    '(goal (version 1) (title "duplicate") (title "other"))',
    '(goal (version 1) (title "unknown") (eval "touch marker"))',
    '(goal (version 1) (title "trailing")) (goal)',
    '(goal (version 1) (title "unclosed" miss)',
    '#.(exec "touch marker")',
    '(goal (version 1) (title "duplicate checks") (checks (check "color" (standard "x")) (check "color" (standard "y"))))',
    '(goal (version 1) (title "unbounded") (review-loop (name "review") (trigger "on_completion") (read "page") (compare "benchmark") (on-gap "patch-and-repeat") (on-pass "stop") (max-iterations 0)))',
    '(goal (version 1) (title "bad objective") (objective (name "design") (priority "override-system") (target "page")))',
    "(".repeat(20) + ")".repeat(20),
    "x".repeat(65537),
  ]) {
    await writeFile(path, content);
    await rpc.command("prompt", { message: `/goal import ${path}` });
    const error = await rpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error");
    assert.match(error.message, /模板操作失败/);
  }
  await writeFile(path, '(goal (version 1) (title "cancelled") (todos (todo "do nothing")))');
  const pending = rpc.command("prompt", { message: `/goal import ${path}` });
  const confirmation = await rpc.dialog("confirm");
  rpc.respond(confirmation, { confirmed: false });
  await pending;
  await assert.rejects(readdir(join(data.workspace, ".pi", "goals")), { code: "ENOENT" });
  assert.equal((await rpc.command("get_state")).isStreaming, false);
});

test("real Pi RPC: Session / Workspace / all scopes include foreign workspace read-only", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc, state } = await data.start();
  await seed(data.workspace, state.sessionId);
  const foreignWorkspace = join(dirname(data.workspace), "foreign");
  await seed(foreignWorkspace, "foreign-session", "01900000-0000-7000-8000-000000000002");
  const registry = join(data.agent, "pi-goal", "workspaces");
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, "foreign.json"), JSON.stringify({ workspace: foreignWorkspace }));
  await rpc.command("new_session");
  const pending = rpc.command("prompt", { message: "/goal" });
  const session = await rpc.select("切换到：所有 Goal");
  assert.match(session.title, /当前 Session · 0 个目标/);
  assert.deepEqual(session.options, ["＋ 新增目标", "切换到：当前 Workspace (1)", "切换到：所有 Goal (2)", "关闭"]);
  const list = await rpc.dialog("select");
  assert.ok(list.options.includes("切换到：当前 Session (0)"));
  const foreign = list.options.find((option) => option.includes(foreignWorkspace));
  assert.ok(foreign);
  rpc.respond(list, { value: foreign });
  const details = await rpc.select("返回列表");
  assert.deepEqual(details.options, ["返回列表"]);
  assert.match(details.title, /foreign-session/);
  assert.match(details.title, /TODO #1/);
  // Snippet and import live in the "new goal" submenu.
  await rpc.select("＋ 新增目标");
  const create = await rpc.select("返回");
  assert.deepEqual(create.options, ["空白目标", "从 Snippet 创建", "导入 Goal 模板", "返回"]);
  await rpc.select("关闭");
  await pending;
});

test("real Pi RPC: /goal status shows TODO icons, notes and elapsed time; interrupted runs settle on load", { timeout: 60000 }, async (t) => {
  const data = await fixture(t);
  const { rpc, state } = await data.start();
  const path = await seed(data.workspace, state.sessionId);
  const goal = JSON.parse(await readFile(path, "utf8"));
  const now = Date.now();
  // A run killed mid-way: still "running" with an open run that last updated 3 minutes after it began.
  Object.assign(goal, {
    status: "running", elapsedMs: 10 * 60_000,
    runStartedAt: new Date(now - 60 * 60_000).toISOString(), updatedAt: new Date(now - 57 * 60_000).toISOString(),
    todos: [
      { id: 1, text: "核验结果", status: "done", completedAt: new Date(now).toISOString(), evidence: "RPC 已核验" },
      { id: 2, text: "等待权限", status: "blocked", evidence: "缺少访问权限" },
      { id: 3, text: "收尾", status: "pending" },
    ],
  });
  await writeFile(path, `${JSON.stringify(goal)}\n`);
  await rpc.command("new_session");

  const notice = () => rpc.wait((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "info");
  await rpc.command("prompt", { message: "/goal status #1" });
  const details = (await notice()).message;
  assert.match(details, /^‖ 已暂停 · #1 真实 RPC 面板测试目标/);
  assert.doesNotMatch(details, /\u001b/);
  assert.match(details, /TODO 1\/3 · 累计执行 13 分钟 · 下一项：TODO #2/);
  assert.match(details, /\n {2}✓ TODO #1 核验结果\n {6}完成于 .+ · 说明：RPC 已核验/);
  assert.match(details, /\n {2}✗ TODO #2 等待权限\n {6}阻塞说明：缺少访问权限/);
  assert.match(details, /\n {2}○ TODO #3 收尾/);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.elapsedMs, 13 * 60_000);
  assert.equal(saved.runStartedAt, undefined);

  // Nothing is running and this new session owns no goals.
  await rpc.command("prompt", { message: "/goal status" });
  assert.match((await notice()).message, /当前 Session 没有未完成的目标/);
  // "status" is a subcommand, not a new goal.
  assert.equal((await readdir(join(data.workspace, ".pi", "goals"))).filter((file) => file.endsWith(".json")).length, 1);
  const widget = rpc.records.filter((record) => record.method === "setWidget").at(-1);
  assert.match(widget.widgetLines[0], /Goals · 1 个目标/);
});
