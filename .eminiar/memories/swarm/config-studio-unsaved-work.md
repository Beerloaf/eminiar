---
name: swarm/config-studio-unsaved-work
kind: constraint
tags: [swarm, dashboard, ui, config-studio, review]
related: [file:src/ui/web/views/SwarmConfig.tsx, file:src/ui/web/router.ts, file:src/ui/web/app.tsx, file:src/ui/web/swarm/config/draft.ts]
created: 2026-11-05T17:26:47.218Z
updated: 2026-11-05T18:12:39.356Z
---

Configuration Studio unsaved-work rules. Source: Review B, task #213, swarm run 20261105-12d798, 2026-11-05, branch feature/swarm-config-ui. Every rule here was found by reproducing draft loss in a browser.

1. The leave guard (router.ts setLeaveGuard) only runs on hashchange. Any other path that unmounts SwarmConfig must ask the guard first. Known cases:
   - the header project switch: app.tsx changeRoot → `<main key={root}>`
   - "Reload from disk" while the draft is dirty
2. In raw mode, `dirty` must count the visual draft that is still kept in state. Otherwise switching to Raw YAML hides the unsaved visual edits from the guard.
3. Raw YAML must not open a stale render. result.text lags the draft:
   - while validation is pending (350 ms debounce plus the request)
   - after a 422
   - during a 409
4. The form must not take edits while a save is in flight: save() ends with load(), which replaces the draft.
5. A vetoed hashchange must not rewrite the history entry it landed on with replaceState(oldURL). That loses the Back entry. Undo the move with history.go(delta) instead.
Implemented (tasks #219/#220, 2026-11-05): rules 2–4 and the Reload-from-disk confirm are in SwarmConfig.tsx. Check records `of` (the body each settled check was for) and `good` (the visual draft its result rendered from); draft.ts studioDirty()/rawEntry() decide dirty and what Raw YAML may open (stale → confirm). While saving, the layout, raw wrap and drawers are `inert`. After a 422 the banner offers "Undo the last change" (back to `good`); during a 409/422 the YAML preview is dimmed with a reason (YamlPane `stale` prop) and the diff count hidden. A 409 for a removed file also offers Keep mine (rebase onto no file, Save recreates it).
7. (#233/#234/#238, 2026-11-05) A save that fails in transport or with a 500 (failure kind "error") goes to the saveError state (a banner with Retry), never to check.failure: it says nothing about the draft, so it must not disable Save or show "cannot render". Only a 400/422 from save blocks. Focus is put back after a save, because inert drops it to body (the focusBack ref, restored in an effect on [saving]). A clean studio adopts the on-disk file on every overview poll, and a clean sync preflights GET /api/swarm/config, so the bar's sync label (from o) and the form never disagree. A dirty draft is never replaced silently.
6. A lock on a descendant path (an anchor that is aliased elsewhere) must also disable delete and rename of its ancestors. isLocked only looks upward.
