---
name: swarm/config-studio-design
kind: decision
status: proposed
tags: [swarm, dashboard, ui, config]
related: [file:src/ui/swarm-api.ts, file:src/swarm/config.ts, file:src/ui/web/views/Swarm.tsx, file:src/ui/web/router.ts, file:src/ui/web/public/styles.css, file:src/ui/web/views/Overview.tsx]
created: 2026-11-05T16:04:57.255Z
updated: 2026-11-05T16:04:57.255Z
---

Swarm config studio / run dashboard split. This is a proposal from task #202, swarm run 20261105-12d798, 2026-11-05, branch feature/swarm-config-ui. The full design is on the blackboard under design.plan, design.plan-2 and design.plan-3.

Routes:
- #/swarm stays the run dashboard; #/swarm?run=<id> links still work.
- #/swarm/config is the Configuration Studio. router.ts parses one sub-path segment into Route.sub, and view stays "swarm".

How the dashboard writes .eminiar/swarm.yaml:
- The client edits a snake_case SwarmDoc draft. Its types are in src/swarm/doc-types.ts and mirror config.ts RawFile, enforced by a compile-time assertion.
- src/swarm/edit.ts renderSwarmDoc applies the old→new difference to the parsed yaml Document. Untouched nodes and edited scalars keep their comments and block style; renames change the key scalar.
- Validation is the existing parseSwarmYaml on the rendered text. There is no second schema.
- Render also requires enforceIntent(text) to equal the parsed enforce, because bin/em-hook greps that line.
- Paths under aliases or merge keys, x-* keys and role hooks are locked: read-only in the form, editable in raw YAML mode.
- An unchanged doc returns the base text byte-identical.

Write path (src/swarm/save.ts):
- The target is always swarmFile(root), never a path from the client.
- Project-contained, with no symlinks; the logic is copied from docs/manifest.ts locationProblem.
- A sha256 baseHash check returns 409 with the current text. A null baseHash means create (wx).
- The write goes to a temp file renamed over the original.

Endpoints in src/ui/swarm-api.ts:
- GET /api/swarm/config
- POST /api/swarm/config/validate
- POST /api/swarm/config/save (optional sync)
- GET /api/swarm/templates

Adding, deleting, duplicating and renaming swarms or roles are draft operations sent through save: one write path.

Constraints:
- The new swarm modules must never be imported by config.ts or any hook, so hook latency is unchanged.
- Design-system tokens and ds-* components live in styles.css, in all three theme blocks. The Preact primitives are in src/ui/web/ds.tsx.
