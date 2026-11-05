---
name: dashboard/architecture-in-galaxy
kind: decision
tags: [dashboard, ui, galaxy, architecture]
related: [file:src/ui/web/route.ts, file:src/ui/web/views/Galaxy.tsx, file:src/ui/web/app.tsx, file:docs/dashboard.md, file:docs/knowledge-graph.md]
created: 2026-11-05T18:59:56.353Z
updated: 2026-11-05T18:59:56.353Z
---

Architecture page folded into Galaxy (swarm run 20261105-14dc4f, branch chore/ui-restyle-architecture-in-galaxy, 2026-11-05, user request). The dashboard no longer has an Architecture nav entry or view (src/ui/web/views/Architecture.tsx deleted). Its panels moved to src/ui/web/views/galaxy-tabs/ (FolderMap, Routes, Hotspots, Structure, Behavior) and are tabs of the Galaxy page, in this order: Galaxy, Hierarchy, Folder map, Routes, Hotspots, Structure, Behavior (ids galaxy, hierarchy, map, routes, hotspots, structure, behavior; GALAXY_TABS in src/ui/web/route.ts). The tab lives in the URL (#/galaxy?tab=<id>); without one, a node= link opens the graph, else the last tab used (localStorage eminiar.galaxy.tab), else Galaxy. Redirect: parseHash maps #/architecture?tab=x to #/galaxy?tab=x via legacyArchitectureTab (the old "overview" tab, no tab or an unknown tab → map), keeping the other params, so old bookmarks and docs links keep working. Why: a more compact top menu, and the architecture panels belong with the code graph. Docs: docs/dashboard.md describes the seven tabs under ### Galaxy (anchor #galaxy; #architecture no longer exists). Don't re-add a separate Architecture page.
