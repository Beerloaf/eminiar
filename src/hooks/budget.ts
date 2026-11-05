/**
 * The time a hook run may take. Claude Code kills a hook at the `timeout` in hooks/hooks.json
 * and throws its output away ("timed out after 5s — output discarded"), so a run that is going
 * to be late is better answered in time without the optional work. Budgets sit under those
 * timeouts and leave room for Node's start-up and for writing the answer.
 *
 * Two limits work together:
 *  - the lock wait: every statement waits for another process's write lock, and the waits add
 *    up over a handler's statements, so a hook opens its database with a short one;
 *  - the deadline: `dispatch` answers without the handler when this budget runs out, and
 *    handlers skip optional stages when little of it is left.
 * A synchronous SQLite wait cannot be interrupted, so the deadline only bounds what yields;
 * the short lock wait is what bounds the rest.
 */

/** Per statement; a locked database is skipped, not waited for (the default is 2000). */
export const HOOK_BUSY_TIMEOUT_MS = 250;

/** The default run budget: hooks with a 5 s timeout. */
export const HOOK_BUDGET_MS = 3500;

/** Events whose hooks.json timeout is longer. */
const LONGER: Record<string, number> = {
  SessionStart: 8000,
  PostToolUse: 8000,
  SubagentStart: 8000,
  PreCompact: 12000,
};

export function budgetFor(event: string | undefined): number {
  return (event && LONGER[event]) || HOOK_BUDGET_MS;
}

/** Unset until a run starts: a handler called outside `dispatch` (a test, a tool) has no limit. */
let startedAt: number | undefined;
let budgetMs = HOOK_BUDGET_MS;

/** Start the clock for one run (`dispatch` calls this once per payload). */
export function startBudget(ms: number = HOOK_BUDGET_MS, now: number = Date.now()): void {
  startedAt = now;
  budgetMs = ms;
}

/** Forget the run: no budget applies until the next `startBudget`. */
export function clearBudget(): void {
  startedAt = undefined;
}

/** Milliseconds left in this run's budget (never negative); unlimited without a run. */
export function budgetLeft(now: number = Date.now()): number {
  if (startedAt === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, budgetMs - (now - startedAt));
}

/** Is there at least `needMs` left for an optional stage? */
export function hasBudget(needMs: number, now: number = Date.now()): boolean {
  return budgetLeft(now) >= needMs;
}
