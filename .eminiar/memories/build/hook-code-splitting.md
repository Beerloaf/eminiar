---
name: build/hook-code-splitting
kind: decision
tags: [performance, build, adjudicator, hook]
related: [file:tsup.config.ts, file:src/hook.ts, file:src/adjudicator/hooks.ts, file:src/storage/adapter.ts]
created: 2026-11-04T11:25:08.967Z
updated: 2026-11-04T11:25:08.967Z
---

Hook bundle is code-split (branch feature/adjudicator, swarm run 20261104-483f39, task #27, 2026-11-04). tsup.config.ts is an array: server+cli keep splitting:false (one file each); the hook build (src/hook.ts → dist/hook.js) uses splitting:true with chunkNames "hook-[name]-[hash]" so chunks sit flat in dist/ (NOT a subfolder: src/version.ts pluginRoot() is dirname(dirname(import.meta.url)) and would break one level deeper). Why: with splitting:false esbuild inlines every dynamic import() (adjudicator/hooks.js, adjudicator/async.js) into dist/hook.js as __esm wrappers, and every hook process paid ~3-4 ms p50 to parse/eval ~240 KB of adjudicator code even when the adjudicator is off. Split, the adjudicator lands in dist/hook-hooks-*.js / hook-async-*.js / one engine chunk, loaded only when enabled, and shares the same module instances (context cache, one SQLite connection) — separate tsup entries were ~1.2 ms faster but duplicate getContext/getStorage state (second DB connection, second config parse), so they were rejected. Cleaning: the server/cli build cleans dist with negations for hook.js, hook.js.map, hook-*; the hook build has clean:false and an esbuild onStart plugin that deletes the previous hook.js and hook-* files (chunk names are hashed). Keep src/hook.ts and src/hooks/* reaching the adjudicator only through dynamic import(). Measured (60 interleaved runs, compile cache): PreToolUse Bash p50 base(6db2683) 42.5 / static import 50.0 / dynamic-but-inlined 48.8 / split 44.9 ms. StorageAdapter gained metaDelete(key); onSessionEnd deletes meta adjudicator:main:<sessionId>.
