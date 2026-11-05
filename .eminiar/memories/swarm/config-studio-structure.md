---
name: swarm/config-studio-structure
kind: decision
tags: [swarm, dashboard, ui, config-studio]
related: [file:src/ui/web/views/SwarmConfig.tsx, file:src/ui/web/swarm/config/draft.ts, file:src/ui/web/swarm/config/fields.tsx, file:src/ui/web/router.ts, file:src/ui/web/views/Swarm.tsx, file:tests/unit/swarm-draft.test.ts]
created: 2026-11-05T17:03:40.104Z
updated: 2026-11-05T17:03:40.104Z
---

Swarm Configuration Studio (#/swarm/config?swarm=<n>&role=<r>&tab=settings), task #207, swarm run 20261105-12d798, 2026-11-05, branch feature/swarm-config-ui.

Structure:
- src/ui/web/views/SwarmConfig.tsx is the view. Swarm.tsx mounts it as <SwarmConfig o params onChanged={ov.reload}/>.
- src/ui/web/swarm/config/ holds the parts:
  - draft.ts: pure, tested in tests/unit/swarm-draft.test.ts
  - fields.tsx: ModelPolicyControl, RangeBar, ModelSelect, ContextEditor
  - RoleCard, RoleDrawer (with NameInput and CountedText), SwarmEditor, TopologyPicker (MiniTopology), TemplateGallery, SettingsPanel, YamlPane (with IssueList)
- CSS lives in the "swc-*" section, just before the adjudicator section.

The draft:
- It is the structured SwarmDoc plus `renames`. Raw mode holds the YAML text instead.
- Every change is re-validated through POST /config/validate after 350 ms. A sequence ref drops stale replies.
- dirty means: !docEqual(draft, base), or there are renames, or there is no file yet.

Model policy, per role:
- pin: `model_range: {}` when defaults has a range, otherwise no model_range
- range: the role's own floor and ceiling
- default: no model_range, so the role inherits defaults.model_range
- The client mirrors roleRange's rule (the fallback must lie inside the range) in rangeProblem.

Renames:
- A rename is recorded only when the old name exists in the file (after the earlier renames) and the new name is free there. Otherwise the server just writes the difference.
- "Keep mine" after a 409 refetches the config, rebases onto the new hash and drops the renames.

Constraints learned:
1. The unsaved-changes guard has to go through router.ts setLeaveGuard(). useRoute's hashchange listener asks the guard before it calls setRoute.
   - A view's own window hashchange listener does not work, even with capture: the router's listener runs, Preact re-renders in a microtask between listeners, and the view unmounts. Its listener is removed before it is reached.
   - A synthetic dispatchEvent test hides this bug, because script dispatch does not flush microtasks between listeners.
2. The web bundle imports only types from src/swarm (doc-types.ts). draft.ts must not import ../../api.ts or preact.
3. The first structural edit re-serialises the file (yaml lib). Comment text survives, but trailing-comment alignment is normalised and a key's trailing comment can move onto its own line. This is expected per design.plan-2.
4. Test the studio against a scratch copy of .eminiar/swarm.yaml. Serve it with `serve({port, root: <scratch>})` from src/ui/server.ts via tsx, and never against the real file.
