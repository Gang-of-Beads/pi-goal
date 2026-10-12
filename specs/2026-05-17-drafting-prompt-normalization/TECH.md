# TECH — Implementation Plan

## Overview

Three deliverables: prompt normalization (goal-draft.ts), framing fix (goal.ts), and benchmark experiment (experiments/). Plus spec docs and tests.

## Files Changed

| File | Change |
|------|--------|
| `extensions/goal-draft.ts` | 1) Add iteration normalization text to `goalDraftingPrompt()` 2) Allow `PI_GOAL_AUTO_CONFIRM=0` to disable headless auto-confirm for benchmarking |
| `extensions/goal.ts` | Reframe post-Continue-Chatting tool result text |
| `tests/goal-draft.test.ts` | Add unit tests for normalization text |
| `experiments/cases/C19-iteration-frustration-benchmark/INPUT.md` | New: multi-iteration drafting simulation |
| `experiments/cases/C19-iteration-frustration-benchmark/benchmark.sh` | New: NDJSON analysis script |
| `experiments/cases/C19-iteration-frustration-benchmark/BENCH.md` | New: usage docs for before/after comparison |
| `specs/2026-05-17-drafting-prompt-normalization/PRODUCT.md` | Done |
| `specs/2026-05-17-drafting-prompt-normalization/TECH.md` | This file |

---

## Step 1: Prompt Normalization (`goal-draft.ts`)

### 1a — `goalDraftingPrompt()` — add iteration normalization

Insert two new items at the end of the `commonProtocol` array (after all existing protocol items, before the mode-specific items):

```ts
const commonProtocol = [
  // ... existing protocol items unchanged ...
  "- Multiple proposal-refinement cycles are normal and expected during goal drafting. Do NOT interpret repeated 'Continue Chatting' choices as frustration, rejection, or 'going in circles' — the user is simply refining the goal contract before confirming.",
  "- After the user chooses 'Continue Chatting': ask a focused question about what they want changed, then propose an updated draft. Do NOT re-propose the same content. Do NOT apologize for iterating.",
];
```

These apply to both `/goals` and `/sisyphus` modes because they're in `commonProtocol`.

**Rationale for placement at the end:** The existing order flows naturally (lightweight → vague → research → concrete → grill → propose). The iteration guidance applies *after* the first proposal has been made, so it makes sense as a capstone item after the `propose_goal_draft` instruction.

### 1b — `shouldAutoConfirmProposal()` — enable benchmark override (minor)

Change from:
```ts
export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	return !args.hasUI || args.autoConfirmEnv === "1";
}
```
To:
```ts
export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	if (args.autoConfirmEnv === "0") return false; // explicit opt-out (benchmarking)
	return !args.hasUI || args.autoConfirmEnv === "1";
}
```

This allows the experiment harness to set `PI_GOAL_AUTO_CONFIRM=0` to disable auto-confirm in headless mode. Without this, propose_goal_draft always auto-confirms when `hasUI=false`, making it impossible to simulate a "Continue Chatting" flow in the harness.

---

## Step 2: Framing Fix (`goal.ts`)

In the `propose_goal_draft` tool's execute handler, the `decision === "continue"` branch (~line 1680 in current file):

**Current:**
```ts
text: "User clicked 'Continue Chatting'. The goal was NOT created. Ask the user what they want to change about the draft (objective, scope, criteria, steps), then revise and call propose_goal_draft again. Do not call propose_goal_draft again with the same content — wait for the user's input first.",
```

**Replacement:**
```ts
text: "Goal draft refinement requested (Continue Chatting). The goal was not created — drafting remains active. Ask the user what they want changed about the draft (objective, scope, criteria, steps), then revise and call propose_goal_draft again. Do not re-propose the same content — wait for the user's input first.",
```

Changes:
| Before | After | Effect |
|--------|-------|--------|
| `"User clicked 'Continue Chatting'. The goal was NOT created."` | `"Goal draft refinement requested (Continue Chatting). The goal was not created — drafting remains active."` | Removes negative emphasis (`NOT` → `not`); frames as "refinement requested" not "rejection"; reaffirms drafting is active |
| `"ask the user what they want to change"` | `"ask the user what they want changed"` | Subtler tone shift: "want changed" (present perfect) vs "want to change" (infinitive) |
| `"Do not call propose_goal_draft again with the same content"` | `"Do not re-propose the same content"` | More direct: names the bad action ("re-propose the same") instead of naming the tool |

---

## Step 3: Unit Tests (`tests/goal-draft.test.ts`)

Add two new test cases:

