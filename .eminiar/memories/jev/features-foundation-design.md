---
name: jev/features-foundation-design
kind: decision
status: proposed
tags: [jev, adjudicator, design, privacy, hooks]
related: [file:docs/design/jev-integration-options.md, file:src/adjudicator/providers/typesafe.ts, file:src/config.ts, file:src/storage/sqlite/schema.ts, file:src/hooks/capture.ts, file:src/hooks/routing.ts, file:src/hooks/pre-compact.ts, file:src/session/recall.ts]
created: 2026-11-05T21:11:13.179Z
updated: 2026-11-05T21:11:13.179Z
---

Jev feature integrations design (task #277, swarm run 20261105-d18b04, 2026-11-05, branch feature/jev-integrations; full design on blackboard design-jev-features … design-jev-features-5; spec docs/design/jev-integration-options.md).

Module layout:
- New dir src/jev/: types, wire, config, consent, client, cache, job, hooks, registry, and features/<f>.ts.
- wire.ts holds the Jev wire format moved out of providers/typesafe.ts with no behaviour change. The adjudicator engine does NOT use JevClient; engine.ts, breaker.ts and async.ts stay untouched.

JevClient.ask(input, decide):
- Gates through breaker.ts gate() on the SAME "typesafe" provider row, so the breaker, slow guard and dailyUsd/dailyCalls are shared with the adjudicator.
- Redacts every item with forRemote(maxChars), caches per item, makes one jev_calls insert, and captures exchanges as surface "jev:<feature>".
- Never throws.
- `apply` = live && ok && changed > 0. Shadow mode only records.

Config: adjudicator.jev.features.{recall,memory,commit,compaction,swarm,docs}.
- Each is an object with enabled:false, shadow:true and thresholds, with a boolean shorthand.
- adjudicator.jev.consent holds "<dataClass>@<origin>" entries.
- Personal-only because "jev" is not in PROJECT_ADJUDICATOR_KEYS.
- EMINIAR_JEV=0 withdraws everything; no env var grants a feature.

Data classes (one consent line each, bound to the origin):

| Feature | Data class |
|---|---|
| recall, memory | memory |
| commit | diffs |
| compaction | session |
| swarm | swarm |
| docs | packages |

Storage: migration v10 adds jev_calls (shadow/live verdicts, note outbox, feedback; newest 5000) and jev_cache.
- Only ids, labels, numbers and template notes are stored, never prompt, memory, diff or output text.

Hot path:
- Hooks NEVER call Jev. They may only read the cache, peek at provider state, record a row, drain the note outbox and spawn ONE detached `em-hook --jev` job.
- Only the foundation edits hook files: hook.ts, hooks/capture.ts, hooks/routing.ts, hooks/pre-compact.ts.
- MCP/CLI calls go inline with mcpMs. The swarm judge runs in the background.

Where each feature runs:
- recall: deferred in hooks (rerank from the cache only), inline in em_recall.
- commit: the note is delivered at PostToolUse through the outbox.
- compaction: the job may replace the unconsumed snapshot.

Answers to the owner's open decisions:
- D1: one object per feature.
- D2: consent per data class.
- D3: a section in the Jev impact panel.
- D4: shadow per feature, on by default.
