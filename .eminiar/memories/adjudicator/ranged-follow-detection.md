---
name: adjudicator/ranged-follow-detection
kind: decision
status: superseded
tags: []
related: [file:src/adjudicator/learn.ts, file:src/adjudicator/savings.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/swarm.ts, file:tests/unit/adjudicator-ranged.test.ts]
created: 2026-11-05T09:06:42.963Z
updated: 2026-11-05T09:12:03.895Z
---

Ranged follow detection (task #126, swarm run 20261104-672098, branch feature/adjudicator, 2026-11-05). A ranged dispatch (swarm.yaml model_range) is told to pass its PICK (swarm.ts rangedTier: verdict clamped to role range ∩ apply.floor..ceiling), not the raw verdict tier. Rows that carry the ranged flag now also store the pick under scores key `rangedPick` (savings.ts RANGED_PICK_FIELD; reader rangedPick(row) returns a Tier only when the row is ranged). Writers: hooks.ts onPreAgent (withPin extra, when a pick exists) and swarm.ts markPlanRow (advice.model). learn.ts pricePatch follow detection compares modelRequested with rangedPick(parent) ?? rangedPick(row) ?? parent.tier ?? row.tier, so a coordinator passing the pick is `followed` and credited cost(fallback) − cost(actual); passing the raw verdict instead is `ignored`. Rows written before #126 have no pick and fall back to the old raw-tier comparison. Known remaining mismatch (not ranged): the non-ranged advise-mode Agent note in hooks.ts says pass model:'<clampTier(tier, apply.floor, ceiling)>' while follow detection compares the raw tier, so an apply-bound clamp on a non-ranged dispatch is still recorded ignored.
