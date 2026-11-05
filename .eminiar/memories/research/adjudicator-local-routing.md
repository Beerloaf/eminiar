---
name: research/adjudicator-local-routing
kind: note
tags: []
related: []
created: 2026-11-04T10:21:19.151Z
updated: 2026-11-04T10:21:19.151Z
---

Adjudicator local-routing research (swarm run 20261104-483f39, 2026-11-04, M5 Pro). Measured: bge-small q8 kNN over exemplars costs ~120 ms wall and ~200 MB RSS in a fresh node process (1.6 ms warm per prompt); only useful for model tier and complexity, no signal for tool choice at 40 exemplars. transformers.js zero-shot (mobilebert 27 MB, deberta-xsmall 87 MB) costs 17-19 ms but is near baseline; transformers.js text-generation (Qwen2.5 0.5B/1.5B q4, 786 MB / 1.8 GB) is NOT viable (invalid JSON, 741 ms, accuracy <= majority). Local LLM servers (Ollama 11434, LM Studio 1234, llama.cpp 8080) all accept JSON-schema structured output via the OpenAI-compatible adapter; their latency is estimated (warm 150-400 ms for 1.5B, cold +1-5 s). Hook rule: no model call on the PreToolUse hot path; use heuristic plus cached/async verdicts, circuit breaker, and put LLM adjudication in em_swarm plan or the MCP server. Full notes: blackboard keys research-local, research-local-2, research-local-3 (includes a 40-item eval set).
