/**
 * What to do about a goal that is not moving.
 *
 * Continuations used to stop whenever a turn called no work tool. That asked
 * the wrong question: calling a tool is a proxy for advancing, and a poor one -
 * reading a file counted, thinking a problem through and asking the user did
 * not. It also could not distinguish an agent talking to itself from an agent
 * waiting on a decision, and those deserve opposite treatment.
 *
 * The stop condition is now explicit instead: an agent that needs the user
 * blocks, and a blocked goal receives no continuations. This watch is the
 * remaining safety net for the case nobody declared - a goal whose task states
 * have not changed for several turns. It reports that rather than ending the
 * goal's progress in silence, because a goal sitting still with nothing on
 * screen saying why is the defect this replaces.
 */
export type IdleTurnAction = "continue" | "needs-attention";

export interface IdleTurnInput {
  /** Consecutive continuation turns since any task or goal state last changed. */
  idleTurns: number;
  /** Turns tolerated before asking for attention; 0 disables the watch. */
  limit: number;
}

export function idleTurnDecision(input: IdleTurnInput): IdleTurnAction {
  if (input.limit <= 0) return "continue";
  return input.idleTurns >= input.limit ? "needs-attention" : "continue";
}

/** Turns tolerated by default: a look, an attempt, and one retry. */
export const DEFAULT_IDLE_TURN_LIMIT = 3;
