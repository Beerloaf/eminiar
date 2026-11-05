---
name: swarm/model-range
kind: decision
tags: [swarm, adjudicator, model-range, agent-pin]
related: [file:src/swarm/config.ts, file:src/swarm/agents.ts, file:src/swarm/types.ts, file:docs/swarms.md, file:tests/unit/swarm-model-range.test.ts]
created: 2026-11-05T07:16:00.600Z
updated: 2026-11-05T07:16:00.600Z
---

Per-role model ranges in swarm.yaml (task #103, swarm run 20261104-672098, 2026-11-05, branch feature/adjudicator; the user approved the design on blackboard model-switching option D). A role, and `defaults`, may set `model_range: { floor?, ceiling? }`. Each bound is a TIERS alias (haiku < sonnet < opus < fable, from src/adjudicator/types.ts). `model` stays the fallback pin: the agent file's frontmatter still says `model: <fallback>`, so with the adjudicator off, erroring or not choosing, a worker runs as before.

Resolution (src/swarm/config.ts roleRange):
- A role's own model_range replaces defaults.model_range whole; bounds are never merged.
- An unset bound is the fallback's tier, where the fallback is the role's model, else defaults.model, classified with tierOf from src/storage/dispatch.ts.
- `{}` means no range. It opts a role out of the default and needs no fallback, so it works with inherit.
- A one-tier result is no range.
- RoleSpec.range ({floor, ceiling}) is set only when floor < ceiling.

Validation errors: floor above ceiling; no fallback; a fallback of inherit or opusplan; a fallback id with no known family; a fallback below the floor or above the ceiling. A problem that comes only from defaults is reported once, at defaults.model_range.

Agent file (src/swarm/agents.ts): a ranged role's marker gets `range=<floor>..<ceiling>` between role= and hash=. The hash covers it: sha1(`range=${r}\n${fm}\n${body}`). An unranged role's marker and hash are unchanged, so its file stays byte-identical (verified on the repo's 9 agent files and the starter's). agentFileRange(raw) returns the range only from an untouched generated file. Any hand edit, including one to the range, breaks the hash, and the agent then counts as a plain pin (fail-safe). This is the reader the adjudicator's resolveAgentPin uses (task #104). Shape details are on blackboard key range-shape. Tests: tests/unit/swarm-model-range.test.ts. Docs: docs/swarms.md "Model ranges".
