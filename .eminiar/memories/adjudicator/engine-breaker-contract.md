---
name: adjudicator/engine-breaker-contract
kind: decision
tags: []
related: [file:src/adjudicator/engine.ts, file:src/adjudicator/breaker.ts, file:src/adjudicator/async.ts, file:src/hook.ts]
created: 2026-11-04T11:02:12.283Z
updated: 2026-11-04T11:02:12.283Z
---

Adjudicator engine contract (branch feature/adjudicator, swarm run 20261104-483f39, task T6, 2026-11-04):
- adjudicate() in src/adjudicator/engine.ts never throws. It races the provider against a timer at the remaining budget and also aborts its signal, so a hung provider returns the heuristic within budget + a few ms.
- Cache key uses the CONFIGURED provider (not the effective one), so hooks reuse the server's embedding verdicts. Only blended verdicts are cached. A cache hit strips id/usage/providerLatency so cost is never double-counted. Batch usage is split evenly over the answered items.
- Breaker state lives in adjudicator_provider_state. Half-open is claimed by writing half_open with a fresh retryAt (one trial call across processes). In async mode the hook only peeks; the child claims. Failures that count: timeout, rate_limited, http_error with no status (refused connection) or ≥500. 4xx and invalid do not count.
- Slow guard needs ≥5 samples. On expiry it resets the latency ring.
- The daily USD cap applies to remote providers only. A null cost (unknown price) adds $0 and the row keeps cost_usd NULL.
- engine.ts does not import async.ts values (avoids a cycle): callers pass spawn: spawnAsyncJob for call "async".
- The async job JSON never holds a key. The child (em-hook --adjudicate) resolves the key itself and keeps the hook row's latency_ms.
