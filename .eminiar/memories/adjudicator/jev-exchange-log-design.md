---
name: adjudicator/jev-exchange-log-design
kind: decision
status: proposed
tags: [adjudicator, jev, privacy, dashboard, design]
related: [file:src/adjudicator/providers/http.ts, file:src/adjudicator/providers/typesafe.ts, file:src/adjudicator/engine.ts, file:src/adjudicator/async.ts, file:src/storage/sqlite/schema.ts, file:src/storage/sqlite/adjudicator.ts, file:src/config.ts, file:src/ui/adjudicator-api.ts, file:src/ui/web/views/JevImpact.tsx, file:docs/adjudicator.md]
created: 2026-11-05T12:28:52.718Z
updated: 2026-11-05T12:28:52.718Z
---

Jev exchange log design (task #172, swarm run 20261105-1d96f4, 2026-11-05, branch feature/adjudicator). The full design is on blackboard design-xchg … design-xchg-5.

User decision: keep only the newest 100 exchanges. This is the constant EXCHANGE_KEEP, not a setting.

Capture
- Opt-in, off by default. Config key adjudicator.privacy.captureExchanges (default false).
- Personal-only by construction: privacy is outside PROJECT_ADJUDICATOR_KEYS, and the untrusted personal file gets the same cut.
- EMINIAR_ADJUDICATOR_CAPTURE=0 withdraws it; =1 is ignored.
- Capture point:
  - http.ts gets HttpOptions.exchange, a callback that receives a live record after fetch is dispatched, filled in place.
  - typesafe.ts one() pushes the record into a per-call sink (`capture` in the adjudicate options).
  - The engine gates on captureExchanges && store && (persist || linkRowIds) && provider typesafe.
  - After finish(), the engine writes the records with row ids, using locks.run(store, 0) (fail open).
  - A record still pending is written as a timeout, so there is no settle wait.
- Bodies are scrubbed structurally (each JSON string leaf goes through scrub(s, key)), then capped at 64 KiB.
- Never stored: the key, headers or internal request keys.

Storage: migration v9, table adjudicator_exchanges.
- row_ids is a JSON array.
- Timing columns: wait_ms, job_wait_ms, ttfb_ms, duration_ms, retry_wait_ms, attempts, deadline_ms, budget_ms, timed_out, http_status, tokens.
- Pruning runs in the same transaction: id < the 100th-newest id.
- purge() includes the table.

API
- GET /api/adjudicator/jev/exchanges (list, no bodies) and /jev/exchange?id= (detail).
- The gate is checked before any DB read: Jev off → {active:false}; capture off → {capture:false}.

UI
- A JevExchanges.tsx section is mounted from JevImpact.tsx.
- The table opens a drawer with a timing bar and the request/response JSON.
- A notice says the requests contain redacted prompt text.

CLI: `eminiar adjudicator exchanges [status|on|off|purge]`.
- `on` refuses --project and an untrusted personal file.
- `off` deletes this project's rows.

Docs: docs/adjudicator.md "Prompts and keys are never stored" changes to "Keys are never stored…" and gains a new "### Jev request capture" section.

Measured: a Jev body is 2.5–44 KB; scrub takes 0.15–1.2 ms.

Open user decisions D1–D10 are listed in design-xchg-5.
