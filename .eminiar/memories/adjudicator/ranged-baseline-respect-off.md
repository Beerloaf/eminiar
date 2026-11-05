---
name: adjudicator/ranged-baseline-respect-off
kind: decision
tags: []
related: [file:src/adjudicator/hooks.ts, file:src/adjudicator/savings.ts, file:tests/unit/adjudicator-ranged-baseline.test.ts]
created: 2026-11-05T09:31:06.890Z
updated: 2026-11-05T09:31:06.890Z
---

Savings baseline of a ranged swarm agent when apply.respectFrontmatter is false (task #131, review #109 F3, swarm run 20261104-672098, 2026-11-05, branch feature/adjudicator). Without the adjudicator, Claude Code runs the agent file's `model:` line, which is the range's fallback. So the baseline is that pin, the same as for a plain pin, and never CLAUDE_CODE_SUBAGENT_MODEL or the main session's model. Before this fix the savings were over-credited about 2× (opus−haiku instead of sonnet−haiku). In src/adjudicator/hooks.ts, onPreAgent passes `baselinePin = pin.status === "ranged" ? pin.model : pinned` as resolveBaseline's `pinned` outside the fork and FORCE branches. Only the baseline widens. Do NOT widen `pinned`/`pinnedRespected`: with respectFrontmatter on, a ranged agent would then take the respected-pin branch and never move. Fork and FORCE keep their baselines. When the range is respected, fallbackPin (source "ranged") still wins. Tests are in tests/unit/adjudicator-ranged-baseline.test.ts.
