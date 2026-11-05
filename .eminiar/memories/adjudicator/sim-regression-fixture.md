---
name: adjudicator/sim-regression-fixture
kind: decision
tags: [adjudicator, eval, tests, heuristic, regression]
related: [file:tests/fixtures/adjudicator-sim-regression.json, file:tests/unit/adjudicator-sim-regression.test.ts, file:src/adjudicator/features.ts, file:src/adjudicator/heuristic.ts]
created: 2026-11-05T07:40:56.375Z
updated: 2026-11-05T07:40:56.375Z
---

Adjudicator simulation regression fixture and test (swarm run 20261104-672098, task #96, branch feature/adjudicator, 2026-11-05).

What exists
- tests/fixtures/adjudicator-sim-regression.json: the 13 prompts from simulation run 20261104-90e129, in EvalItem shape {text, tool, tier, role, complexity}. Item 9 also carries "alsoOk": ["em_docs"]. parseFixture drops unknown keys (pinned by adjudicator-eval.test.ts), so the file still loads through `eminiar adjudicator eval --fixture <file> --replace`; that harness ignores alsoOk and shows tool 12/13.
- tests/unit/adjudicator-sim-regression.test.ts (153 tests). It scores through the shipped path: scoreHeuristic, then blend() with no provider answer.

What it asserts
- tool: exact for all 13 items (item 9 may be em_fetch_and_index or em_docs).
- tier: never below the label, checked only for items labelled sonnet or higher (a haiku label cannot be undershot). An exact tier is not asked for because the heuristic is asymmetric on purpose.
- complexity: bucket within +-1 of the label, all 13.
- intents: no edit_small for "output formats" (11) and "formatting" (13), no plan for "plan-advice" and "plan lines" (13), no debug for "the failing tests" (1).
- Paraphrase tables, not in the fixture, pin the principle of each fix: docs vs own-code questions, format as a noun or an action, plan as a verb or a name, UI show/exclude work vs lookups, history vs git (including git as a noun and branch names), callers, impact, batch, fetch, selector participles, extraction vs restructuring.
- A held-out ratchet: tier, complexity and tool may not fall below the pre-fix numbers at HEAD fc4aa21, under-tiering may not rise, and opus recall may not drop (built-in 40, held-out 60, held-out-2 60). Role is printed, not asserted.
- Cost guards: p95 under 2 ms on the fixture and paraphrases, and extractIntents under 50 ms (best of 3) on 4000-character adversarial inputs for the new patterns.

Decisions
- Roles are deliberately not asserted anywhere: the role rules were still being tuned (task #111).
- The plain-word library case ("how does zod handle unions") is a documented miss of option (a) and is not asserted, so a later improvement is not blocked.
- Verified by mutation in a sandbox copy: 21 single reversions of the fixes are each caught by at least one test, and the file fails 72 of 153 tests on pre-fix HEAD.

Pre-existing issue found, not caused by this work
- PATH_RE in src/adjudicator/features.ts is quadratic on long unbroken [\w./-] runs and runs on the whole prompt, not the 4000-character scan slice. At HEAD, 20k characters of hex cost 0.65 s, 50k cost 4 s and 100k cost 16.5 s. The UserPromptSubmit path (hooks.ts calls extractFeatures on the raw prompt) is exposed.
