---
name: adjudicator/embedding-provider
kind: decision
tags: []
related: [file:src/adjudicator/providers/embedding.ts, file:src/adjudicator/data/exemplars.ts, file:tests/unit/adjudicator-embedding.test.ts]
created: 2026-11-04T10:55:48.043Z
updated: 2026-11-04T10:55:48.043Z
---

Adjudicator embedding provider (branch feature/adjudicator, swarm run 20261104-483f39, task T5, 2026-11-04): src/adjudicator/providers/embedding.ts does k-NN over the labelled exemplars in src/adjudicator/data/exemplars.ts with the shared src/embeddings bge-small model (defaultEmbeddingFactory(config) → getProvider(config); never a second model). It answers tier + complexity only (no tool/role: research found no tool signal). Exemplars and requests are both embedded as "passage" (symmetric). Exemplar vectors are cached at ~/.eminiar/models/adjudicator-exemplars-<sha256(format, model id, texts)[:16]>.json; editing any exemplar text re-embeds once. Exemplars MUST stay disjoint from data/evalset.ts (unit test: no equal text, token Jaccard < 0.5) — never tune exemplars on the eval set. Only src/server.ts and the CLI may register it (registerProvider("embedding", ...)); providers/index.ts and hooks never import it. Requests with no neighbour ≥ minSimilarity get no answer (engine falls back). Baseline on the 40-item eval set with real bge-small, k 5: tier 0.575 (majority 0.475), complexity exact ~0.50, ±1 0.75.
