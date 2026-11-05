---
name: adjudicator/jev-score-scale
kind: constraint
tags: [adjudicator, typesafe, jev, bug]
related: [file:src/adjudicator/providers/typesafe.ts, file:tests/unit/adjudicator-providers.test.ts, file:src/adjudicator/blend.ts]
created: 2026-11-05T11:00:48.519Z
updated: 2026-11-05T11:31:15.816Z
---

Jev (typesafe, jev-1.14.0) answers a `score` question on the rubric's own levels, not 0..1: for the 5 COMPLEXITY_CRITERIA it returns score 0..4 (fractional, e.g. 1.99) plus a `legend` {"0":…,"4":…} and per-level `probabilities`. Verified against the live API on 2026-11-05. The original parser assumed 0..1 (`score: z.number().max(1)`, value = score × 4), so every score > 1 failed validation and was silently dropped (Jev complexity missing on 21/40 eval items), and scores < 1 were inflated 4× (a typo fix scored 0.9 → 3.6 → effort "high"). Fix in src/adjudicator/providers/typesafe.ts `complexityOf`: top level = max legend key (fallback COMPLEXITY_CRITERIA.length-1), value = score × 4 / top, score > top skipped. Eval after fix (built-in set, 40 items): Jev raw complexity ±1 97.5% (was 9/19), MAE 0.58 (was 1.47); blended complexity exact 52.5% / MAE 0.52 beats heuristic (45% / 0.55); blended tier still 87.5% vs heuristic 92.5% — its misses are all at blended tier confidence < 0.8, so on the held-out sets the default blend already wins (see adjudicator/jev-blend-tuning: 143/160 vs 134/160; tuning tier alpha gave no robust gain). Test mocks must send the score on the legend's levels like the live API.
