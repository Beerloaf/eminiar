---
name: adjudicator/jev-impact-review-fixes
kind: decision
tags: [adjudicator, jev, dashboard]
related: [file:src/adjudicator/jev-impact.ts, file:src/ui/web/views/jev-helpers.ts, file:src/ui/web/views/JevImpact.tsx, file:tests/unit/adjudicator-jev-impact.test.ts, file:tests/unit/adjudicator-jev-parity.test.ts, file:tests/unit/jev-helpers.test.ts]
created: 2026-11-05T13:02:02.444Z
updated: 2026-11-05T13:02:02.444Z
---

Jev impact report fixes for review-jev F2/F3/F4/F7/F9/F10 (task #190, swarm run 20261105-1d96f4, 2026-11-05, branch feature/adjudicator), on top of #189 (ranAdvice, excluded.notRun, decisionRowOf(row,parent,since)).
- F2: the verdict judges a downgrade by its reconcile outcome (success = help, failure = hurt) but an upgrade only through feedback, because finishing on the bigger model cannot show the smaller one would have failed. VERDICT_RULE says so. JevVerdict gains `changed` (effective.changed) and `upgrades {counted, notCounted}`; verdictScope() appends "N of M dispatches Jev changed have a counted label; upgrades count only through feedback: a counted, b that only finished or failed not counted" as the last reason (reasons[0] stays the deciding one). The UI shows every reason via jev-helpers verdictLine().
- F3: roundUps.counterfactual counts only certain rows; roundUps.blendInduced (the hinder warning) only certain rows where final rounded up, cf did not, AND rank(final) > rank(cf) (a round-up back to the heuristic's tier is not blend-induced).
- F4: verdict.compared = tier.compared − tier.uncertain (the 30-compared minimum); the 'changed the tier' tile uses the same denominator; tier.compared itself still includes uncertain rows. The 'Jev calls' tile shows coverage.attempts (applied+deferred+error) with "N answered" in its sub line.
- F7: scoresOf memoises parsed scores in a WeakMap keyed by row object (source string checked), one JSON.parse per row in the report; 20k-row probe 74.6 → ~71 ms median on this machine (40002 → 26668 parses; the rest are storage/dispatch.ts).
- F9: scoreScaleFixed(row): a stored scorer `version` above 1 counts as fixed; version "1" rows (all rows today, the fix did not bump SCORER_VERSION) fall back to JEV_SCORE_FIX_TS, limitation documented on the constant. Bumping SCORER_VERSION in types.ts would make the cutoff exact for new rows (it also re-keys the verdict cache).
- F10: ADVISE_ACTIONS and PROVIDER_STATUS_CLASS (Record<ProviderStatus, class>, so a new status fails the typecheck) are exported; adjudicator-jev-parity.test.ts parses storage/sqlite/adjudicator.ts and the ProviderStatus/AdjudicationAction unions in types.ts and pins them.
- Parent fetch: jevImpact fetches parents only when the read hit JEV_ROWS_MAX. Uncapped, every typesafe in-window row is already in rows, so a missing parent is another provider's or out of window and decisionRowOf rejects it; a capped read (store lists newest first) can leave out an in-window parent, so PARENT_FETCH_MAX stays.
