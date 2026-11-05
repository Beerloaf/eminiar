---
name: adjudicator/harness-envelopes-not-prompts
kind: decision
tags: [adjudicator, hooks, claude-code]
related: [file:src/adjudicator/hooks.ts, file:src/hooks/capture.ts]
created: 2026-11-04T15:52:54.660Z
updated: 2026-11-04T15:52:54.660Z
---

The adjudicator does not score harness envelopes as user prompts (task #95, swarm run 20261104-672098, 2026-11-04, branch feature/adjudicator). Claude Code fires UserPromptSubmit for turns no user typed. Decision rows 23 and 24 (and row 1 of another project) were subagent hand-backs, input `<agent-message from="a…"> [Subagent hand-back] …`, which the heuristic scored at complexity 1.75 (risk +0.80 from the wrapper's wording) and answered with an advice line. Transcripts show task notifications as turns that begin `<task-notification>\n<task-id>…`; harness context begins `<system-reminder>` or `<system-reminder id="…">`.

src/adjudicator/hooks.ts exports `isHarnessEnvelope(text: unknown)`, which is `/^\s*<(?:agent-message|task-notification|system-reminder)[\s>]/`: case-sensitive, a prefix match after leading whitespace only, and false for non-strings. A real prompt that mentions a tag mid-text is still scored. onPrompt returns undefined on a match before the short/slash/chat skip branch: no row, no advice, no main-session cooldown tick, and no closeToolHint. A hand-back arrives while the user's prompt is still in progress, so that prompt keeps its row, its em_* tool hint and its cooldown.

Not covered: src/hooks/capture.ts userPromptSubmit still writes sessions.last_prompt, persists classifyPrompt events and runs proactive recall for these turns. If those paths should skip envelopes too, the matcher has to move to a module that src/hooks/* may import statically. build/hook-code-splitting allows src/hooks/* to reach src/adjudicator/* only through dynamic import().
