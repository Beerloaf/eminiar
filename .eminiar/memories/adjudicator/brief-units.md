---
name: adjudicator/brief-units
kind: decision
tags: [adjudicator, heuristic, swarm, stability, units]
related: [file:src/adjudicator/units.ts, file:src/adjudicator/engine.ts, file:tests/unit/adjudicator-units.test.ts, file:tests/unit/adjudicator-swarm.test.ts]
created: 2026-11-05T07:55:24.459Z
updated: 2026-11-05T07:55:24.459Z
---

Adjudicator: briefs are scored per statement (swarm run 20261104-672098, task #102; branch feature/adjudicator, 2026-11-05). The user approved this rule (researcher #99, blackboard model-switching-2/3).

Module: src/adjudicator/units.ts, wired in engine.ts prepare() for surfaces plan and agent only. Prompts, tool and mcp requests still score the whole text. EngineOptions.units=false scores everything as one text.

Algorithm (scoreUnits):
1. Statements. The first line (task title / dispatch description) comes first, then each sentence or line of the first 4000 characters. List markers are stripped. Pasted output (a fenced block, or a run of trace/log lines) joins the statement before it.
2. Boilerplate is left out.
   - Dropped: routine checks (run typecheck/lint/tests/build, "verify: npx tsc", "keep … green", bare check lists) and hand-in protocol (report…, claim…, close/finish the task, post/put … to blackboard/your update, return-format, lead with, attribution lines), plus continuation clauses of those.
   - It works per clause, split on "; " and ", then".
   - The first statement always stays.
   - A clause that opens on a `code identifier` is never treated as a protocol verb.
   - Review work ("Check that X has a test", "Verify each finding against the code") is kept.
3. Repeated statements count once. At most UNIT_MAX = 40 statements are scored, each with the unchanged scorer (extractFeatures + scoreHeuristic with the request's hints).
4. Complexity, its reasons, the tier table and the effort come from the hardest statement. Ties go to higher risk, then the earlier statement.
5. Role and tool are raw votes summed over the statements (read back from each table's reasons, then normalised once). The plan's role hint is in every statement's vote, so the planned role stands unless the text says otherwise throughout (design follow-up F1).
6. A one-statement text with nothing dropped returns exactly the whole-text ScoreSet.

Outputs:
- Adjudication.units: BriefUnits = {scored, dropped, skipped, winner, sum, saturated, roleConfidence}.
  - sum is the whole-text complexity before the clamp.
  - saturated means sum > 4.
- The row's scores JSON stores `units`; units.briefUnitsOf(scores) reads it back.
- Adjudication.features stays the whole text's features (rows and the learned bias read them).
- The cache key gains UNITS_VERSION for plan/agent requests. SCORER_VERSION was not bumped.

Measured (blackboard units-stats):
- This repo's 101 tasks: clamp share 67% -> 17%, opus 91% -> 63%, effort max 72% -> 22%, role != plan 23 -> 1.
- 1044 dispatch prompts: clamp 70% -> 7%, opus 89.5% -> 47%.
- Appended boilerplate or a repeated detail flips nothing. Reordered statements flip nothing below 40 statements.
- Cost what-if: 87% of pinned cost unpinned, 86% with per-role ranges.
- Time: p95 1.5–2.4 ms per brief.

Consumers gate notes on these (blackboard units-api):
- Role note: verdict.role.confidence, or units.roleConfidence on a stored plan row.
- Effort: units.saturated means the effort is shown as informational.

Open follow-ups:
- eval.ts should pass units:false (its provider runs use surface "plan").
- async.ts should pass units to verdictColumns.
