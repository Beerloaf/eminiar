---
name: adjudicator/daily-calls-and-auth-lockout
kind: decision
tags: []
related: [file:src/adjudicator/breaker.ts, file:src/adjudicator/engine.ts, file:src/adjudicator/config.ts, file:src/storage/sqlite/schema.ts, file:src/storage/sqlite/adjudicator.ts, file:src/config.ts]
created: 2026-11-04T11:13:00.666Z
updated: 2026-11-04T11:13:00.666Z
---

Adjudicator daily call cap and auth lockout (branch feature/adjudicator, swarm run 20261104-483f39, task #25, 2026-11-04):
- budget.dailyCalls (default 2000, 0 = unlimited) caps calls per REMOTE provider per UTC day, because dailyUsd cannot limit providers whose price is unknown (cost null). The count is stored in adjudicator_provider_state.calls and shares spend_day with spend_usd. Every call that reached the provider counts, including failures; no_key does not. breaker.overBudget(s, cfg, now) checks dailyUsd OR dailyCalls, and both gate and the async peek use it.
- A 401 or 403 sets state "auth_failed" with auth_fingerprint = sha256(key) hex[0:12] (never the key) and retryAt = now + AUTH_LOCKOUT_MS (1 h). It is not a breaker failure. While locked, the provider is skipped with ProviderStatus "auth_failed" and no network call. The lock lifts when the fingerprint of the key in use changes or the hour passes; gate then resets the state to closed. Other 4xx are unchanged.
- Status, doctor and dashboard show "API key rejected" through adjudicator/config.withAuthLockout(resolved, store.providerState(p), {now, env}), which returns ResolvedWithLockout with degraded "auth_failed". The Degraded union itself is deliberately unchanged (widening it breaks TryItReason in src/ui/adjudicator-api.ts).
- Migration v8 was edited in place (unreleased) to add the calls and auth_fingerprint columns.
