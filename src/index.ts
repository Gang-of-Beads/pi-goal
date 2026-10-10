import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function buildGoalPrompt(goal: string): string {
  return [
    "Help me accomplish the following goal in the current project:",
    "",
    goal.trim(),
    "",
    "Understand the relevant context, make a concise plan when useful, and carry out the task using the available tools rather than only giving advice.",
    "Validate the result with appropriate checks. Report what was done, what was verified, and any remaining blockers; do not claim success without evidence.",
    "Ask for clarification when essential information is missing. Respect existing instructions and approval requirements; a goal is not blanket authorization for destructive or high-impact actions.",
  ].join("\n");
}

export default function goalExtension(pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Accomplish a goal with AI: /goal <task>",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait for it to finish before starting a goal.", "warning");
        return;
      }

      let goal = args.trim();
      if (!goal) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /goal <task>", "warning");
          return;
        }
        goal = (await ctx.ui.editor("What would you like to accomplish?"))?.trim() ?? "";
      }
      if (!goal) return;

      // The agent may have started work while the editor was open.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Please submit your goal again when it is idle.", "warning");
        return;
      }
      pi.sendUserMessage(buildGoalPrompt(goal));
    },
  });
}
