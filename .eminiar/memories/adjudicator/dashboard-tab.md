---
name: adjudicator/dashboard-tab
kind: decision
tags: [adjudicator, dashboard, ui]
related: [file:src/ui/web/views/Adjudicator.tsx, file:src/ui/web/views/adjudicator-helpers.ts, file:tests/unit/adjudicator-view.test.ts, file:src/ui/web/api.ts, file:src/ui/web/public/styles.css]
created: 2026-11-04T11:26:52.962Z
updated: 2026-11-04T11:35:31.992Z
---

Adjudicator dashboard tab (branch feature/adjudicator, swarm run 20261104-483f39, task T13, 2026-11-04). The view is src/ui/web/views/Adjudicator.tsx, with pure helpers in views/adjudicator-helpers.ts covered by tests/unit/adjudicator-view.test.ts. Its route is #/adjudicator; ?range=7d|30d|90d|all and ?id=N open the decision drawer, so a drawer can be linked to.

Decisions:
1. The drawer shows each tier, tool and role option as a stacked bar: heuristic, then provider, then learned. splitTable() inverts blend.mixTable. The divisor is 1 + Σ(bias + risky + needsPlan reason weights). The provider part is the α·p "provider" reason, and the heuristic part is the remainder. The split is approximate because reason weights are rounded to 2 decimals. If blend.mixTable changes, update splitTable and its test, which runs against real blend() output.
2. The helpers must not import ../api.ts, even type-only, because the root tsc compiles them through the tests and api.ts needs the DOM. They take types from src/adjudicator/types.ts.
3. Source colours are fixed in both themes: heuristic #2563eb, blend #7c3aed, cache #0d9488, fallback #d97706. Part colours reuse heuristic, violet and amber.
4. The last-eval card reads the report generically: the first array of row objects is flattened one level, and scalar fields become facts. It therefore needs no change when eval.ts settles the shape.
5. At ≤900px, nav.tabs gets its own scrolling row (styles.css), so the shell never widens the page at phone width.
7. The savings panel warning comes from usageGapNote() (helpers, tested). Realised, spend and net are read from the adjudications table, so they stay valid without api_calls. With no api_calls, the panel warns only that new dispatches and potential savings are not priced, and it never calls the figures empty. savings.ts's assumption line says the same.
8. EVAL_META_KEY lives in src/adjudicator/types.ts. eval.ts re-exports it. adjudicator-api.ts imports it from types.ts, because eval.ts pulls zod, the eval set and the providers.
9. `.scroll-x` (styles.css, shared with .adj-scroll) is the generic own-box horizontal scroll. Its table cells are nowrap. The Usage tab wraps its models, tool-results and billing-blocks tables in it, so nothing scrolls the page at 390px.
6. Screenshots are taken from a scratch EMINIAR_HOME seeded through getStorage(getContext(root)), never the real DB. scripts/capture-screenshots.mjs has the adjudicator and adjudicator-decision shots.
