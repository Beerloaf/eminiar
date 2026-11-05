---
name: adjudicator/jev-impact-web-safe-imports
kind: constraint
tags: [adjudicator, jev, dashboard]
related: [file:src/adjudicator/jev-impact.ts, file:src/adjudicator/blend.ts, file:src/ui/web/api.ts]
created: 2026-11-05T12:14:17.034Z
updated: 2026-11-05T12:14:17.034Z
---

src/adjudicator/jev-impact.ts (Jev impact report, task #168, swarm run 20261105-1d96f4, 2026-11-05, branch feature/adjudicator) must stay importable by type from the dashboard (src/ui/web, tsconfig.web.json with types: []).

Allowed imports: only ./types.js, ../storage/dispatch.js and ../usage/pricing.js. Under the web config, heuristic.ts, savings.ts, learn.ts and engine.ts pull in node: modules and fail the web typecheck.

So jev-impact.ts carries small documented mirrors:
- heuristic.ts: tableConfidence, effortFor, DEFAULT_TIERS
- learn.ts: feedbackOf
- savings.ts: advisedPick, RANGED_FLAG, allRows
- engine.ts: surfaceBudget (non-local)

It also takes the db and config structurally (JevDb, JevConfig); StorageAdapter and AdjudicatorConfig satisfy them.

If one of those originals changes, update its mirror. A parity test in tests/unit/adjudicator-jev-impact.test.ts should pin them.

Counterfactual detail: blend.ts mixTable clamps blended scores at 0. The reconstruction therefore takes its total from the entries above 0, and marks a row uncertain when a clamped entry's heuristic score could still be above 0. This was checked against the real blend() on 18,000 random tables with 0 mismatches outside the uncertain rows.
