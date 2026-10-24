import { closeSync, openSync, readSync, writeFileSync } from "node:fs";

export interface DesignObjective {
  name: string;
  priority: "normal" | "OVERRIDE_ALL";
  target: string;
}
export interface DesignCheck {
  dimension: string;
  standard: string;
}
export interface ReviewLoop {
  name: string;
  trigger: "on_completion";
  read: string;
  compare: string;
  onGap: "patch-and-repeat";
  onPass: "stop";
  maxIterations: number;
}

export interface GoalTemplate {
  objective?: DesignObjective;
  benchmarks?: string[];
  checks?: DesignCheck[];
  reviewLoop?: ReviewLoop;
  title: string;
  constraints: string[];
  acceptance: string[];
  todos: string[];
}

type Expr = string | { symbol: string } | Expr[];
const MAX_BYTES = 64 * 1024;

/** A small data-only grammar. No reader macros, evaluation, or arbitrary fields. */
export function parseGoalTemplate(source: string): GoalTemplate {
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES) throw new Error("Goal template exceeds 64 KiB.");
  let position = 0;
  let count = 0;
  function whitespace() {
    while (position < source.length) {
      if (/\s/.test(source[position]!)) { position++; continue; }
      if (source[position] === ";") {
        while (position < source.length && source[position] !== "\n") position++;
        continue;
      }
      break;
    }
  }
  function expression(depth: number): Expr {
    if (depth > 16 || ++count > 10000) throw new Error("Goal template is too complex.");
    whitespace();
    const character = source[position];
    if (character === "(") {
      position++;
      const items: Expr[] = [];
      while (true) {
        whitespace();
        if (position >= source.length) throw new Error("Missing closing parenthesis.");
        if (source[position] === ")") { position++; return items; }
        items.push(expression(depth + 1));
      }
    }
    if (character === '"') {
      const start = position++;
      while (position < source.length) {
        const current = source[position++];
        if (current === "\\") { position++; continue; }
        if (current === '"') return JSON.parse(source.slice(start, position)) as string;
      }
      throw new Error("Unterminated string.");
    }
    const match = /^[a-zA-Z][a-zA-Z0-9-]*|^[0-9]+/.exec(source.slice(position));
    if (!match) throw new Error(`Unexpected character at offset ${position}.`);
    position += match[0].length;
    return { symbol: match[0] };
  }
  const root = expression(0);
  whitespace();
  if (position !== source.length) throw new Error("Only one goal expression is allowed.");
  const symbol = (value: Expr | undefined) => value && !Array.isArray(value) && typeof value === "object" ? value.symbol : undefined;
  if (!Array.isArray(root) || symbol(root[0]) !== "goal") throw new Error("Expected (goal ...).");
  const fields = new Map<string, Expr[]>();
  for (const field of root.slice(1)) {
    if (!Array.isArray(field)) throw new Error("Expected a goal field list.");
    const name = symbol(field[0]);
    if (!name || !["version", "title", "constraints", "acceptance", "todos", "objective", "benchmarks", "checks", "review-loop"].includes(name)) throw new Error(`Unknown goal field: ${name ?? "invalid"}.`);
    if (fields.has(name)) throw new Error(`Duplicate goal field: ${name}.`);
    fields.set(name, field.slice(1));
  }
  const version = fields.get("version");
  if (version?.length !== 1 || symbol(version[0]) !== "1") throw new Error("Only goal template version 1 is supported.");
  function strings(name: string): string[] {
    const values = fields.get(name) ?? [];
    if (values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${name} must contain nonempty quoted strings.`);
    return values as string[];
  }
  const title = strings("title");
  if (title.length !== 1) throw new Error("Exactly one title is required.");
  const todos = (fields.get("todos") ?? []).map((item) => {
    if (!Array.isArray(item) || item.length !== 2 || symbol(item[0]) !== "todo" || typeof item[1] !== "string" || !item[1].trim()) throw new Error('Expected (todo "text").');
    return item[1];
  });
  function subfields(name: string, allowed: string[]): Map<string, Expr[]> {
    const result = new Map<string, Expr[]>();
    for (const field of fields.get(name) ?? []) {
      if (!Array.isArray(field)) throw new Error(`Expected ${name} subfield list.`);
      const key = symbol(field[0]);
      if (!key || !allowed.includes(key)) throw new Error(`Unknown ${name} field: ${key ?? "invalid"}.`);
      if (result.has(key)) throw new Error(`Duplicate ${name} field: ${key}.`);
      result.set(key, field.slice(1));
    }
    return result;
  }
  function text(map: Map<string, Expr[]>, name: string): string {
    const values = map.get(name);
    if (values?.length !== 1 || typeof values[0] !== "string" || !values[0].trim()) throw new Error(`${name} requires one nonempty quoted string.`);
    return values[0];
  }
  const template: GoalTemplate = { title: title[0]!, constraints: strings("constraints"), acceptance: strings("acceptance"), todos };
  if (fields.has("objective")) {
    const objective = subfields("objective", ["name", "priority", "target"]);
    const priority = text(objective, "priority");
    if (priority !== "normal" && priority !== "OVERRIDE_ALL") throw new Error("Objective priority must be normal or OVERRIDE_ALL (goal-local only).");
    template.objective = { name: text(objective, "name"), priority, target: text(objective, "target") };
  }
  if (fields.has("benchmarks")) template.benchmarks = strings("benchmarks");
  if (fields.has("checks")) {
    template.checks = (fields.get("checks") ?? []).map((check) => {
      if (!Array.isArray(check) || check.length !== 3 || symbol(check[0]) !== "check" || typeof check[1] !== "string" || !check[1].trim()) throw new Error('Expected (check "dimension" (standard "standard")).');
      const standard = check[2];
      if (!Array.isArray(standard) || standard.length !== 2 || symbol(standard[0]) !== "standard" || typeof standard[1] !== "string" || !standard[1].trim()) throw new Error("A check requires exactly one standard.");
      return { dimension: check[1], standard: standard[1] };
    });
    if (new Set(template.checks.map((check) => check.dimension)).size !== template.checks.length) throw new Error("Duplicate check dimension.");
  }
  if (fields.has("review-loop")) {
    const review = subfields("review-loop", ["name", "trigger", "read", "compare", "on-gap", "on-pass", "max-iterations"]);
    if (text(review, "trigger") !== "on_completion" || text(review, "on-gap") !== "patch-and-repeat" || text(review, "on-pass") !== "stop") throw new Error("Unsupported review trigger or transition.");
    const iterations = review.get("max-iterations");
    const count = iterations?.length === 1 ? Number(symbol(iterations[0])) : NaN;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Review max-iterations must be an integer from 1 to 20.");
    if (!template.checks?.length || !template.benchmarks?.length) throw new Error("A review loop requires checks and benchmarks.");
    template.reviewLoop = {
      name: text(review, "name"), trigger: "on_completion", read: text(review, "read"), compare: text(review, "compare"),
      onGap: "patch-and-repeat", onPass: "stop", maxIterations: count,
    };
  }
  return template;
}

export function serializeGoalTemplate(template: GoalTemplate): string {
  const quote = (value: string) => JSON.stringify(value);
  const lines = ["(goal", "  (version 1)", `  (title ${quote(template.title)})`];
  for (const field of ["constraints", "acceptance"] as const) {
    if (template[field].length) lines.push(`  (${field}`, ...template[field].map((text) => `    ${quote(text)}`), "  )");
  }
  if (template.objective) {
    const objective = template.objective;
    lines.push("  (objective", `    (name ${quote(objective.name)})`, `    (priority ${quote(objective.priority)})`, `    (target ${quote(objective.target)})`, "  )");
  }
  if (template.benchmarks) lines.push("  (benchmarks", ...template.benchmarks.map((text) => `    ${quote(text)}`), "  )");
  if (template.checks) lines.push("  (checks", ...template.checks.map((check) => `    (check ${quote(check.dimension)} (standard ${quote(check.standard)}))`), "  )");
  if (template.reviewLoop) {
    const review = template.reviewLoop;
    lines.push("  (review-loop", `    (name ${quote(review.name)})`, `    (trigger ${quote(review.trigger)})`, `    (read ${quote(review.read)})`, `    (compare ${quote(review.compare)})`, `    (on-gap ${quote(review.onGap)})`, `    (on-pass ${quote(review.onPass)})`, `    (max-iterations ${review.maxIterations})`, "  )");
  }
  lines.push("  (todos", ...template.todos.map((text) => `    (todo ${quote(text)})`), "  )", ")");
  const content = `${lines.join("\n")}\n`;
  parseGoalTemplate(content);
  return content;
}

export function readGoalTemplate(path: string): GoalTemplate {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length > MAX_BYTES) throw new Error("Goal template exceeds 64 KiB.");
    return parseGoalTemplate(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    closeSync(descriptor);
  }
}

export function writeGoalTemplate(path: string, template: GoalTemplate) {
  if (!path.endsWith(".goal.sexp")) throw new Error("Export filename must end with .goal.sexp.");
  writeFileSync(path, serializeGoalTemplate(template), { flag: "wx", mode: 0o600 });
}
