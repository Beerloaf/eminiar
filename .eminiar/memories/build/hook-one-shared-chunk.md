---
name: build/hook-one-shared-chunk
kind: decision
tags: [build, performance, hooks]
related: [file:tsup.config.ts, file:src/hook.ts, file:scripts/bench-hotpath.mjs, file:tests/unit/decisions-config-wave4.test.ts]
created: 2026-11-05T22:58:41.315Z
updated: 2026-11-05T22:58:41.315Z
---

The hook bundle loads exactly two files up front (task #311, review F7, swarm run 20261105-d18b04, 2026-11-06, branch feature/jev-integrations). esbuild splitting makes one chunk per distinct set of entries (hook.js + each import() target) that reaches a module. The lazy decision features each reached a different slice of the hook's static graph, so hook.js loaded 10 files (vs 3 pre-branch) and each file costs a read/parse/link: +0.8-0.9 ms p50 with everything off. Fix in tsup.config.ts (hook build only): esbuild plugin oneSharedHookChunk() appends `import "<abs>/src/hooks/dispatch.ts"; import "<abs>/src/hooks/log.ts";` (what src/hook.ts imports) to every lazy entry matched by HOOK_LAZY (adjudicator/hooks|async, decisions/hooks|run-job|features/*). They run in a hook process that already loaded those modules, so nothing changes at run time, but all static modules share one entry set: hook.js + one shared chunk. onEnd fails the build when an internal import() target is not matched by HOOK_LAZY: add new lazy hook entries there. The server/CLI builds are untouched (server must stay static, see jev/server-static-hook-lazy-decisions). tests/unit/decisions-config-wave4.test.ts asserts <= 2 static files when dist/hook.js exists. Bench (scratch baseline build, 120 runs): adjudicator off p50 over baseline prompt +0.81 -> +0.20..0.32 ms, bash +0.94 -> +0.10..0.34 ms; adjudicator on (heuristic) features off +0.44 / +0.30 ms (review measured +3.9 / +3.8).
