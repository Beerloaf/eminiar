---
name: adjudicator/polish-warm-notes-heal-investigate
kind: decision
tags: [adjudicator, heuristic, storage, server]
related: [file:src/server.ts, file:src/tools/em_adjudicate.ts, file:src/storage/sqlite/schema.ts, file:src/storage/sqlite/adjudicator.ts, file:src/adjudicator/features.ts, file:src/adjudicator/heuristic.ts, file:src/adjudicator/types.ts]
created: 2026-11-04T11:23:43.215Z
updated: 2026-11-04T11:23:43.215Z
---

Adjudicator polish (branch feature/adjudicator, swarm run 20261104-483f39, task #26, 2026-11-04).
(1) The server warms the embedding provider in the background. src/server.ts no longer awaits registerServerProviders before connecting. It starts `registerServerProviders(config, {warm:true})` as the promise `providersReady`, and only em_adjudicate and em_swarm (ADJUDICATOR_TOOLS) await that promise before running. When disabled nothing is imported. The warm-up runs detached: first the factory's warm() (exemplar vectors, often read from the disk cache), then the shared embedder's warm(), because a cache hit never loads the model. registerServerProviders takes test seams `factory` and `embedder` (ServerProviderOptions).
(2) Feedback notes are stored in a nullable `adjudications.feedback_note TEXT` column, added to the unreleased v8 in place, with AdjudicationRow.feedbackNote. em_adjudicate stores head(note, NOTE_MAX=500): normalised, redact()ed, whitespace collapsed, cut with "…". The schema accepts up to 4000 chars. A feedback call without a note keeps the earlier note. explain prints a `feedback note: "..."` line.
(3) Pre-release v8 databases are healed. schema.ts exports ADJUDICATOR_LATE_COLUMNS (provider_state.calls, provider_state.auth_fingerprint, adjudications.feedback_note) and healAdjudicatorColumns(db). That function is idempotent, runs one table_info per table, and skips missing tables. SqliteAdjudicatorStore calls it lazily before its first prepare, not at open, so a disabled adjudicator never touches the tables. The store is constructed before the adapter migrates, and adapter.ts is a hot file. When the database is read-only or busy, the heal is retried on the next new statement. Once v8 is released, any further change to these tables gets a new migration number instead.
(4) Heuristic: features.ts adds the FeatureExtras `investigate` and `crossCutting`, and heuristic.ts adds the weights `investigateFloor: 2` and `crossCuttingFloor: 2`. These are floors like taskFloor: they only raise complexity.
- investigate = an investigation verb (why, figure out, look into, investigate, root cause, track down, diagnose, dig into) or `explain`/`walk through` when no symbol or path is named, together with a SYSTEM_SUBJECT noun (cache, build, job, queue, worker, session, sync, memory, latency, ...) or an EMERGENT symptom (twice, duplicate, intermittent, sometimes, doubled, spikes, feels slow, under load).
- crossCutting = THREAD ("thread/plumb/propagate/pass/carry/forward X ... through") or IMPACT_OF_CHANGE ("impact/effect of changing|renaming|removing...", "what will happen if we change...").
These were designed on my own phrasings, without reading the held-out-2 items. Heuristic-only eval, before → after:
- EVAL_SET: tier 92.5 → 92.5%; MAE 0.56 → 0.55.
- held-out: tier 83.3 → 83.3%; complexity exact 55.0 → 53.3%.
- held-out-2: tier 76.7 → 78.3%; under-tier 5 → 3, over-tier 9 → 10; complexity exact 55.0 → 58.3%; ±1 91.7 → 95.0%.
- EXEMPLARS: tier 92.9 → 94.6%.
