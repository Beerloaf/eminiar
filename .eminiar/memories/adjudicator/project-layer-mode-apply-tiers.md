---
name: adjudicator/project-layer-mode-apply-tiers
kind: todo
tags: [adjudicator, security, trust-boundary]
related: [file:src/adjudicator/config.ts, file:src/config.ts, file:docs/configuration.md]
created: 2026-11-05T10:16:00.854Z
updated: 2026-11-05T10:16:00.854Z
---

Follow-up approved by Ryan (2026-11-05, after swarm run 20261104-672098, review #109): the project layer (<root>/eminiar.config.json, committed with any clone) can still set the adjudicator's `mode`, `apply.*` (scope, floor, ceiling, minConfidence, respectFrontmatter) and `tiers`. Decision: those keys become personal-config only (~/.eminiar/config.json), like provider/keys/budget already are (see adjudicator/project-layer-trust-boundary). A project file may still turn the adjudicator off or keep it advise-only (i.e. it may only make it more conservative). Touches src/adjudicator/config.ts projectLayer allowlist, docs/configuration.md, tests for the allowlist; status/doctor should say when a project key was ignored.
