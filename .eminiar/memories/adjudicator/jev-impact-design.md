---
name: adjudicator/jev-impact-design
kind: decision
status: proposed
tags: [adjudicator, jev, dashboard, design]
related: [file:src/ui/adjudicator-api.ts, file:src/ui/web/views/Adjudicator.tsx, file:src/adjudicator/blend.ts, file:src/adjudicator/async.ts, file:src/adjudicator/hooks.ts]
created: 2026-11-05T12:03:52.354Z
updated: 2026-11-05T12:03:52.354Z
---

Jev impact panel design (task #163, swarm run 20261105-1d96f4, 2026-11-05, branch feature/adjudicator; blackboard design-jev, design-jev-2, design-jev-3). It is built from data already recorded, with no new columns.

1. Heuristic-alone counterfactual
- Rebuilt from each row's stored blended table: h_o = (score_o·(1+Σboosts+Σbias) − provider_o − boosts_o − bias_o)/(1−α).
- Then add bias back, renormalise, and apply the tier round-up below lowConfidence. This equals blend(h, undefined, bias).
- Jev's own pick is provider_o/α.
- Uncertain when the counterfactual top-two margin < 0.03 or the confidence is within 0.015 of lowConfidence.
- Verified on 26 live rows.
- Row 189 shows a blend-induced round-up: heuristic haiku and Jev sonnet gave a near-tie, which rounded up to opus.

2. Deferred async prompt rows
- Rule: source = blend AND provider_latency_ms > latency_ms. The user saw the heuristic's advice on these rows.
- Never used for outcome attribution.

3. Agent rows
- An agent row with a parent_id takes the plan row's verdict, so the plan row is the decision row.

4. Effective model
- Use scores.advisedPick. For ranged dispatches the range is inferred from raw tier vs pick; when it cannot be inferred, the row is counted as unknown.

5. Gating
- Rule: adjudicator.enabled && provider === "typesafe" (configured).
- Server: GET /api/adjudicator/jev returns {active:false} before any DB read or reconcile.
- Client: mounts JevImpact only when jevActive(ov) is true.

6. Verdict
- Evidence comes only from labelled outcomes on dispatches where Jev changed the effective tier:
  - feedback too_small or too_big: help or hurt, depending on the direction of Jev's move
  - feedback good: help
  - a reconcile success after a downgrade: help
  - a reconcile failure after a downgrade: hurt
- Wilson 90% interval on help ÷ (help + hurt). It needs ≥ 10 evidence rows and ≥ 30 compared decisions; otherwise the verdict is "not enough data".

7. Savings and dates
- Savings repricing uses the list-price ratio of actual_cost_usd.
- The complexity Δ leaves out rows before 2b76617 (Jev score-scale fix).
