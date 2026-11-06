---
name: adjudicator/follow-rate-shared-predicate
kind: decision
tags: [adjudicator, jev, follow-rate]
related: [file:src/storage/dispatch.ts, file:src/storage/sqlite/adjudicator.ts, file:src/adjudicator/jev-impact.ts]
created: 2026-11-06T18:19:09.858Z
updated: 2026-11-06T18:19:09.858Z
---

The follow rate has one definition, followCount(row, scores?) in src/storage/dispatch.ts (task #366, swarm run 20261106-8219c3, 2026-11-06, branch fix/jev-usage-and-adjudicator-reporting; blackboard review-A A1-A3). The store summary (sqlite/adjudicator.ts summary()) and the Jev impact report (jev-impact.ts impactReport, which passes its cached scoresOf(r) so each row is parsed once) both count with it, so the two views always agree. ADVISE_ACTIONS now lives only in dispatch.ts; jev-impact re-exports it, and the store keeps no copy (the parity test checks identity).

Rules: "followed" (numerator + denominator) = action followed. "deviated" (denominator only) = advised (not reconciled yet) or ignored, or respected with an explicit modelRequested whose tier differs from the stored scores.advisedPick. Out = any KeptModel row (pin, force, fork, including a ranged stay, whose advice is "keep the fallback"), a respected row that matches the advice (reconcile promotes a non-baseline match to followed; a baseline match changes nothing) or has no model or no stored pick, and an advised row whose advice is the baseline tier (adviceIsBaseline). The baseline exemption applies only to "advised", never to "ignored": the coordinator passed another model there.

dispatch.ts also exports parseScores(src) and keptModelOf(scores) for callers that already hold parsed scores.
