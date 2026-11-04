---
name: adjudicator/dashboard-api
kind: decision
tags: [adjudicator, dashboard, api]
related: [file:src/ui/adjudicator-api.ts, file:src/ui/server.ts, file:tests/unit/adjudicator-api.test.ts]
created: 2026-11-04T11:09:21.813Z
updated: 2026-11-04T11:09:21.813Z
---

Adjudicator dashboard API (branch feature/adjudicator, swarm run 20261104-483f39, task T12, 2026-11-04). src/ui/adjudicator-api.ts exports adjudicatorRoute(ctx, {path,method,query,body}, deps?), mounted in src/ui/server.ts the same way as swarmRoute.

Routes:
- GET /api/adjudicator (overview + charts)
- GET /api/adjudicator/decisions (rows without the scores JSON)
- GET /api/adjudicator/decision?id (with parsed scores)
- GET /api/adjudicator/savings (savingsReport)
- GET /api/adjudicator/eval (meta adjudicator:eval:last)
- POST /api/adjudicator/test (try-it)

Decisions:
1. Config is re-read with loadConfig(ctx.root) on every request, so `eminiar adjudicator enable` shows up without restarting the server.
2. The GETs that read rows run learn.reconcile(limit 500) first; /eval does not read rows and skips it.
3. Payloads expose keySource only, never the key or its mask. URLs are stripped of userinfo and query.
4. Provider breaker state is passed through as a string, so new states such as auth_failed need no change.
5. The try-it POST is never persisted: it goes through a store wrapper that cannot insert or touch the cache. Breaker state and spend are recorded for real, so a test call counts against the daily cap. The text is never echoed.
6. When the adjudicator is disabled, try-it runs the heuristic only, and the provider runs only when it is enabled, useProvider is set and the provider has consent and a key.
7. Default window is since=30d for the overview and savings, and all rows for decisions.
