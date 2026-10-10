import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Goal } from "./index.ts";

export function registerWorkspace(root: string, cwd: string) {
  const workspace = resolve(cwd);
  const directory = join(root, "pi-goal", "workspaces");
  mkdirSync(directory, { recursive: true });
  const key = createHash("sha256").update(workspace).digest("hex");
  const path = join(directory, `${key}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ workspace })}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function knownWorkspaces(root: string): string[] {
  const directory = join(root, "pi-goal", "workspaces");
  let names: string[];
  try { names = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => {
    const data = JSON.parse(readFileSync(join(directory, name), "utf8")) as { workspace?: unknown };
    if (typeof data.workspace !== "string") throw new Error(`Invalid workspace registry: ${name}`);
    return resolve(data.workspace);
  });
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One atomic JSON file per goal. Refuse to overwrite another session's edits. */
export class GoalStorage {
  private originals = new Map<string, string>();
  readonly directory: string;

  constructor(cwd: string) {
    this.directory = join(cwd, ".pi", "goals");
  }

  private path(uuid: string): string {
    if (!UUID_V7.test(uuid)) throw new Error("Invalid goal UUIDv7.");
    return join(this.directory, `${uuid}.json`);
  }

  load(): Goal[] {
    this.originals.clear();
    let names: string[];
    try { names = readdirSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => name.endsWith(".json")).sort().map((name) => {
      const uuid = name.slice(0, -5);
      const content = readFileSync(this.path(uuid), "utf8");
      const goal = JSON.parse(content) as Goal;
      if (goal.uuid !== uuid) throw new Error(`Goal UUID does not match filename: ${name}`);
      this.originals.set(uuid, content);
      return goal;
    });
  }

  private checkUnchanged(uuid: string) {
    let content: string | undefined;
    try { content = readFileSync(this.path(uuid), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content !== this.originals.get(uuid)) throw new Error(`Goal ${uuid} was changed in another session. Reload before editing.`);
  }

  write(goal: Goal) {
    if (!goal.uuid) throw new Error("Goal UUID is required.");
    this.checkUnchanged(goal.uuid);
    mkdirSync(this.directory, { recursive: true });
    const path = this.path(goal.uuid);
    const temporary = `${path}.${process.pid}.tmp`;
    const content = `${JSON.stringify(goal, null, 2)}\n`;
    try {
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.originals.set(goal.uuid, content);
  }

  remove(goal: Goal) {
    if (!goal.uuid) throw new Error("Goal UUID is required.");
    this.checkUnchanged(goal.uuid);
    unlinkSync(this.path(goal.uuid));
    this.originals.delete(goal.uuid);
  }
}
