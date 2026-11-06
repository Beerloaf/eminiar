---
name: build/hook-adjudicator-hub
kind: decision
tags: []
related: []
created: 2026-11-06T00:06:45.617Z
updated: 2026-11-06T00:06:45.617Z
---

Adjudicator-on hook path shares one more chunk (task #340, review #335 F3, swarm run 20261105-d18b04, 2026-11-06). tsup.config.ts HOOK_ADJUDICATOR (src/adjudicator/hooks.ts, async.ts) is appended to the oneSharedHookChunk hub next to HOOK_STATIC, so their static graph (engine, config, redact, providers, breaker) lands in one core chunk: adjudicator-on + features off prompt/PreToolUse(Bash) loads 4 files (hook.js, shared, hook-hooks, core) vs 7 before and 5 pre-branch. Two lazy entries are named "hooks" (adjudicator and decisions); scripts/check-bundle.mjs checkHookChunks(hook, files, read) holds the smaller closure to HOOK_ADJUDICATOR_MAX_FILES = 4. Bench vs pre-branch (120 runs): adjudicator-on prompt p50 +0.9 -> +0.2 ms, bash +0.6 -> 0.0. Server bundle untouched.
