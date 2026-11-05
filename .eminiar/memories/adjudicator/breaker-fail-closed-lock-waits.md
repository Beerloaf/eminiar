---
name: adjudicator/breaker-fail-closed-lock-waits
kind: decision
tags: []
related: [file:src/adjudicator/breaker.ts, file:src/adjudicator/engine.ts, file:src/storage/sqlite/adjudicator.ts, file:src/storage/types.ts]
created: 2026-11-04T12:50:14.761Z
updated: 2026-11-04T12:50:14.761Z
---

Adjudicator breaker under a busy database, and timeouts in the slow guard (tasks #51/#52, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator; refines adjudicator/breaker-atomicity-slow-guard-cache-key-bias-bucket).
#51:
- gate() reads the provider state WITHOUT a lock (WAL readers never wait). Denials (open/slow in cooldown, auth lockout, over dailyUsd/dailyCalls) and the plain closed case never write. Only a half-open claim or an expired slow/auth reset takes store.atomically() (BEGIN IMMEDIATE), re-reading inside the tx so only one process claims.
- The engine FAILS CLOSED: if gate throws (SQLITE_BUSY or any error), the provider is NOT called; verdict = heuristic, providerStatus "skipped", log "gate unavailable". Never treat a missing gate answer as allow.
- Every engine write waits for another process's lock at most min(budget left, LOCK_WAIT_MAX_MS=250) (store.withLockWait / atomically(fn,{lockWaitMs}) set PRAGMA busy_timeout for the body and restore it). Records and the row insert keep a floor LOCK_WAIT_FLOOR_MS=25; cache get/put/prune use 0. Once a write hits SQLITE_BUSY, the rest of that call only get their floor (LockBudget in engine.ts). cacheGet still serves a hit when its hits bump is locked out.
- A recordSuccess/recordFailure that cannot be written carries its call and spend in memory per store object (breaker.ts unrecorded()), the gate counts it toward the daily caps, and the next successful record writes it; the engine logs "breaker state not written ... unrecorded today: N call(s), $x" (a hook process exits before it could carry).
- Measured: real dist/hook.js PreToolUse(Agent) with the DB write lock held: ~410-470 ms (was 4.3 s; local budget 600 ms), 0 provider calls when the breaker is open.
#52:
- A timeout/abort goes into the latency ring as max(measured, budget+1) ms (timeoutLatency), so the p95 ratio counts it as > 1. recordSuccess samples the latency the engine MEASURED, not ProviderResult.latencyMs.
- Successes still reset the breaker's consecutive-failure streak by design; intermittent timeouts (e.g. 1 in 3) are caught by the slow guard instead, which trips as soon as SLOW_MIN_SAMPLES (20) samples are in.
