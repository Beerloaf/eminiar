---
name: adjudicator/taught-lesson-record
kind: decision
tags: []
related: [file:src/adjudicator/learn.ts, file:tests/unit/adjudicator-learn.test.ts]
created: 2026-11-04T12:43:56.769Z
updated: 2026-11-04T12:43:56.769Z
---

Adjudicator lessons are retracted from a record of what was actually taught (task #53, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator; refines memory adjudicator/feedback-lessons-and-agent-linking rule 1). Every place that teaches a final row's lesson also writes `taught: [{dimension, bucket, option, success}]` into the row's scores JSON (no schema change). Those places are Reconciler.commit at finalisation for swarm rows, penaliseEarlier's redo relabel and applyFeedbackResult. If learning is off when one of them runs, they write [] at finalisation, or keep the previous lesson when relabelling or giving feedback, because the buckets did not move. A later relabel or feedback uses taughtLesson(row) as `before`: scores.taught when it exists, and the old recomputation (feedbackLesson of the last feedback, else reconcileLesson) only for rows with no record. Without the record, the lesson was rebuilt from the row, config and swarm ledger as they are now, and the reported bugs followed from that: feedback given while learning was off, a changed tier ladder, purged tasks or workers, or onPostAgent setting actualModel later could retract another row's real success and drop the new lesson. replaceLesson now records the new signal when a flip finds its option row gone (for example after biasReset) instead of doing nothing. Retractions are still undecayed (weight 1); no decay epoch is stored. withTaught leaves a scores value alone if it is not a JSON object. Helpers taughtOf and withTaught are exported from src/adjudicator/learn.ts.
