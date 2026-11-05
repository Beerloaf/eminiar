---
name: adjudicator/baseline-env-opt-in
kind: decision
tags: [adjudicator, savings, baseline, env]
related: [file:src/adjudicator/savings.ts, file:src/adjudicator/learn.ts, file:src/adjudicator/env.ts, file:tests/unit/adjudicator-learn.test.ts]
created: 2026-11-05T08:33:42.767Z
updated: 2026-11-05T08:33:42.767Z
---

Adjudicator savings baseline: the CLAUDE_CODE_SUBAGENT_MODEL baseline is strictly opt-in (task #124, swarm run 20261104-672098, 2026-11-05, branch feature/adjudicator). src/adjudicator/savings.ts resolveBaseline reads that variable only from BaselineQuery.env and never from process.env; omitting env means no env baseline. Why: reconcile (learn.ts pricePatch / promptRow backfill) runs in a different process from the dispatch, so process.env there says nothing about the dispatch, and main-session prompt baselines must ignore the subagent variable. The dispatch hook (hooks.ts onPreAgent) records the env baseline at dispatch time by passing { CLAUDE_CODE_SUBAGENT_MODEL } for non-fork, non-FORCE, non-inherit dispatches; mainSessionAdvice passes env: {}. The FORCE check inside savings uses env.ts envFlagOn (Claude Code's rule: 1/true/yes/on in any case = on; anything else, including 'off', 'no', '2', = off). Tests: tests/unit/adjudicator-learn.test.ts (#124 cases).
