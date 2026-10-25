import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Goal } from "./index.ts";

/** Root of all goal files: <agentDir>/pi-goal/goals, one subdirectory per workspace. */
export function goalsRoot(agentDir: string): string {
  return join(agentDir, "pi-goal", "goals");
}

/** Directory name for a workspace: SHA-256 of its absolute path. */
export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex");
}

const WORKSPACE_FILE = "workspace.json";

/**
 * Workspaces with stored goals, read from each directory's self-describing workspace.json.
 * Invalid directories are reported and skipped so one bad entry cannot hide every workspace.
 */
export function knownWorkspaces(agentDir: string): { workspaces: string[]; errors: string[] } {
  const root = goalsRoot(agentDir);
  let names: string[];
  try { names = readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspaces: [], errors: [] };
    throw error;
  }
  const workspaces: string[] = [];
  const errors: string[] = [];
  for (const name of names.filter((name) => /^[0-9a-f]{64}$/.test(name)).sort()) {
    const path = join(root, name, WORKSPACE_FILE);
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { workspace?: unknown } | null;
      if (typeof data?.workspace !== "string" || !data.workspace) throw new Error("missing workspace path");
      if (workspaceKey(data.workspace) !== name) throw new Error("workspace path does not match directory name");
      workspaces.push(resolve(data.workspace));
    } catch (error) {
      errors.push(`${path}: ${String(error)}`);
    }
  }
  return { workspaces, errors };
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One atomic JSON file per goal. Refuse to overwrite another session's edits. */
export class GoalStorage {
  private originals = new Map<string, string>();
  readonly directory: string;

  readonly workspace: string;

  /** Goals of `workspace` live in <agentDir>/pi-goal/goals/<sha256(workspace)>/; nothing is written to the project. */
  constructor(agentDir: string, workspace: string) {
    this.workspace = resolve(workspace);
    this.directory = join(goalsRoot(agentDir), workspaceKey(this.workspace));
  }

  /** Goal files only: the directory also holds workspace.json. */
  private goalFiles(names: string[]): string[] {
    return names.filter((name) => name.endsWith(".json") && name !== WORKSPACE_FILE);
  }

  /** Record which workspace this directory belongs to (atomic, written once or when missing). */
  private describe() {
    const path = join(this.directory, WORKSPACE_FILE);
    const content = `${JSON.stringify({ workspace: this.workspace })}\n`;
    try { if (readFileSync(path, "utf8") === content) return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private path(uuid: string): string {
    if (!UUID_V7.test(uuid)) throw new Error("Invalid goal UUIDv7.");
    return join(this.directory, `${uuid}.json`);
  }

  /**
   * Unreadable or malformed files are reported and skipped, never rewritten or deleted.
   * Directory-level failures still throw because nothing can be loaded safely.
   */
  load(): { goals: Goal[]; errors: string[] } {
    this.originals.clear();
    let names: string[];
    try { names = readdirSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { goals: [], errors: [] };
      throw error;
    }
    const goals: Goal[] = [];
    const errors: string[] = [];
    for (const name of this.goalFiles(names).sort()) {
      const uuid = name.slice(0, -5);
      try {
        const content = readFileSync(this.path(uuid), "utf8");
        const goal = JSON.parse(content) as Goal;
        if (!goal || typeof goal !== "object" || goal.uuid !== uuid) throw new Error("goal UUID does not match filename");
        this.originals.set(uuid, content);
        goals.push(goal);
      } catch (error) {
        errors.push(`${join(this.directory, name)}: ${String(error)}`);
      }
    }
    return { goals, errors };
  }

  /** Highest display ID currently on disk, including goals created by other sessions after load. */
  maxId(): number {
    let names: string[];
    try { names = readdirSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let max = 0;
    for (const name of this.goalFiles(names)) {
      try {
        const id = (JSON.parse(readFileSync(join(this.directory, name), "utf8")) as { id?: unknown }).id;
        if (Number.isSafeInteger(id) && (id as number) > max) max = id as number;
      } catch { /* Unreadable files are reported by load(); they cannot reserve an ID. */ }
    }
    return max;
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
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.describe();
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
