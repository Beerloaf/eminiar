---
name: adjudicator/libraries-hint-typed-and-keyed
kind: decision
tags: []
related: [file:src/adjudicator/types.ts, file:src/adjudicator/engine.ts, file:src/adjudicator/hooks.ts, file:tests/unit/adjudicator-hooks.test.ts]
created: 2026-11-05T08:43:52.199Z
updated: 2026-11-05T08:43:52.199Z
---

Adjudicator `libraries` hint is typed end to end and part of the cache key (swarm run 20261104-672098, task #125, follow-up to #118, branch feature/adjudicator, 2026-11-05). AdjudicationRequest.hints (src/adjudicator/types.ts) has `libraries?: readonly string[]` (the em_docs manifest names + npm/pypi/go/crate packages, lower case; hooks.ts docsLibraries passes them on the prompt and agent surfaces). engine.ts cacheKeyFor adds `libraries` (deduped, sorted) to the key inputs, so a hook verdict scored with the list never reuses an MCP/CLI verdict scored without it; requests without the hint keep their old keys (stableJson drops undefined), so no SCORER_VERSION bump. features.ts FeatureHints still intersects the same field (compatible). Also: HARNESS_ENVELOPE in hooks.ts now includes `ci-monitor-event`, so `<ci-monitor-event …>` UserPromptSubmit turns are skipped like other harness envelopes. Not done: passing the hint from em_adjudicate / em_swarm plan (MCP side).
