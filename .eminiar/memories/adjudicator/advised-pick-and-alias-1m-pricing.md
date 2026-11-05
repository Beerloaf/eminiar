---
name: adjudicator/advised-pick-and-alias-1m-pricing
kind: decision
supersedes: adjudicator/ranged-follow-detection
tags: []
related: [file:src/usage/pricing.ts, file:src/adjudicator/savings.ts, file:src/adjudicator/learn.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/swarm.ts, file:tests/unit/adjudicator-ranged.test.ts]
created: 2026-11-05T09:12:03.880Z
updated: 2026-11-05T09:32:03.557Z
---

Advised pick on every dispatch row + alias[1m] pricing (task #128, swarm run 20261104-672098, branch feature/adjudicator, 2026-11-05). Supersedes adjudicator/ranged-follow-detection (#126).

(1) Follow detection: the #126 ranged-only `rangedPick` key/reader is generalised to savings.ts ADVISED_PICK_FIELD = "advisedPick" and reader advisedPick(row) (returns a Tier from the scores JSON regardless of the ranged flag; rangedPick/RANGED_PICK_FIELD no longer exist). hooks.ts onPreAgent stores advisedPick on EVERY agent row: the ranged pick (swarm.ts rangedTier) for a ranged role, else clampTier(tier, apply.floor, apply.ceiling), the tier the advise-mode note tells the coordinator to pass. Task #129: swarm.ts adjudicatePlan now sets PlanAdvice.model for every non-ranged task (plain, pinned, forced) to appliedTier(verdict, apply.floor, apply.ceiling) (= hooks.ts clampTier, implemented as rangedTier over the whole ladder because hooks.ts imports swarm.ts), so the plan line, the Agent note and follow detection name one tier; the plan row's `tier` keeps the raw verdict. markPlanRow stores advisedPick on EVERY plan row with a model (ranged or not). learn.ts pricePatch compares modelRequested with advisedPick(parent) ?? advisedPick(row) ?? parent.tier ?? row.tier, so following a clamped note is `followed` and credited; passing the raw verdict over the clamp is `ignored`. Rows without the field keep the raw-tier comparison.

(2) Pricing: src/usage/pricing.ts bundledPrice strips one trailing `[...]` context suffix before the "has version digits" test, so "sonnet[1m]"/"opus[1m]" resolve to the alias price (the `1m` is no version). Versioned ids are unchanged; an unknown versioned id with [1m] stays unpriced. The long-context surcharge stays token-threshold based (ModelPrice.longContext), not keyed to the suffix. A ranged role with fallback `sonnet[1m]` or an agent pinning `opus[1m]` now gets baselineCostUsd and savingsUsd.

Tests: tests/unit/adjudicator-ranged.test.ts (alias[1m] reconcile test no longer it.fails; resolvePrice alias[1m] cases; non-ranged clamp follow/ignore/old-row tests).
