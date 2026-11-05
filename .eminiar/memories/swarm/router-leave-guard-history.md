---
name: swarm/router-leave-guard-history
kind: decision
tags: []
related: [file:src/ui/web/route.ts, file:src/ui/web/router.ts, file:src/ui/web/api.ts, file:tests/unit/route-history.test.ts]
created: 2026-11-05T18:09:51.565Z
updated: 2026-11-05T18:09:51.565Z
---

Dashboard router leave-guard history sync (task #232, swarm run 20261105-12d798, 2026-11-05, branch feature/swarm-config-ui).

- All history bookkeeping lives in createRouteSync() in src/ui/web/route.ts. That module is preact- and DOM-free, so tests drive it with a fake browser history in tests/unit/route-history.test.ts. The fake models async traversals, popstate plus hashchange, a query-only difference, missing entries and dropped go() calls. router.ts useRoute is a thin wrapper around it.
- The router listens to BOTH popstate and hashchange and reads the live history.state and location.hash. When the query (?root=) differs, Chrome fires only popstate. reconcile() de-duplicates the event pair: an event at the same pos with the same hash is "same" and is ignored.
- A vetoed move starts a Walk {target: cur}, and its go() is undone by distance. The walk ends when it lands on target. Other landings re-arm a SETTLE_MS (250 ms) timer. settleWalk() then corrects from where the history actually stands, at most WALK_TRIES (3) times, and then gives up: it re-stamps the landed entry with the shown URL. history.go(0) is never called; a zero-distance veto rewrites the URL in place. Nothing like the old `reverting` boolean is left to get stuck.
- api.ts setRoot must keep history.state (replaceState(history.state, ...)), because each entry's {pos} stamp lives there.
- Known gap, outside router scope: Back/Forward across a project switch lands on entries whose ?root= names the old project, while App keeps the new root. app.tsx would need to re-read ?root= on popstate.
