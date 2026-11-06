---
name: adjudicator/jev-range-context-one-row
kind: decision
tags: []
related: [file:src/adjudicator/jev-impact.ts, file:src/ui/web/views/jev-helpers.ts]
created: 2026-11-06T18:35:06.855Z
updated: 2026-11-06T18:35:06.855Z
---

Jev impact report (src/adjudicator/jev-impact.ts, task #370, swarm run 20261106-8219c3, 2026-11-06, review-C C2): a dispatch's ranged flag, role range (scores.pin.range) and apply bounds (scores.applyBounds) are read as ONE unit by rangeContextOf(row, decisionRow): the agent row's when it stores any of the three, else the plan/decision row's. Never take each field from whichever row has it (a stale agent file paired a plan row's opus..opus range with the agent's haiku..fable bounds and flipped help/hurt). effectivePick's far-side guard is `i.ranged ? !i.range : !i.bounds` -> "unknown": a ranged role needs its range; apply bounds alone do not say where it clamped. The web panel's verdictSteps (src/ui/web/views/jev-helpers.ts) also names n < minEvidence (only when some dispatch changed) and a split verdict (all minimums met, still "not enough data").
