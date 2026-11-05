---
name: adjudicator/units-tail-and-work-tail
kind: decision
tags: [adjudicator, units, review-109]
related: [file:src/adjudicator/units.ts, file:tests/unit/adjudicator-units.test.ts]
created: 2026-11-05T09:37:23.773Z
updated: 2026-11-05T09:37:23.773Z
---

Adjudicator brief units never drop real work (swarm run 20261104-672098, task #130, review #109 F1+F2, branch feature/adjudicator, 2026-11-05). src/adjudicator/units.ts:
(F1) splitUnits makes at most UNIT_MAX (40) units: the first UNIT_MAX−1 statements alone, and ONE last unit joining every later statement (returned as `tail`). scoreUnits scores that last unit statement by statement (runsOf: each alone while ≤ UNIT_MAX, else UNIT_MAX contiguous joined runs), so at most 2×UNIT_MAX−1 scorings. Scoring the joined tail as one text was rejected: measured on the 35 capped real dispatch prompts it over-tiered 14 sonnet→opus (joined statements add up, the saturation #102 removed), and it can also under-score because intent.edit_small weighs negative (\"Design the new cache.\" 3.0 alone, 2.58 joined with three renames). A gate (rescore only when the joined tail wins) was also rejected for the dilution case. `skipped` keeps its numeric meaning (statements past UNIT_MAX) but they are now scored inside the last unit; `scored` counts scorings; `winner` indexes scorings. UNITS_VERSION bumped to \"2\" (cache key).
(F2) boilerplateClause: a PROTOCOL match (run/verify/check/make sure/report…, prefix-anchored) is not boilerplate when WORK_TAIL matches: \", and|by|after\" + fix/patch/redesign/rewrite/refactor/migrate/implement/repair/resolve/debug/investigate/diagnose/port/find, except a routine object (\"fix any failures\", \"fix them\", \"fix any type errors\").
Measured (scratchpad units/eval-units.ts, before → after): this repo's and the other project's tasks unchanged; dispatch opus 46.6 → 46.7%, c=4 6.9 → 6.9%, effort max 9.4 → 9.4%; append flips 0/0/0 all corpora; fair shuffle (dispatch) 0.3/0.7/1.6 → 0/0/0.4; boilerplate drop list byte-identical (F2 changes nothing in real corpora); capped dispatch prompts under-tiered vs max-over-statements 1 → 0, over-tiered 0.
