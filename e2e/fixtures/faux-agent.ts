/**
 * Test-only extension: a "faux" model whose replies are scripted, so E2E tests can have the agent
 * call the plugin's tools without any real model or credentials. The script is a JSON file named by
 * PI_GOAL_FAUX_SCRIPT: an array of steps, each `{ "tool": name, "args": {…} }` (one tool call) or
 * `{ "text": "…" }` (a final answer). Each step is one assistant message.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

type Step = { tool: string; args?: Parameters<typeof fauxToolCall>[1] } | { text: string };

export default function fauxAgent(pi: ExtensionAPI) {
  const path = process.env.PI_GOAL_FAUX_SCRIPT;
  if (!path) return;
  const steps = JSON.parse(readFileSync(path, "utf8")) as Step[];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-agent" }] });
  faux.setResponses(steps.map((step) => "tool" in step
    ? fauxAssistantMessage(fauxToolCall(step.tool, step.args ?? {}), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText(step.text))));
  pi.registerProvider(faux.provider);
}