```ts
test("goalDraftingPrompt normalizes multiple refinement cycles in goal mode", () => {
	const prompt = goalDraftingPrompt("build a parser", "goal");
	assert.match(prompt, /multiple proposal-refinement cycles are normal/i);
	assert.match(prompt, /do not interpret.*continue chatting.*frustration/i);
	assert.match(prompt, /after the user chooses.*continue chatting/i);
});

test("goalDraftingPrompt normalizes multiple refinement cycles in sisyphus mode", () => {
	const prompt = goalDraftingPrompt("1. step A\n2. step B", "sisyphus");
	assert.match(prompt, /multiple proposal-refinement cycles are normal/i);
	assert.match(prompt, /do not interpret.*continue chatting.*frustration/i);
	assert.match(prompt, /after the user chooses.*continue chatting/i);
});
```

Run `npm test` to confirm no regressions on existing tests.

---

## Step 4: Benchmark Experiment

### 4a — INPUT.md

Simulates 4 turns in a /goals drafting flow:

```md
# C19 — Benchmark for drafting iteration frustration
# Tests whether repeated refinement cycles trigger "going in circles" / "frustrated" language
# Environment: PI_GOAL_AUTO_CONFIRM=0 (disables headless auto-confirm so we can simulate Continue Chatting)

TURN: /goals Create a script that monitors disk usage on my server
TURN: Monitor /var/log and /home partitions, alert at 80%, send email
TURN: I'd like to refine this. Also monitor /tmp and use Slack instead of email for the alert.
TURN: One more refinement. Make it a systemd service instead of cron. And log to syslog.
```

How the turns drive the flow: the turns do not line up with the agent's tool calls one to one, because the agent decides when to call `propose_goal_draft` during its own turn. With `PI_GOAL_AUTO_CONFIRM=0`, every such call returns "continue" in headless mode, and the agent's next text response is the one to analyse:

1. `/goals Create a script...`: the agent asks questions.
2. `Monitor /var/log...`: the agent has enough to propose, calls `propose_goal_draft`, gets "continue", and asks what to change.
3. `I'd like to refine this...`: the agent revises and proposes again; same flow.
4. `One more refinement...`: same flow.

The analysis scans the NDJSON for the agent's text responses after each "continue" and checks them for frustrated or cycling language.

### 4b — benchmark.sh

A bash script that:
1. Scans `raw.ndjson` for assistant text messages
2. Checks each message for patterns like: "going in circles", "round and round", "frustrated", "apologize/apologise", "sorry", "repetitive", "feel like we're"
3. Outputs a structured `bench-result.json`

```json
{
  "case": "C19-iteration-frustration-benchmark",
  "run_at": "2026-05-17T...",
  "patterns_checked": ["going in circles", "round and round", "frustrated", "apologiz", "sorry", "repetitive", "feel like"],
  "total_assistant_messages": 8,
  "messages_after_continue_chatting": 3,
  "pattern_matches": {"going in circles": 1, "sorry": 2},
  "has_frustration_language": true,
  "verdict": "FAIL"
}
```

### 4c — BENCH.md

Documents:
1. Prerequisites (same as other experiment cases)
2. How to run the benchmark:
   ```bash
   # Before the change (stash changes or checkout baseline):
   PI_GOAL_AUTO_CONFIRM=0 bash experiments/harness/run.sh C19-iteration-frustration-benchmark
   # Then analyze:
   bash experiments/cases/C19-iteration-frustration-benchmark/benchmark.sh <run-dir>
   
   # After the change:
   PI_GOAL_AUTO_CONFIRM=0 bash experiments/harness/run.sh C19-iteration-frustration-benchmark
   bash experiments/cases/C19-iteration-frustration-benchmark/benchmark.sh <run-dir>
   ```
3. Expected results:
   - Before: `has_frustration_language: true` (or multiple pattern matches)
   - After: `has_frustration_language: false` (or significantly fewer matches)

---

## Execution Order

1. Write PRODUCT.md (done) and TECH.md
2. Implement Step 1a — `goalDraftingPrompt()` normalization
3. Implement Step 2 — `goal.ts` framing fix
4. Run `npm test` to confirm no regressions
5. Implement Step 1b — `shouldAutoConfirmProposal()` benchmark override
6. Write Step 3 — unit tests
7. Run `npm test` again
8. Create Step 4 — benchmark experiment (INPUT.md, benchmark.sh, BENCH.md)
9. Run the benchmark to get a "before" baseline
10. Manual walkthrough: verify multi-iteration flow no longer triggers frustrated language
