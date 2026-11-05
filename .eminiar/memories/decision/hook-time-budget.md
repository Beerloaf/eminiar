---
name: decision/hook-time-budget
kind: decision
status: accepted
tags: []
related: []
created: 2026-11-05T20:20:00.000Z
updated: 2026-11-05T20:20:00.000Z
---

Hook time budget (branch fix/hook-timeout, 2026-11-05; docs/how-it-works.md "Hooks", docs/troubleshooting.md). Cause of `UserPromptSubmit hook timed out after 5s — output discarded`: every SQLite statement waited up to 2 s (`timeout: 2000` in SqliteAdapter) for another process's write lock, a handler runs several statements, and nothing capped the total. A swarm run puts many processes on one project database (workers' hooks, indexer, usage ingest). Reproduced on a copy of the real project database: 6 processes holding write transactions (300 ms, back to back) gave hooks of 5.0 to 6.7 s; the same load after the fix gives 1.1 to 1.3 s. With no contention a hook takes 70 to 130 ms, and 30 concurrent hooks on a free database finish in under 1 s, so the cost was lock waits, not the work.

- Hooks open the database with `HOOK_BUSY_TIMEOUT_MS` = 250 (src/hooks/budget.ts, set in src/hook.ts through `setStorageBusyTimeout`); the CLI and servers keep 2000.
- `dispatch()` runs the handler against `budgetFor(event)`: 3.5 s for the 5 s hooks, 8 s SessionStart/PostToolUse/SubagentStart, 12 s PreCompact. On the deadline it answers `{}` (a denied swarm dispatch stays denied via `failClosed`), sets `ranLate()`, and src/hook.ts exits after writing the answer. A synchronous SQLite wait cannot be interrupted, so the deadline only bounds what yields; the short lock wait bounds the rest.
- `userPromptSubmit` treats its session upsert and event writes as best effort in one try block (the first locked write ends it) and runs the read-only recall regardless: WAL readers are not blocked by a writer. `recordShown` is written after the recall text is in hand. Recall needs 600 ms of budget left, the adjudicator 1500 ms (`hasBudget`).
- The budget is unset until `dispatch` starts a run (`budgetLeft()` is Infinity), so handlers called directly by tests or tools are never cut short. A late run leaves its budget spent so the abandoned handler skips optional stages.
- Not changed: who holds the long write locks (indexing, usage ingest transactions); `eminiar swarm init --force` still writes through a symlinked .eminiar; the adjudicator already had its own latency budgets (breaker, promptMs 1200, async mode) and was not the cause.

**Why:** the project rule is that hooks fail open within a hard budget; this made the budget real instead of relying on SQLite's default per-statement wait.
**How to apply:** a new hook stage that writes should be best effort or skip under `hasBudget`; do not raise the hooks.json timeout to fix a slow hook, find what it waits on; do not add the 2 s default back for hook connections.
