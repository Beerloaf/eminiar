---
name: adjudicator/feedback-lessons-and-agent-linking
kind: decision
tags: []
related: [file:src/adjudicator/learn.ts, file:src/adjudicator/savings.ts, file:src/tools/em_adjudicate.ts, file:tests/unit/adjudicator-learn.test.ts]
created: 2026-11-04T12:07:52.663Z
updated: 2026-11-04T12:07:52.663Z
---

Adjudicator learning/linking/savings rules (branch feature/adjudicator, swarm run 20261104-483f39, tasks #39/#41/#44, 2026-11-04), all in src/adjudicator/learn.ts + savings.ts:
1) One lesson per final row. A final adjudication row holds at most ONE lesson in the bias buckets, derived from its label: reconcileLesson (swarm/redo outcome success|failure: tier that ran + task/worker role) or feedbackLesson (outcome_source is now "feedback:<good|too_small|too_big>"; legacy bare "feedback" maps by outcome). applyFeedbackResult/applyFeedback REPLACE the earlier lesson via replaceLesson (same signal = no-op, flipped success = relabel s/f with n unchanged, dropped = retract n-1, new = recordSignal) — repeated feedback is idempotent and never double-counts what reconcile taught. penaliseEarlier never relabels a feedback row, and when it relabels a taught success as a redo failure it flips the lesson so label == lesson. Retractions/flips are undecayed (slight over-correction, clamped 0 ≤ s,f ≤ n).
2) Non-swarm Agent rows are linked by Reconciler.linkAgents → pure matchDispatches, jointly per session, never greedily: lone row+agent in a 60 s window links; otherwise only when the requested tier (model_final ?? model_requested) uniquely identifies the agent and every rival row asked for a known different tier; pairs are peeled and the rest re-examined; ambiguous rows (e.g. parallel same-tier dispatches) stay unlinked so no false "apply did not take effect". Linking waits until ingestion holds a call past the window or the row is 30 min old. The exact link (PostToolUse(Agent) tool_response.agentId by tool_use_id; also subagents/agent-<id>.meta.json toolUseId) is follow-up task #47; reconcile already prefers row.agentId.
3) savingsReport counts each swarm task once: agent rows, plus plan rows only for tasks with no agent row (matrix and tokensPerSuccessByTier).
