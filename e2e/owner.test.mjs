import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreGoals } from "../src/index.ts";
import { GoalConflictError, GoalStorage } from "../src/storage.ts";

const UUID = "01900000-0000-7000-8000-000000000001";
const RUN_START = "2025-01-01T00:00:00.000Z";

/** A persisted run updated 5 minutes after it began; 5 minutes of it are elapsed. */
function runningGoal(extra = {}) {
  return {
    id: 1, uuid: UUID, workspace: "/tmp/workspace", text: "goal", status: "running",
    createdAt: RUN_START, updatedAt: "2025-01-01T00:05:00.000Z", runStartedAt: RUN_START,
    planConfirmed: true, todos: [{ id: 1, text: "todo", status: "running" }], history: [],
    ...extra,
  };
}

function restoreGoal(goal, isAlive) {
  const entry = { type: "custom", customType: "pi-goal-state", data: { goals: [goal], nextId: goal.id + 1 } };
  return restoreGoals([entry], isAlive).goals[0];
}

test("a live foreign owner keeps its run open and the record byte-identical", () => {
  const goal = runningGoal({ ownerPid: 4242 });
  const restored = restoreGoal(goal, () => true);
  assert.equal(restored.status, "running");
  assert.equal(restored.runStartedAt, RUN_START);
  assert.equal(restored.elapsedMs, undefined);
  // A running TODO also stays running; nothing is normalized, so save() can skip the file.
  assert.equal(JSON.stringify(restored), JSON.stringify(goal));
});

test("a dead owner pauses the goal at its last update", () => {
  const restored = restoreGoal(runningGoal({ ownerPid: 4242 }), () => false);
  assert.equal(restored.status, "paused");
  assert.equal(restored.runStartedAt, undefined);
  assert.equal(restored.elapsedMs, 5 * 60_000);
  assert.equal(restored.todos[0].status, "pending");
});

test("this process is not its own live owner after reload or branching", () => {
  assert.equal(restoreGoal(runningGoal({ ownerPid: process.pid }), () => true).status, "paused");
});

test("older files without an owner pid are paused as before", () => {
  assert.equal(restoreGoal(runningGoal()).status, "paused");
});

test("an invalid owner pid rejects the snapshot", () => {
  assert.equal(restoreGoal(runningGoal({ ownerPid: 1.5 }), () => true), undefined);
});

test("the real pid probe tells a live child from an exited one", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  assert.equal(restoreGoal(runningGoal({ ownerPid: child.pid })).status, "running");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(restoreGoal(runningGoal({ ownerPid: child.pid })).status, "paused");
});

test("a cross-session conflict re-reads the file so the retry goes through", async (t) => {
  const agent = await realpath(await mkdtemp(join(tmpdir(), "pi-goal-conflict-")));
  t.after(() => rm(agent, { recursive: true, force: true }));
  const storage = new GoalStorage(agent, join(agent, "workspace"));
  await mkdir(storage.directory, { recursive: true });
  const path = join(storage.directory, `${UUID}.json`);
  const goal = runningGoal();
  await writeFile(path, `${JSON.stringify(goal, null, 2)}\n`);
  storage.load();
  // Another session wrote the same goal after our load.
  await writeFile(path, `${JSON.stringify({ ...goal, updatedAt: "2025-01-01T00:06:00.000Z" }, null, 2)}\n`);
  assert.throws(() => storage.write(goal), GoalConflictError);
  // The failed write re-baselined, so only this one is refused.
  storage.write(goal);
  assert.equal(JSON.parse(await readFile(path, "utf8")).updatedAt, goal.updatedAt);
});
