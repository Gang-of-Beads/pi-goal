/**
 * Whether the session's focus has to be written into the transcript again.
 *
 * Focus lives in the transcript, not in the goal file: a `pi-goal-focus` custom
 * entry, recovered by scanning backwards for the most recent one. Compaction
 * replaces the transcript with a summary, and that summary is prose - it may
 * name the focused goal, but the scan looks for a structured entry, not for
 * words. The entry is therefore gone and nothing writes another.
 *
 * In memory the focus is still there, so nothing appears wrong until the next
 * reload, which is why the loss looked arbitrary: a goal read "created and
 * focused", work continued against it, and a later reload reported no goal
 * focused at all - one was seen sitting at revision 2 for hours while real work
 * happened that none of it recorded.
 *
 * Only an explicit focus is restored. An implicit one, auto-selected because a
 * single goal happened to be open, is a fresh decision every load and writing
 * it back would turn a convenience into a commitment.
 */
export function focusEntryNeededAfterCompaction(state: { focusedGoalId: string | null; hasExplicitSessionFocus: boolean }): boolean {
  return state.hasExplicitSessionFocus;
}
