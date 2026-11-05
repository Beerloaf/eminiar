---
name: decision/web-dashboard-architecture
kind: decision
tags: [dashboard, ui, cli]
related: [file:src/ui/page.ts, file:src/ui/server.ts, file:src/ui/api.ts, file:src/cli.ts, file:src/storage/adapter.ts, file:tests/integration/dashboard.test.ts]
created: 2026-10-13T16:41:58.147Z
updated: 2026-11-05T18:59:55.904Z
---

Web dashboard (branch feature/web_dash_board, v0.1.3, 2026-10-13): `eminiar ui` (alias `serve`) serves one self-contained HTML page from `src/ui/page.ts` on 127.0.0.1 with a JSON API in `src/ui/server.ts` backed by `src/ui/api.ts`. No frontend build step and no external assets: the client script is embedded in a template literal, so it must avoid backticks and `${` and double its string escapes (NL = String.fromCharCode(10)). The graph view is a hand-written force layout in SVG (O(n²) repulsion, fine up to ~400 nodes); `/api/graph?mode=map` returns the file-level import/co-change map and `mode=subgraph` a bounded neighbourhood, both as {nodes, edges} for it. Memory editing goes through the same `src/memory/store.ts` functions as em_memory (write with replace, rename, remove), so the files stay the source of truth. Mutations are POST/PUT/PATCH/DELETE only; `/api/actions` wraps em_reindex, em_index, em_purge (still requires confirm), fullDoctor and reconcile and returns {ok, output, ms} for the action log. `sessionsRecent(limit)` was added to StorageAdapter for the sessions tab. Update 2026-11-05: there is no Architecture tab any more; its panels (Folder map, Routes, Hotspots, Structure, Behavior) are tabs of the Galaxy page beside Galaxy and Hierarchy (`#/galaxy?tab=`), and `#/architecture` redirects there. See dashboard/architecture-in-galaxy.
