import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGoalTemplate, writeGoalTemplate, type GoalTemplate } from "./sexp.ts";

export interface GoalSnippet {
  name: string;
  source: "user" | "builtin";
  path: string;
  template: GoalTemplate;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUFFIX = ".goal.sexp";

export function validateSnippetName(name: string): string {
  if (!NAME.test(name)) throw new Error("Snippet 名称只能包含小写字母、数字和连字符，且以字母或数字开头（最多 64 个字符）。");
  return name;
}

export const builtinSnippetDirectory = fileURLToPath(new URL("../snippets/", import.meta.url));
export const userSnippetDirectory = (agentDirectory: string) => join(agentDirectory, "pi-goal", "snippets");

function readDirectory(directory: string, source: GoalSnippet["source"], errors: string[]): GoalSnippet[] {
  let names: string[];
  try { names = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((file) => file.endsWith(SUFFIX)).sort().flatMap((file) => {
    const name = file.slice(0, -SUFFIX.length);
    const path = join(directory, file);
    try {
      return [{ name: validateSnippetName(name), source, path, template: readGoalTemplate(path) }];
    } catch (error) {
      errors.push(`${path}: ${String(error)}`);
      return [];
    }
  });
}

/** User snippets shadow built-in snippets with the same name. Invalid files are reported, not loaded. */
export function listSnippets(agentDirectory: string): { snippets: GoalSnippet[]; errors: string[] } {
  const errors: string[] = [];
  const user = readDirectory(userSnippetDirectory(agentDirectory), "user", errors);
  const names = new Set(user.map((snippet) => snippet.name));
  const builtin = readDirectory(builtinSnippetDirectory, "builtin", errors).filter((snippet) => !names.has(snippet.name));
  return { snippets: [...user, ...builtin].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/** Never overwrites an existing user snippet. */
export function saveSnippet(agentDirectory: string, name: string, template: GoalTemplate): string {
  const directory = userSnippetDirectory(agentDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${validateSnippetName(name)}${SUFFIX}`);
  writeGoalTemplate(path, template);
  return path;
}
