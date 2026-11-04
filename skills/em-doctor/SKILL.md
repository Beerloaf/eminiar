---
name: em-doctor
description: Diagnose the eminiar installation — node, SQLite FTS5, sqlite-vec, embedding model, sandbox languages, routing mode, context-mode coexistence, project root, and the opt-in adjudicator (provider, key, consent, health).
user-invocable: true
allowed-tools: mcp__plugin_eminiar_eminiar__em_doctor
---

Call `em_doctor` and show the checklist verbatim. For any failed check, suggest the fix in one
line (usually `npx eminiar install` or `eminiar doctor --fix` from a terminal).

When the adjudicator is on, the `adjudicator*` checks cover: the config is valid; the
configured provider is the one that runs (or why the heuristic runs instead: no key, no
consent, an API key rejected, misconfigured); the key is present and `~/.eminiar/adjudicator.key`
is mode 0600; consent for a remote provider; breaker state and p95 latency against the budget;
the last 24 h fallback rate; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set while mode is apply; and,
for the embedding provider, whether the exemplar vectors are cached. Fixes are
`eminiar adjudicator key set`, `eminiar adjudicator enable --accept-remote`, `chmod 600
~/.eminiar/adjudicator.key` or `eminiar adjudicator status`. `eminiar doctor` (terminal) also
probes the provider live with a 2 s timeout.
