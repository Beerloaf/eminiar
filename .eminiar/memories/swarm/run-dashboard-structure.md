---
name: swarm/run-dashboard-structure
kind: decision
tags: [swarm, dashboard, ui]
related: [file:src/ui/web/views/Swarm.tsx, file:src/ui/web/route.ts, file:src/ui/web/router.ts, file:src/ui/web/swarm/run-helpers.ts, file:src/ui/web/swarm/RunHero.tsx, file:src/ui/web/swarm/Workers.tsx, file:src/ui/web/swarm/WorkerDrawer.tsx, file:src/ui/web/swarm/ConfigTopology.tsx, file:src/ui/web/swarm/Topology.tsx, file:tests/unit/swarm-run-helpers.test.ts]
created: 2026-11-05T16:34:08.937Z
updated: 2026-11-05T16:34:08.937Z
---

Swarm run dashboard (#/swarm), task #206, swarm run 20261105-12d798, 2026-11-05, branch feature/swarm-config-ui.
Structure:
- src/ui/web/views/Swarm.tsx is the shell. It holds SwarmNav, the GET /api/swarm overview (15 s), the RunDashboard (rail + RunView), and the #/swarm/config branch where the Configuration Studio mounts.
- Components in src/ui/web/swarm/: RunHero, Workers, WorkerDrawer, ConfigTopology, SwarmNav, and pure run-helpers.ts.
- Everything comes from the existing /api/swarm, /run and /events endpoints, with unchanged polling budgets (15 s, 5 s, 2 s).
Constraints learned:
1. Hash parsing lives in src/ui/web/route.ts, which has no preact import; router.ts re-exports it. Node-side tests must import route.ts and pure helpers that do not import src/ui/web/api.ts. The root tsconfig includes tests/**, so preact or api.ts there pulls in DOM types or browser globals and breaks `tsc --noEmit` (src/fetch/html.ts turndown typings; `location`/`history` in api.ts).
2. Never put CSS containment (container-type) on an ancestor of a ds Drawer: layout containment makes it the containing block for position: fixed. The container query wraps only .sw-grid (.sw-grid-box).
3. Topology and Workers stack by default and sit side by side only when the grid wrapper is at least 1500 px wide: a hierarchical canvas with about 11 workers needs about 1000 px (MIN_SCALE keeps labels readable).
4. The ds Pill already draws a dot, so do not add GLYPH.active next to it.
