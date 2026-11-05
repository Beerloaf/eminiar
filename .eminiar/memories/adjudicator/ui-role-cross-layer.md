---
name: adjudicator/ui-role-cross-layer
kind: decision
tags: [adjudicator, heuristic, routing, role, ui]
related: [file:src/adjudicator/features.ts, file:src/adjudicator/heuristic.ts]
created: 2026-11-05T07:35:08.053Z
updated: 2026-11-05T07:35:08.053Z
---

Adjudicator ui role is for UI-only work (swarm run 20261104-672098, task #111, branch feature/adjudicator, 2026-11-05). This fixes F6 from task #94. Under #94, any bounded implement/edit request that named a UI noun went to the ui role, including backend or cross-layer work: "add an api endpoint for the dashboard stats", "add OAuth PKCE login to the dashboard", "wire the flag through the server, CLI and dashboard".

Rule:
- features.ts sets FeatureExtras.otherLayer = OTHER_LAYER || uiAmongAreas.
- OTHER_LAYER is a set of non-UI layer nouns:
  - api, endpoint, server, backend
  - cli, command line, a --flag
  - hook, except a Preact "custom hook" or "useX hook"
  - database, db, sqlite, sql
  - storage, except local or session storage
  - mcp, websocket
  - login, "log in to/with/as", sign in
  - auth, authn, authz, authentication, authorization (not "author")
- uiAmongAreas is a 3-item list (ENUM3's shape, last item up to two words) mixing items that name a UI part with items that do not, as in "the scorer, the engine and the dashboard view". A list made only of UI parts ("the sidebar, the header and the footer") stays UI.
- heuristic.scoreRole:
  - bounded = no refactor and scope < 1.
  - crossLayer = bounded and (risk > 0 or otherLayer).
  - The implement/edit_small → ui redirect (uiWork) needs bounded and not crossLayer.
  - Under crossLayer, the ui intent's own ROLE_MAP vote also goes to coder. Without this, ui-only-intent requests like "pass the session id from the hook to the dashboard" stayed ui.
  - Broad or refactor work is deliberately untouched. Redirecting the ui vote there flipped exemplars#40 (c=4 "replace the custom auth layer with OAuth across the server, CLI and dashboard") from architect to coder.
- A plain Features without otherLayer behaves as before.

F7 is fixed in the same task by a lookbehind on SELECTOR. A failing/failed participle after "cause/reason/source/origin (of|for) (the)" is the symptom (debug), not a selector. "the list of failing tests" stays a selector.

Validation:
- The fixture eval dump is byte-identical to #94 on built-in, held-out, held-out-2, exemplars and sim-13.
- Fresh paraphrase set: 67/71 (#94: 34/71).
- Blind set: 35/39 with the rule frozen (#94: 21/39), 37/39 after two vocabulary fixes.
- The 1357-string sweep changed only 3 roles, all ui → coder.
- p95 is about 0.04 ms.

Known limits:
- A backend noun that is only read ("show api errors in a toast") sends UI work to coder. That is the safe side.
- React "convert … to hooks" counts as a hook layer.
- RISK's auth\w* still matches "author".
- Evidence is on blackboard f6-eval. Unit tests are follow-up #113.
