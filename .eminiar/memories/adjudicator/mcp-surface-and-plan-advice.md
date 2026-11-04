---
name: adjudicator/mcp-surface-and-plan-advice
kind: decision
tags: []
related: [file:src/adjudicator/swarm.ts, file:src/tools/em_adjudicate.ts, file:src/tools/types.ts, file:src/server.ts, file:src/tools/em_swarm.ts, file:src/swarm/brief.ts]
created: 2026-11-04T11:10:23.783Z
updated: 2026-11-04T11:10:23.783Z
---

Adjudicator MCP surface (branch feature/adjudicator, swarm run 20261104-483f39, task T9, 2026-11-04): ToolDef has an optional `available(config)`; src/server.ts lists only availableTools(tools, startConfig), so em_adjudicate (score/explain/stats/feedback) is absent while adjudicator.enabled is false and needs /mcp reconnect after enabling. The server registers the embedding provider via registerServerProviders(config) (dynamic import, only when it is the effective provider with context "server"). em_swarm plan does ONE batched adjudicate() call per plan (src/adjudicator/swarm.ts adjudicatePlan, budget timeouts.planMs, heuristic on any failure, never throws), stores a `plan` row per task (runId, taskId, action "advised"), and appends one line per task "#N → <agentType> · model <haiku|sonnet|opus|fable> · effort X (complexity N, conf 0.NN)" plus "role suggested: R (planned: P)" when they differ. The planned role adds +1 to its own score, so a role-differs note needs strong evidence. Under CLAUDE_CODE_SUBAGENT_MODEL_FORCE the block says the model is informational. Everything is a no-op (no import, no rows, no output change) when the adjudicator or surfaces.plan is off. The feedback `note` is echoed only: adjudications has no column for it.
