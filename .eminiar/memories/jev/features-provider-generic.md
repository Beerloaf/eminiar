---
name: jev/features-provider-generic
kind: decision
tags: []
related: []
created: 2026-11-05T21:19:35.414Z
updated: 2026-11-05T21:19:35.414Z
---

Jev feature integrations must stay provider-generic (user decision 2026-11-05, swarm run 20261105-d18b04, branch feature/jev-integrations). Like the first adjudicator implementation, the new features (recall rerank, memory hygiene, commit note, compaction triage, swarm judge, docs triage) go through a capability-named decision client (yes_no | choice | score) that resolves any configured adjudicator provider: typesafe/Jev, OpenAI-compatible endpoints (Groq, Cerebras, Ollama, LM Studio, llama.cpp, custom) or the local embedding model. Jev is one provider, not the abstraction. Config is adjudicator.features.*, personal-only; consent per data class and provider origin, none for local providers. A provider that cannot answer a kind returns 'unsupported' and the feature falls back to its deterministic path. **Why:** the user wants the same open-ended provider choice the adjudicator already has. **How to apply:** do not put Jev types, names or config keys in feature modules; docs/design/jev-integration-options.md describes the Jev-first options and should say this is generalised.
