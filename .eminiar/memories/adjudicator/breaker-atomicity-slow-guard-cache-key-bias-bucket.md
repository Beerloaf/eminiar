---
name: adjudicator/breaker-atomicity-slow-guard-cache-key-bias-bucket
kind: decision
tags: [adjudicator, breaker, cache, learning]
related: [file:src/adjudicator/breaker.ts, file:src/adjudicator/engine.ts, file:src/adjudicator/learn.ts, file:src/storage/sqlite/adjudicator.ts, file:src/storage/sqlite/schema.ts, file:src/storage/types.ts, file:src/adjudicator/hooks.ts]
created: 2026-11-04T12:03:19.176Z
updated: 2026-11-04T12:03:19.176Z
---

Adjudicator correctness fixes (branch feature/adjudicator, swarm run 20261104-483f39, tasks #38/#36/#37/#40, 2026-11-04).

#38 Atomicity:
- AdjudicatorStore has an optional atomically(fn). The SQLite store runs fn as db.transaction(fn).immediate(), i.e. BEGIN IMMEDIATE, and joins a transaction that is already open.
- breaker gate/recordSuccess/recordFailure each do their read-modify-write inside it, so only one process claims the half-open slot and spend/calls lose no increments.
- Stores without the method (tryItStore, test doubles) run fn directly.
- Proven by a 10-process test in adjudicator-engine.test.ts.

#36 Slow guard:
- Each latency is stored with the budget of its call: AdjudicatorProviderState.latencyBudgets, column latency_budgets in v8 and in ADJUDICATOR_LATE_COLUMNS. It is aligned with the end of `latencies`; 0 means unknown.
- isSlow trips when p95(latency/budget) > 1 over at least SLOW_MIN_SAMPLES=20 samples with a known budget. Below 20, nearest-rank p95 is the max.
- Calls with surface "test" (SessionStart warm-up, CLI test, try-it) pass sample:false. They stay out of the ring but still count in calls and spend.

#37 Cache key:
- cacheKeyFor(req, r, {config, tools, roles}) hashes SCORER_VERSION|configured|model|surface|stableJson(inputs)|text. inputs are hints.files/deps/role, the role list (hints.roles or opts.roles, sorted by name, with descriptions), the sorted tools catalogue, cfg.tiers and cfg.weights.
- buildJob copies opts.tools ?? opts.deps.tools, so the async child computes the hook's key.
- warmUp passes {config}.
- Learned bias is deliberately left out of the key.

#40 Bias bucket:
- The tier bucket is the HEURISTIC complexity, the only one known at lookup.
- The engine puts verdict.heuristicComplexity (type EngineVerdict) into scores JSON.heuristicComplexity.
- learn.bucketsOf reads it and falls back to row.complexity for old rows.
