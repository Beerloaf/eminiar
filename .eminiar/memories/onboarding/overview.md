---
name: onboarding/overview
kind: onboarding
tags: [onboarding, overview]
related: [file:src/server.ts, file:src/hook.ts, file:src/cli.ts, file:.claude-plugin/plugin.json, file:hooks/hooks.json, file:README.md, file:src/ui/server.ts]
created: 2026-10-13T16:17:52.319Z
updated: 2026-11-05T18:59:54.978Z
---

eminiar is a local-first Claude Code plugin (npm package `eminiar`, MIT, author Ryan Dick, repo github.com/rydn/eminiar, v0.2.0 on branch feature/graph_enhancement / PR #6) that keeps raw tool output out of the model's context window and gives Claude a persistent code knowledge graph. It started as a clean-room reimplementation of context-mode (sandbox exec + FTS5 index + hook-driven session memory) and now adds local embeddings (sqlite-vec + bge-small), file-backed markdown memories with ADR-style decisions, a tree-sitter graph for TypeScript/JavaScript, Python and Go (symbols, imports, calls, references, routes, metrics, clusters, cycles), git co-change signals, and a Preact dashboard modelled on codebase-memory-mcp's "CBM Lens" but in eminiar's grey/blue theme.

Who it is for: Claude Code users and teams who want the model to run commands, read big files, fetch docs, search history and answer structural questions ("what calls X", "what does this diff reach", "where are the routes") without pasting kilobytes into the conversation. All tools are `em_*`; slash commands are `/em-stats`, `/em-doctor`, `/em-index`, `/em-search`, `/em-graph`, `/em-purge`, `/em-onboard`.

Main runtime pieces (three node bundles in `dist/` from `tsup.config.ts`, one browser bundle in `dist/ui/` from `tsup.web.config.ts`, launched through `bin/` shell shims):
- MCP server (`src/server.ts` → `bin/em-server`): registers the 20 `em_*` tools from `src/tools/*.ts`: execute, batch_execute, execute_file, fetch_and_index, index, search, recall, remember, memory, symbols, architecture, graph_query, graph_impact, graph_changes, graph_add, reindex, index_status, stats, doctor, purge. Declared inline under `mcpServers` in `.claude-plugin/plugin.json`. On start it reconciles memories, reindexes changed code, refreshes git signals and embeds pending chunks in the background.
- Hook runner (`src/hook.ts` → `bin/em-hook`): one binary for every event in `hooks/hooks.json`. SessionStart injects routing guidance plus a budgeted project brief (onboarding overview, accepted decisions, hot files, index freshness; after compaction only the freshness line). PreToolUse routes Bash/Read/Grep/WebFetch to `em_*` (annotate or enforce), prefixes Agent/Task prompts with the brief, and adds non-blocking graph context: matching symbols for Grep/Glob patterns, coverage warnings for partially indexed files. PostToolUse captures events and queues edited code files for reparse.
- CLI (`src/cli.ts` → `bin/eminiar`): install/upgrade/uninstall/doctor/replace-context-mode, search, graph (architecture, status, changes, impact, deps, neighbors, path, hotspots, routes, dead_code, cycles, clusters, coupled, orphans, pattern), index, reindex, stats, recall, `ui` (dashboard), statusline.
- Dashboard (`src/ui/server.ts` + `src/ui/web/`): `eminiar ui` serves `dist/ui` on 127.0.0.1 with workspaces Overview, Explore (source + impact + code details), Galaxy (tabs Galaxy, Hierarchy, Folder map, Routes, Hotspots, Structure, Behavior; the old Architecture page was folded in and #/architecture redirects here), Memory (editor + decision record), Coverage, Sessions, System.

Storage: one SQLite DB per project at `~/.eminiar/projects/<id>/eminiar.db` (schema v4: documents/chunks + FTS5 + vec0, sessions/events/snapshots/stats, graph_nodes/graph_edges/graph_metrics, file_index with status, index_runs, memories with status/supersedes) plus a global DB for lifetime stats and the fetch cache; the embedding model under `~/.eminiar/models/`; a pinned stable plugin copy under `~/.eminiar/plugin/`. All SQL lives behind `src/storage/adapter.ts`.

Config precedence: `~/.eminiar/config.json` < `<project>/eminiar.config.json` < `EMINIAR_*` env. Schema in `eminiar.config.schema.json` (generated).
