---
name: adjudicator/pkg-kebab-libraries-hint
kind: decision
tags: [adjudicator, heuristic, docs]
related: [file:src/adjudicator/features.ts, file:src/adjudicator/hooks.ts, file:tests/unit/adjudicator-sim-regression.test.ts]
created: 2026-11-05T08:36:07.697Z
updated: 2026-11-05T08:36:07.697Z
---

Adjudicator PKG docs rule: a kebab-case name counts as a package only when it is a known library (swarm run 20261104-672098, task #118, review #98 F3, branch feature/adjudicator, 2026-11-05).
- Problem: PKG's hyphen form took project names ("how does agent-pin pick the model", "plan-advice", "tool-hint", "mcp-server") for third-party packages, so these went to em_docs/researcher.
- Fix: features.ts has FeatureHints = AdjudicationRequest hints plus `libraries?: readonly string[]` (lower case).
  - The two docs PKG lexemes capture the name (Lexeme.pkg).
  - extractIntents(text, libraries) skips a match when isPackageName(name, libraries) is false.
  - isPackageName: the @scope/, node:, dotted and digit forms always count. A hyphen-only name counts only when it is listed, or when there is no list (undefined). An empty list means no kebab name is a package.
- hooks.ts docsLibraries(ctx) reads the em_docs manifest (readManifestAt(manifestPath(ctx))). It returns the source names plus the npm/pypi/go/crate package from `provider`. It returns undefined when the manifest has no sources, so the lexical rule stands.
  - It is called only for a prompt or Agent request that gets scored, after the active/surface/skip gates. There is no memo, because a hook process handles one event.
  - It is passed as req.hints.libraries on the prompt and agent surfaces.
- FETCH deliberately keeps the full PKG pattern: fetching is how a library joins the list, so "fetch tree-sitter" stays a fetch when tree-sitter is unlisted.
- Eval (heur/eval.mts, which passes no hint) is unchanged: builtin tool 33/40 role 35/40, heldout tool 39/60 role 42/60, heldout2 tool 33/60 role 39/60, sim tool 13/13 role 11/13. With the repo's library hint the counts are identical.
- Open (task #125): type `libraries` in types.ts; add it to cacheKeyFor (engine.ts); add a hooks wiring test.
