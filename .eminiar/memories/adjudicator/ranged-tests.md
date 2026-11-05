---
name: adjudicator/ranged-tests
kind: note
tags: [adjudicator, model-range, tests, mutation-check]
related: [file:tests/unit/adjudicator-ranged.test.ts, file:src/adjudicator/swarm.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/learn.ts, file:src/adjudicator/savings.ts, file:src/adjudicator/agent-pin.ts]
created: 2026-11-05T09:02:34.633Z
updated: 2026-11-05T09:02:34.633Z
---

Ranged dispatch test suite (task #107, swarm run 20261104-672098, branch feature/adjudicator, 2026-11-05). tests/unit/adjudicator-ranged.test.ts holds 68 tests: 24 from #104 plus 44 from #107. 66 pass and 2 are `it.fails` that pin real defects; whoever fixes one removes `.fails` (vitest then reports the test as passing).

Known defects pinned as `it.fails`:
- #126: reconcile (learn.ts pricePatch) decides followed/ignored by comparing the call's model with the scorer's RAW tier (the plan row's `tier`), not with the ranged PICK the line told the coordinator to pass. A coordinator that follows a clamped pick is recorded `ignored` with no credit. Repro: role `model: opus, model_range: {floor: sonnet}`, verdict haiku, advise mode, call passes sonnet.
- #128: resolvePrice has no price for a bare `sonnet[1m]` or `opus[1m]` (src/usage/pricing.ts bundledPrice returns undefined for an id that has a digit and matches no family). The verbatim fallback baseline of a ranged role (or of a pin) spelled that way cannot be priced, so baselineCostUsd and savingsUsd stay null and an applied pick is never credited.

How the suite is built:
- The clamp is checked against an independent oracle at module scope: `allowed(range, applyFloor, applyCeiling)` is a set (membership over TIERS, a ceiling below the floor yields to it like hooks.ts clampTier) and `nearest(tier, set)` takes the closest member. It is not the min/max arithmetic of rangedTier. rangedTier is compared over all 384 combinations (6 ranges x 16 apply bounds x 4 verdicts). The hook is driven over the same grid for two roles (128 dispatches), so a role's own floor/ceiling and the apply bounds are each shown to clamp alone.
- dispatchRule is checked over all 64 combinations of fork/forced/ranged/pin/effortSet/saturated against a first-match list.
- Helpers: `project(yaml)` syncs real agent files; `dispatch()` (hook + stored plan row), `settle()` (worker api_calls + task done + reconcile) and the nested `loose()` (no run, no plan row, optional stub provider) live inside the onPreAgent describe; `stubProvider(tier)` and `apiCall()` are module level. Providers are stubs, env is passed explicitly, nothing reads the machine's env.
- Savings: the baseline order (ranged fallback > pin > env model with FORCE off > session > FALLBACK_MODEL), rangedFallback reader, withKeptModel round trip and the reconcile credit of an applied ranged row (priced against the fallback, not the env model) and of a kept pick (a kept pin: no credit, counted under keptModel.pin).
- Fail-open and off paths: a provider that never answers (hook and plan), disabled adjudicator and switched-off surfaces, oversized, malformed or hand-edited agent files, a shadowed ranged file (unknown pin, nothing applied).

Mutation check: 91 mutants of swarm.ts, hooks.ts, agent-pin.ts, savings.ts, swarm/config.ts and swarm/agents.ts (rule order, every rangedTier bound, moves/minConfidence/mayApply, baseline and flags, role gate, pin lookup, FORCE and env baseline, config validation, marker and hash). 89 killed. The 2 survivors are equivalent: rangedTier's clamp order (min(hi, max(lo, r)) equals max(lo, min(hi, r)) once lo <= hi is guaranteed) and the hook's `!fork` guard in the `ranged` fact (resolveAgentPin never returns ranged for `fork`).

Mutating a shared working tree breaks other workers' runs (hooks.ts is edited concurrently): copy src, tests and the configs to a scratch dir, symlink node_modules, mutate there and run only the target test file.
