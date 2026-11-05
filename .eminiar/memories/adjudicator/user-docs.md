---
name: adjudicator/user-docs
kind: decision
tags: [adjudicator, docs]
related: [file:docs/adjudicator.md, file:docs/configuration.md, file:docs/cli.md, file:docs/tools.md, file:docs/dashboard.md, file:README.md]
created: 2026-11-04T11:43:12.082Z
updated: 2026-11-05T11:31:16.287Z
---

Adjudicator user docs (branch feature/adjudicator, swarm run 20261104-483f39, task T14/#19, 2026-11-04, v0.13.0). docs/adjudicator.md is the user guide: why, cost when off (hook p50 within 1 ms of pre-adjudicator base 6db2683), enabling (install question, /em-onboard, `eminiar adjudicator enable`, /mcp reconnect), a per-provider privacy table, keys (~/.eminiar/adjudicator.key 0600; order keyEnv > provider env > EMINIAR_ADJUDICATOR_KEY > file), advise vs apply with Claude Code model precedence, plan advice, em_adjudicate, learning, savings assumptions, accuracy, guards, troubleshooting, kill switch. The `adjudicator` table in docs/configuration.md lists all 53 leaf keys; it was checked against eminiar.config.schema.json by flattening the schema's adjudicator properties and diffing key names and defaults. Redo that check whenever the schema changes. Eval numbers in the docs (2026-11-04, scorer v1, bge-small k5): heuristic tier built-in 37/40 (in-sample), held-out 50/60 (used to check tuning), held-out-2 47/60 (blind; majority 45%; under 5.0% / over 16.7%). The embedding blend scored 36/40, 49/60 and 47/60, and its verdict was "no" on all three sets. Jev was measured on 2026-11-05 and its table is in the Accuracy section (see adjudicator/jev-blend-tuning); the OpenAI-compatible providers are still documented as unmeasured. If they are measured, or the heuristic is retuned, update the Accuracy section of docs/adjudicator.md.
