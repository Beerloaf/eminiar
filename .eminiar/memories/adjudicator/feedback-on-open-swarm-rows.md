---
name: adjudicator/feedback-on-open-swarm-rows
kind: decision
tags: []
related: [file:src/adjudicator/learn.ts, file:tests/unit/adjudicator-learn.test.ts, file:tests/unit/swarm-tool.test.ts, file:src/tools/em_swarm.ts]
created: 2026-11-06T18:19:12.396Z
updated: 2026-11-06T18:19:12.396Z
---

Feedback on a swarm row that reconcile has not finalised does not freeze it (task #368, swarm run 20261106-8219c3, 2026-11-06, branch fix/jev-usage-and-adjudicator-reporting; review-B B1). In src/adjudicator/learn.ts, applyFeedbackResult sets final: row.final || !isSwarmRow(row). isSwarmRow means agent or plan surface with a runId and a numeric taskId. The label (outcome, outcomeSource feedback:<kind>, outcomeTs) and the feedback lesson in scores.taught are still written straight away, so jev-impact evidenceOf counts the feedback at once. Reconciler.swarmRow then keeps a feedback:* label (feedback beats the task/redo guess). It still links agentId, baseline, actual model, cost, savings and follow. Finalisation still waits for the task-derived outcome and ingestion to catch up (or for 24 h). Instead of teaching reconcile's lesson, it re-derives feedbackLesson from the linked row (the tier that actually ran) and calls replaceLesson. Reconciler gets the tier ladder from config.adjudicator.tiers. Non-swarm rows (prompt, mcp, non-swarm agent) are still finalised at once: agentRow would overwrite the label with outcomeSource "link".
