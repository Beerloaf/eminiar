---
name: adjudicator/apply-pinned-swarms-warning
kind: decision
tags: [adjudicator, apply, model-range, doctor, status, docs, swarm]
related: [file:src/adjudicator/cli.ts, file:src/swarm/brief.ts, file:docs/adjudicator.md, file:docs/design/adjudicator.md, file:tests/unit/adjudicator-cli.test.ts, file:tests/unit/swarm-core.test.ts]
created: 2026-11-05T08:51:42.880Z
updated: 2026-11-05T08:51:42.880Z
---

Model-switching docs and the all-pinned nudge in status/doctor (task #108, swarm run 20261104-672098, 2026-11-05, branch feature/adjudicator).

Status/doctor (src/adjudicator/cli.ts):
- pinnedSwarms(root, config, env) returns the opted-in swarms (activeSwarmConfig) whose every role resolves to resolveAgentPin status "pinned". This is the same rule as em_swarm plan's ALL_PINNED_NOTE (swarm.ts adjudicatePlan allRolesPinned).
- It returns [] when apply.respectFrontmatter is off, under CLAUDE_CODE_SUBAGENT_MODEL_FORCE (which has its own warning), or when there are no swarms.
- pinnedSwarmsNote(names) gives: every role of swarm "x" pins a model, so apply mode cannot change any worker (add model_range in swarm.yaml, then `eminiar swarm sync`).
- `eminiar adjudicator status` prints it as a `warning:` line in apply mode only. StatusReport.pinnedSwarms is the list in apply mode and null otherwise.
- Doctor adds the check "adjudicator swarm pins" with ok: true. It is information, not a failure, so `eminiar install` and doctor exit codes do not change: the pins are respected by design.

Coordinator brief (src/swarm/brief.ts): when the adjudicator and its plan surface are on and some role has a range, the "Adjudicator on" line adds: "Roles listed with a range run on their fallback model unless their line says `model X (range …)`: then pass model X."

Docs: docs/adjudicator.md and docs/design/adjudicator.md no longer call apply mode best effort or undocumented. Researcher task #99 verified on Claude Code 2.1.309 (claude -p, n=1 per case) that a model the hook sets through updatedInput beats both the frontmatter pin and the call's own model. Real causes of "k of n applied dispatches ran the chosen model" are listed:
- FORCE
- an org availableModels substitution
- a mod's agent.spawn hook
- another plugin's updatedInput
- a link gap: a fork started in the same window, or usage not yet ingested

The docs also now cover:
- model_range and the ranged rule-table row
- per-statement brief scoring (design §7.9)
- the role-note gate (0.7)
- informational effort for saturated briefs
- harness envelopes not scored
- multi-ref spawn task linking (#100/#121)
- the savings baseline (a ranged role's fallback; CLAUDE_CODE_SUBAGENT_MODEL for an agent with no model line)

Tests:
- tests/unit/adjudicator-cli.test.ts, describe "apply mode while every swarm role pins a model (#108)"
- tests/unit/swarm-core.test.ts, "tells the coordinator how to read a ranged role's line…"

Left for follow-ups:
- docs/configuration.md L168 still says "(best effort)", and L203 respectFrontmatter does not mention ranges.
- skills/em-doctor/SKILL.md check list.
- #122 changes the envelope rule, so the docs sentence must change with it.
- savings.ts SAVINGS_ASSUMPTIONS says "no model pin" where the hook means "no model line" (inherit excluded).
