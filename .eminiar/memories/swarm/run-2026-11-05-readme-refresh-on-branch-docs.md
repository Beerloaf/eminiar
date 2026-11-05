---
name: swarm/run-2026-11-05-readme-refresh-on-branch-docs
kind: note
tags: [swarm, feature]
related: [README.md]
created: 2026-11-05T18:44:46.156Z
updated: 2026-11-05T18:44:46.156Z
---

Swarm run 20261105-d2159e (swarm "feature", hierarchical, 2026-11-05): done.
Goal: README refresh on branch docs/readme-swarm-screenshots (PR): replace the top hero screenshot (source explorer) with the swarm run dashboard screenshot (docs/images/dashboard-swarm-*.webp), and add the existing matching web UI screenshots from docs/images to each feature section under "What you get" (sandbox, search, memory, graph, history, docs KB, usage, swarms, adjudicator, dashboard). No new screenshots; keep light/dark picture pattern where both exist; commit .eminiar files too.
Outcome: README refresh: hero is now the swarm run dashboard screenshot (light/dark picture); existing web UI screenshots added to the Memory, Code graph, Git history, Docs KB, Usage and Local dashboard sections (Agent swarms already had them; Sandbox, Search and Adjudicator have none and were skipped). Reviewer found captions claiming a task board and memories/docs nodes that the images do not show, and a stale 'architecture map' mention; both fixed. Left open: screenshots still show the Architecture tab and should be retaken after chore/ui-align-remove-architecture merges; README Local dashboard text may conflict with the UI branch.
4 task(s), 1 worker(s), 5 min.
- #245 [done] (coder) README: swarm hero screenshot plus a UI screenshot in each feature section — README.md only (+23/-13). Hero <picture> now dashboard-swarm-dark/light.webp at width 900, with a new alt and the caption "The Swarms dashboard: live topology, task board and workers of a run." Image…
- #246 [done] (reviewer) Review README screenshot changes — Reviewed README.md diff. Structural checks pass: all 12 image paths exist, all 9 docs/dashboard.md anchors resolve, hero <picture> light/dark pattern correct, tables well-formed, no Hotspots/Architec…
- #255 [done] (coder) README: fix screenshot captions/alt that claim content not in the image — README.md: hero alt+caption now 'progress rings, run stats and the live topology'; galaxy alt now 'files and symbols ... by imports, calls and references'. (c) kept duplicate swarm-dark in table (the…
- #256 [done] (coder) README: drop 'an architecture map' from Local dashboard sentence (page removed on chore/ui-align-remove-architecture) — README.md Local dashboard sentence: removed 'an architecture map', added 'a swarm monitor with a configuration studio'. Hotspots mentions untouched. Merge note: whichever of this and ui-align lands s…
