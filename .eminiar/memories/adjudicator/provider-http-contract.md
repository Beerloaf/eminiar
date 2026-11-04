---
name: adjudicator/provider-http-contract
kind: decision
tags: []
related: [file:src/adjudicator/providers/http.ts, file:src/adjudicator/providers/typesafe.ts, file:src/adjudicator/providers/openai.ts, file:src/adjudicator/providers/index.ts, file:src/adjudicator/prompt.ts]
created: 2026-11-04T10:50:15.861Z
updated: 2026-11-04T10:50:15.861Z
---

Adjudicator provider contract (branch feature/adjudicator, swarm run 20261104-483f39, task T4, 2026-11-04):
- src/adjudicator/providers/http.ts is the only HTTP path. It uses plain fetch with an AbortController, and `deadlineMs` is a RELATIVE budget that covers the single 429/529 retry and the body read. A retry happens only when at least 300 ms remain after the wait.
- `ProviderError.kind` uses the ProviderStatus values timeout, http_error, rate_limited, invalid and no_key. A refused connection or DNS failure is an http_error with no status.
- Keys are fetched with resolveKey at send time. They appear only in the Authorization header. Errors and log lines go through scrub(), which removes the verbatim key and applies redact(). A sentinel-key test enforces this.
- Request keys never leave the machine: items get positional ids (i0, i1, …) and their text goes through forRemote().
- Jev: the model is pinned (aliases jev-latest and jev-preview become jev-1.14.0). A request holds at most 10 items, and a call makes at most 2 parallel requests.
- OpenAI-compatible: requests use a strict json_schema of at most 5000 chars. With json "auto", a 400 that names response_format or json_schema falls back to json_object, and the provider instance remembers this. gpt-oss models get reasoning_effort "low".
- Both providers ask the tool question or field only when weights.features.toolProvider > 0.
- providers/index.ts (createProvider/registerProvider) must never import embedding.ts. The server and CLI register it at runtime.
