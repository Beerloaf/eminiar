---
name: decision/adjudicator-architecture
kind: decision
tags: [adjudicator, architecture]
related: [file:src/adjudicator/engine.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/swarm.ts, file:src/adjudicator/config.ts, file:src/config.ts, file:src/tools/em_adjudicate.ts, file:src/ui/web/views/Adjudicator.tsx, file:scripts/check-bundle.mjs, file:tsup.config.ts, file:docs/adjudicator.md, file:docs/design/adjudicator.md]
created: 2026-11-04T14:59:08.029Z
updated: 2026-11-04T14:59:08.029Z
---

Adjudicator (branch feature/adjudicator, v0.13.0, swarm run 20261104-483f39, 2026-11-04; user guide docs/adjudicator.md, spec docs/design/adjudicator.md). An OPT-IN, off-by-default subsystem that scores each request/task (complexity 0–4, eminiar tool, Claude model tier + effort, swarm role) to save tokens. Scope ruling: choosing a subagent model through Claude Code's own Agent `model`/`effort` parameters is in scope and does NOT violate decision/usage-insights-no-proxy — nothing intercepts API traffic; the main session gets advice text only.
Key choices:
- Providers: heuristic (default and universal fallback; held-out tier accuracy ~77–83%, opus recall 10/10), embedding (k-NN over exemplars with the existing bge-small model; adds little over the heuristic), typesafe = Jev (api.typesafe.ai, one batched choice/score/noul request, pinned jev-1.14.0), openai-compatible presets (groq, cerebras, ollama, lmstudio, llama.cpp, custom). Plain fetch, no new deps, redirects refused.
- Off costs nothing: lazy imports, hook bundle split into hook-* chunks, adjudicator zod section built lazily; disabled hook ≤ 1 ms p50 over main (bench --assert). Server and CLI ship as single files with only static internal imports; scripts/check-bundle.mjs fails the build on chunks or lazily wrapped zod (the "Class2 is not a constructor" crash).
- Advice is primary; apply mode (rewrite Agent `model` via updatedInput) is opt-in. One dispatchRule table drives plan lines, the Next line and the Agent note: forks informational; FORCE → model informational; pinned/unknown pins (resolveAgentPin, Claude Code's lookup order) → pass no model; effort passed unless CLAUDE_CODE_EFFORT_LEVEL or the call sets it. Forced/fork/kept-pin rows earn no savings credit.
- Trust & privacy: remote consent is bound to exact origins in remoteConsentOrigins, only from a personal config the repo cannot relocate (passwd-home ~/.eminiar or an absolute EMINIAR_HOME outside the project, its ancestors and git work trees incl. submodule superprojects); env vars can only withdraw consent; the project eminiar.config.json may set only an allowlist of adjudicator keys; config JSON drops __proto__/constructor/prototype; keys live in a 0600 key file (never argv, logs, DB, dashboard); prompts are redacted (default-ignorable stripping + NFKC, many credential shapes) and capped before leaving the machine.
- Robustness: engine never throws; breaker/caps fail closed under a busy DB with budget-bounded lock waits; atomic half-open claim; slow guard on latency/budget ratios; daily $ and call caps; auth lockout by key fingerprint.
- Learning: bounded per-bucket biases from outcomes and feedback; each row records exactly what it taught. Savings: credited only for followed/applied dispatches, net of adjudicator spend, redo penalty; summary and savingsReport share src/storage/dispatch.ts.
Five adversarial review rounds; known accepted limits are listed in docs/adjudicator.md. Pre-existing project-config issues found on the way are in security/project-config-layer-followups.
