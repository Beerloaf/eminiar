---
name: adjudicator/heuristic-asymmetric-tier
kind: decision
tags: [adjudicator, heuristic, tier]
related: [file:src/adjudicator/heuristic.ts, file:src/adjudicator/features.ts, file:src/adjudicator/blend.ts, file:tests/unit/adjudicator-heuristic.test.ts]
created: 2026-11-04T11:06:53.704Z
updated: 2026-11-04T11:06:53.704Z
---

Adjudicator heuristic tier rule is asymmetric (swarm run 20261104-483f39, task #23, 2026-11-04). Under-tiering costs a redo (failed attempt + retry tokens), so heuristic.ts scoreTier uses logit −asymmetry·max(0,c−centre) − max(0,centre−c). The ratio is `weights.features.asymmetry`, default 2 (DEFAULT_FEATURE_WEIGHTS); scoreTier's own param defaults to 1 (symmetric), scoreHeuristic passes the configured value. Boundaries at 2:1 with centres 0.6/2.0/3.4: haiku→sonnet c≈1.07, sonnet→opus c≈2.47. A sweep over 1/1.5/2/2.5/3 on EVAL_SET+EXEMPLARS picked 2. Also added in features.ts (FeatureExtras: proseWords, prosePaths, pasted, taskTitle, perf): pasted traces/logs are debug evidence, not length or paths; "Tn:" task titles floor complexity at weights.features.taskFloor (2); perf work with a measured number (+0.8); migration/platform phrases → refactor; auth/sandbox/PKCE in risk; call sites / "all N things" / 3-item enumerations count as scope; specific implement verbs (optimize, wire, convert, extract, integrate, implement) weigh 1.0 so they alone reach complexity 2; read-only lookups drop the test-mention and paths terms. blend.ts low-confidence round-up is unchanged. Held-out (tests/fixtures/adjudicator-heldout.ts) went from tier 66.7% to 83.3% and opus recall from 1/5 to 5/5. The remaining error leans over-tier (7/30 haiku items scored sonnet), which is the intended trade. Validate any further tuning on a fresh blind set (task #24), not on the held-out set.
