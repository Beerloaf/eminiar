---
name: jev/usage-root-causes
kind: decision
status: proposed
tags: [adjudicator, jev, dashboard, follow, model-range]
related: [file:src/adjudicator/jev-impact.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/learn.ts, file:src/storage/sqlite/adjudicator.ts, file:src/tools/em_swarm.ts]
created: 2026-11-06T17:57:40.637Z
updated: 2026-11-06T17:57:40.637Z
---

Why the Jev impact panel showed no impact on Spendl (task #353, swarm run 20261106-8219c3, 2026-11-06, branch fix/jev-usage-and-adjudicator-reporting; blackboard design-usage, design-usage-2; follow-up tasks #354-#361). Checked by running impactReport read-only on the Spendl DB (~/.eminiar/projects/eba4968fc00c7ceb).

1. Agent rows backed by a plan show source fallback / status skipped. This is by design: onPreAgent uses call "never" and the row carries the plan's blended verdict through parent_id. It inflated the overview fallback rate. Fix: exclude these "inherited" rows from that rate (#356).

2. "Kept pin" mixes three groups:
   - deliberate opus..opus validator pins;
   - historical plain pins;
   - ranged stays (pick == fallback, flagged pinDeferred).
   Ranged stays are real Jev decisions and must count in jev-impact (#357).

3. jev-impact effectivePick returned "unknown" for every ranged row that Jev changed, although scores.pin.range is stored. Apply bounds were not stored. Fixes: store scores.applyBounds (#354) and make effectivePick range-aware (#357).

4. An explicit model on the Agent call is labelled "respected" (hooks.ts), and reconcile only relabels "advised" rows. So coordinators that passed the plan's advised model never counted as followed and got no savings credit. Fix: reconcile follow detection also runs on respected rows that carry no pin/force/fork flag (#355). Advice equal to the baseline leaves the follow rate (#356).

5. Upgrades count as evidence only through feedback, and there was none. Fix: optional em_swarm update `fit` → applyFeedback (#359).

6. Deferred prompts come from promptMode async (Jev p50 ~413 ms, p95 ~590 ms). Blocking mode stays opt-in.

Defaults are unchanged: mode, promptMode, features off, respectFrontmatter.
