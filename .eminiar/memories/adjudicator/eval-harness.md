---
name: adjudicator/eval-harness
kind: decision
tags: [adjudicator, eval]
related: [file:src/adjudicator/eval.ts, file:tests/unit/adjudicator-eval.test.ts]
created: 2026-11-04T11:18:21.034Z
updated: 2026-11-04T11:18:21.034Z
---

Adjudicator eval harness (branch feature/adjudicator, swarm run 20261104-483f39, task T10/#15, 2026-11-04): src/adjudicator/eval.ts exports runEval, resolveEvalCandidates, loadFixture/parseFixture/mergeEvalItems/evalSetHash, formatEvalReport, saveEvalReport (meta "adjudicator:eval:last"). Rows: majority reference, heuristic (raw) = scoreHeuristic choices, heuristic (shipped) = blend() with no answer (low-confidence round-up), and per provider "<id> (raw)" (its own answers, scored over answered items only; role/tool null when the provider lacks the dim) and "<id> (blended)" (through adjudicate() with no store, every item). Under-tier and over-tier rates are separate because the heuristic is deliberately asymmetric. Providers run in chunks of 10 with the plan budget per chunk; a recording wrapper around the provider keeps raw answers and usage; $/1k is null when any call reports an unknown price. Verdict compares blended provider vs SHIPPED heuristic (both include the round-up): yes when neither Δ tier nor Δ complexity ±1 is negative and one is positive. Fixtures are loaded at run time (.json, or a JS/TS module's default/first exported array); eval.ts must never import tests/fixtures (a unit test asserts it) so the held-out sets stay out of the package. The report never carries item text, only counts and a set hash. Numbers on 2026-11-04 (real bge-small, k 5): built-in 40 heuristic tier 37/40, embedding blended 36/40; held-out 60: heuristic 50/60, blended 49/60; held-out-2 60: heuristic 46/60, blended 46/60.
