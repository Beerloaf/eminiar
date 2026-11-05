---
name: adjudicator/hooks-off-test
kind: note
tags: [adjudicator, hooks, tests]
related: [file:tests/unit/adjudicator-hooks-off.test.ts, file:tests/unit/adjudicator-hooks.test.ts, file:src/adjudicator/hooks.ts, file:src/hooks/routing.ts, file:src/hooks/capture.ts, file:src/hooks/session-start.ts]
created: 2026-11-05T09:57:18.030Z
updated: 2026-11-05T09:57:18.030Z
---

Adjudicator "off costs nothing" test (task #135, swarm run 20261104-672098, branch feature/adjudicator, 2026-11-05). tests/unit/adjudicator-hooks-off.test.ts (21 tests, about 0.4 s) restores the strict guarantee that a disabled adjudicator never imports src/adjudicator/hooks.ts, which tests/unit/adjudicator-hooks.test.ts could no longer prove after #132 made it order-independent (one shared module registry).

Mechanism (vitest 5.0.4, verified in node_modules/vitest/dist/chunks/utils.*.js and by experiment): vi.resetModules() skips the registry's `mock:` entries, so the result a vi.mock factory already returned survives it and the factory runs once per FILE. Re-registering the mock with vi.doMock is what discards the cached result. So boot() does vi.resetModules(), then vi.doMock(hooks.ts stand-in), then imports src/hooks/index.js, giving every test a registry nobody has used. With the mock registered once, the 5 call-out controls fail after the first one: that is the proof the per-boot doMock is needed.

The stand-in (a Proxy over spies for onPrompt, afterRouting, onPreAgent, onPreTool, onPostAgent, onSessionStart, onSessionEnd) records three things per hook step: when its factory ran (the module was imported), which export was read (a call-out was reached) and which function was called. Failures list every offending site in one object.

Cases: 5 ways of being off (never configured; enabled:false in the personal config; fully configured then switched off; the project file opts out of a personal opt-in; EMINIAR_ADJUDICATOR=0 over a personal opt-in), each driving a whole session (all 10 events in src/hooks/index.ts, plus a bare-payload sweep of any event added later) and asserting the factory never ran, no export was read, all four adjudicator tables and the `adjudicator:%` meta keys stay empty, and routing's output carries no model, effort or advice. Controls (adjudicator on, stand-in): each of the 6 call-out steps (SessionStart, UserPromptSubmit, PreToolUse Agent and Bash, PostToolUse Agent, SessionEnd) imports the module exactly once and reaches exactly its export, so the off tests cannot pass by the probe being blind; a fresh registry imports it again. Also: enabled but hooks.ts throws on import, every hook still answers (fail-open); the Cursor client never loads it even when enabled; no other src/adjudicator module is imported while off (a disabled session evaluates only types.ts of the 27 modules, which src/config.ts imports for MODES, PROVIDER_IDS and TIERS).

Mutation check (scratch copy of src, 20 mutants, all killed): dropping each of the five `enabled` guards, dropping each of the five Cursor guards, removing each try/catch around the import, a static import of hooks.ts or of adjudicator/env.ts in routing.ts, a lazy engine.ts import in Stop, an unguarded hooks.ts import in Stop and in PreCompact. Passes under --sequence.shuffle for seeds 1 to 40 and with --no-isolate. Not covered: src/hook.ts (its top-level main() reads stdin, so it cannot be imported in a test) and the bundled dist output.

Keep when changing hooks: a new call-out site must keep the `enabled && client !== "cursor"` guard and import hooks.ts lazily; the stand-in must export whatever the site destructures, or the control for that site fails.
