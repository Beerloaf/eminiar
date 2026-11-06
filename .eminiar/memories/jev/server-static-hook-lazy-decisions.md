---
name: jev/server-static-hook-lazy-decisions
kind: constraint
tags: []
related: [file:src/decisions/registry.ts, file:src/decisions/run-job.ts, file:src/decisions/job.ts, file:src/hook.ts, file:src/session/guide.ts, file:src/hooks/pre-compact.ts, file:tsup.config.ts, file:scripts/check-bundle.mjs]
created: 2026-11-05T22:33:45.882Z
updated: 2026-11-05T22:33:45.882Z
---

Decision features: the server imports them statically, the hook loads them lazily (task #316, swarm run 20261105-d18b04, 2026-11-06, branch feature/jev-integrations).

dist/server.js is one file (splitting:false). In it, any dynamic import() of an internal module, even one later tree-shaken away, wraps its whole graph lazily. When that graph includes zod, the server crashes with "Class2 is not a constructor", and scripts/check-bundle.mjs fails the build.

Rules:
(1) Server-side tools (sandbox/output.ts, em_docs, em_recall, em_remember, em_swarm) import decisions/features/* and decisions/client statically.
(2) src/decisions/registry.ts (lazy per-feature loaders) is hook-only. It is imported only by decisions/hooks.ts and decisions/run-job.ts, which src/hook.ts reaches through dynamic import. Nothing the server reaches may import it.
(3) decisions/job.ts is the spawn/slot side, which the server reaches through features/swarm. runDecisionJob, the child entry for `em-hook --decision`, lives in decisions/run-job.ts.
(4) Server-reachable code must not import from src/hooks/* modules that dynamic-import decisions/hooks or adjudicator/hooks. Example: SNAPSHOT_BUDGET moved to session/guide.ts; hooks/pre-compact re-exports it.

To diagnose: wrapped src/ modules in dist/server.js with no visible import() site mean that some module in their graph has a dynamic import that was tree-shaken. Grep those modules' sources for import(.
