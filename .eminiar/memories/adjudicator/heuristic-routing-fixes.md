---
name: adjudicator/heuristic-routing-fixes
kind: decision
status: proposed
tags: [adjudicator, heuristic, routing, eval]
related: [file:src/adjudicator/features.ts, file:src/adjudicator/heuristic.ts, file:src/adjudicator/types.ts, file:src/adjudicator/prompt.ts]
created: 2026-11-04T16:26:02.021Z
updated: 2026-11-05T07:35:08.516Z
---

Adjudicator heuristic routing fixes (swarm run 20261104-672098, task #93 design; implementation is task #94; branch feature/adjudicator, 2026-11-04). The full spec is on blackboard keys design-heuristic, design-heuristic-2 and design-heuristic-3.

Library detection: chosen option (a), text-only.
- Rejected (b), passing names from .eminiar/docs.json via FeatureExtras, because:
  - it adds file I/O to every short-lived UserPromptSubmit hook process, where nothing can be cached;
  - it needs plumbing through the engine, hooks, server, eval and the cache key;
  - verdicts would depend on project state.
- (a) has two parts:
  - a PKG token as the subject of "how does/do…" or "does X support…" questions. PKG matches @scope/name, node:mod, dotted or hyphenated names, or letters plus a digit; never a file extension; a gerund guard follows it.
  - explicit docs phrasing: "docs page", "read the X docs", "what do the docs say", "according to the docs".
- Known miss: plain-word libraries (zod, react) with no "docs" word.

Principles introduced:
- A phrase that covers the lead word consumes the lead.
- lookup gives way to docs and history in the tool table.
- Callers and usages of a symbol: the extras.refs flag sends them to em_symbols. Intents and complexity are unchanged. imports and "depends on" stay em_graph_impact.
- Git means doing git: phrases plus a lead-only verb list. Branch and commits as the subject of a question are history. A git verb with commits as its object stays git.
- "format" is edit_small only as an action.
- "plan" is the verb or a plan to produce, never a modifier or part of an identifier. The old weights are kept (lead 0.9, otherwise 0.63).
- "refactor X into a function/module" is an extraction, i.e. implement.
- "show X in <ui surface>" and "exclude X from <chart/view/report>" are implement.
- UI work confined to the UI (no refactor, scope < 1) goes to the ui role.
- extras.batch: run ≥ 0.9 plus "in parallel" or a 3-item enumeration, no writes, debug < 0.9 → em_batch_execute. That tool is added to TOOL_IDS and TOOL_DESCRIPTIONS.
- extras.fetch: a URL, a fetch verb, latest version or changelog sends docs to em_fetch_and_index.
- An attributive "the failing / every failed X" is a selector, not debug. This was needed because the format fix exposed a spurious debug intent on held-out-2.

Measured on the reference patch:
- No regression on built-in, held-out, held-out-2 or exemplars.
- Tool accuracy: built-in +2, held-out +3, held-out-2 +4. Role: held-out +3, held-out-2 +1.
- sim-13 tool accuracy goes from 5 to 13.
- 69 of 70 off-fixture paraphrase probes hold (baseline 36).
- All 772 adjudicator tests pass unchanged.

Not tuned on held-out data: two rules found by reading held-out misses were deliberately left out ("anything else call X", "how to use X"). Validate them on a fresh blind set.

Follow-ups that were noted but not done:
- Plan-surface task details with verification boilerplate push most tasks to cx 4 / effort max and flip coder tasks to tester.
- "write tests for X" goes to em_execute.
- "what did we decide" is over-tiered.

Implementation (task #94, 2026-11-05): the reference patch plus four regression fixes in features.ts. Each fix is fixture-neutral: the eval dump is byte-identical and the probe holds 69/70.
- PKG's file guard allows dots before the extension, (?![\w.-]*\.(ext)\b), so multi-dot files (vite.config.ts, index.d.ts) are never packages.
- "push" joins the "git verb + commits" phrase. Before, "push the last commit" tied em_history with Bash.
- "git X" fires only for real git subcommands; git as a noun ("git root", "git hooks") is not doing git. worktree is left out because it is mostly a noun here.
- The branch phrase allows one name word ("switch to the main branch") unless it is a control-flow word (if/else/error/catch/default/fallback/true/false/happy/dead/case).

Open follow-ups from the #94 review (blackboard heur-impl-deviations):
- Resolved in task #111 (memory adjudicator/ui-role-cross-layer): uiWork sent backend or cross-layer work that names a UI noun to the ui role ("add OAuth PKCE login to the dashboard").
- Resolved in task #111: SELECTOR masked "the cause of failing builds"; causes and reasons now keep debug.
- "what branch am I on" is no longer git.
