import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import goalExtension, { buildGoalPrompt } from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function setup(options: { hasUI?: boolean; idle?: boolean; input?: string } = {}) {
  let command: Command | undefined;
  let idle = options.idle ?? true;
  let editorCalls = 0;
  const messages: string[] = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, value: Command) {
      assert.equal(name, "goal");
      command = value;
    },
    sendUserMessage(message: string) { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: options.hasUI ?? true,
    isIdle: () => idle,
    ui: {
      notify(message: string) { notifications.push(message); },
      async editor() { editorCalls++; return options.input; },
    },
  } as unknown as ExtensionCommandContext;
  goalExtension(pi);
  assert.ok(command);
  return {
    run: (args: string) => command!.handler(args, ctx),
    ctx, messages, notifications,
    setIdle: (value: boolean) => { idle = value; },
    editorCalls: () => editorCalls,
  };
}

test("goal prompt preserves the task and requires verification and approvals", () => {
  const prompt = buildGoalPrompt("  修复测试\n补充文档  ");
  assert.ok(prompt.includes("\n\n修复测试\n补充文档\n\n"));
  assert.ok(prompt.includes("Validate the result"));
  assert.ok(prompt.includes("not blanket authorization"));
});

test("registers /goal and sends inline goals to the current agent", async () => {
  const app = setup();
  await app.run("  添加健康检查  ");
  assert.deepEqual(app.messages, [buildGoalPrompt("添加健康检查")]);
  assert.equal(app.editorCalls(), 0);
});

test("bare /goal opens an editor", async () => {
  const app = setup({ input: "  添加测试  " });
  await app.run("");
  assert.equal(app.editorCalls(), 1);
  assert.deepEqual(app.messages, [buildGoalPrompt("添加测试")]);
});

test("cancelled and whitespace-only input do not start a turn", async () => {
  for (const input of [undefined, "  \n  "]) {
    const app = setup({ input });
    await app.run("   ");
    assert.deepEqual(app.messages, []);
  }
});

test("without UI, empty goals show usage and inline goals still work", async () => {
  const app = setup({ hasUI: false });
  await app.run("");
  assert.equal(app.editorCalls(), 0);
  assert.match(app.notifications[0]!, /Usage/);
  await app.run("修复测试");
  assert.equal(app.messages.length, 1);
});

test("busy agents are not interrupted", async () => {
  const app = setup({ idle: false });
  await app.run("修复测试");
  assert.deepEqual(app.messages, []);
  assert.equal(app.editorCalls(), 0);
  assert.match(app.notifications[0]!, /busy/);
});

test("does not send if the agent became busy while editing", async () => {
  const app = setup();
  app.ctx.ui.editor = async () => {
    app.setIdle(false);
    return "修复测试";
  };
  await app.run("");
  assert.deepEqual(app.messages, []);
  assert.match(app.notifications[0]!, /busy/);
});
