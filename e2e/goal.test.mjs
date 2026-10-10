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
    const value = request.options.find((option) => option === text || option.startsWith(text));
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
  await rpc.select(scope);
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
  assert.ok(todoList.options.some((option) => option.includes("已完成") && option.includes("完成于")));
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
  assert.match(actions.title, /已取消/);
  const confirm = await restarted.dialog("confirm");
  restarted.respond(confirm, { confirmed: true });
  await restarted.select("关闭");
  await pending;
  assert.deepEqual((await readdir(join(fixtureData.workspace, ".pi", "goals"))).filter((file) => file.endsWith(".json")), []);
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
  const scopes = await rpc.select("当前 Session");
  assert.deepEqual(scopes.options.slice(0, 3), ["当前 Session (0)", "当前 Workspace (1)", "所有 Goal (2)"]);
  const emptySession = await rpc.select("返回分区");
  assert.ok(!emptySession.options.some((option) => option.startsWith("#1")));
  await rpc.select("所有 Goal");
  const list = await rpc.dialog("select");
  const foreign = list.options.find((option) => option.includes(foreignWorkspace));
  assert.ok(foreign);
  rpc.respond(list, { value: foreign });
  const details = await rpc.select("返回列表");
  assert.deepEqual(details.options, ["返回列表"]);
  assert.match(details.title, /foreign-session/);
  assert.match(details.title, /TODO #1/);
  await rpc.select("关闭");
  await pending;
});
