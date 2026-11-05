---
name: adjudicator/jev-impact-review2-fixes
kind: decision
tags: [adjudicator, jev, dashboard]
related: [file:src/adjudicator/jev-impact.ts, file:src/ui/web/views/jev-helpers.ts, file:tests/unit/adjudicator-jev-impact.test.ts, file:tests/unit/adjudicator-jev-parity.test.ts, file:tests/unit/jev-helpers.test.ts]
created: 2026-11-05T13:33:14.155Z
updated: 2026-11-05T13:33:14.155Z
---

Jev impact report fixes for review-jev2 J1-J6, J9 (task #193, swarm run 20261105-1d96f4, 2026-11-05, branch feature/adjudicator), on top of #189/#190 (memory adjudicator/jev-impact-review-fixes).
- J1: evidenceOf returns undefined when !ran BEFORE reading feedback. learn.ts feedbackLesson teaches a label to the tier that actually ran, so feedback on a dispatch that ignored the advice (or advised with no model passed) judges that model, not Jev's. Such dispatches are in outcomes.excluded.notRun; their labels still show in the split's feedback counts.
- J2: a reconcile outcome is evidence only when row.final (evidenceOf reads `final === false` as not yet; feedback is always final). New outcomes.excluded.notFinal = dispatches that ran the advice whose outcome is not final (disjoint from notRun).
- J3: the dispatch's apply bounds are not stored, so effectivePick never clamps with today's config. EffectiveInput.bounds = known dispatch-time bounds (no writer stores them yet); EffectiveInput.possible = today's config + DEFAULT_APPLY_BOUNDS (config schema haiku..opus). Where the answer rests on bounds (raw == pick and cf differs, or no pick stored) and a possible bound would clamp, the result is "bounds" -> outcomes.excluded.bounds (disjoint from excluded.unknown; both in influence.effective.unknown). Residual: bounds narrowed when a dispatch ran and widened since are not seen (stated in JEV_ASSUMPTIONS); a real fix needs hooks.ts to store floor/ceiling beside advisedPick.
- J4: verdict.compared (MIN_COMPARED 30) now counts only certain plan/agent decisions with class applied (no prompts, no cache hits). New MIN_UNITS = 3: help+hurt rows must come from >= 3 distinct units, unitOf(row, decisionRow) = run:<runId> else session:<sessionId> else one shared "unknown". JevVerdict gains units, minUnits. VERDICT_RULE and the helping/hindering reason lines say so. MIN_EVIDENCE and MIN_COMPARED values unchanged.
- J5: roundUps.blendInduced also requires t.jev undefined or rank(final) > rank(t.jev).
- J6: jev-helpers successCell: "<rate> of <success+failure>", "—" when 0.
- J9: LOW_CONFIDENCE_DEFAULT and DEFAULT_APPLY_BOUNDS exported; parity tests pin them to BLEND_DEFAULTS and ConfigSchema defaults.
- Tests: impact test builder dispatch() now defaults action "applied" and a unique sessionId; fill(n) adds agreeing dispatches to reach MIN_COMPARED.
