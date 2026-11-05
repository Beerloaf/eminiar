---
name: adjudicator/reminder-prefixed-prompts
kind: decision
tags: []
related: [file:src/adjudicator/hooks.ts, file:tests/unit/adjudicator-hooks.test.ts]
created: 2026-11-05T08:40:36.119Z
updated: 2026-11-05T08:40:36.119Z
---

Adjudicator: a UserPromptSubmit prompt that starts with closed <system-reminder>…</system-reminder> blocks followed by typed text is scored on the typed text (task #122, review #98 F9, swarm run 20261104-672098, 2026-11-05, branch feature/adjudicator). Evidence: Claude Code really delivers this shape. A captured sessions.last_prompt (clipped input.prompt) in a worktree session was "<system-reminder>\nYou are operating in a git worktree.…</system-reminder>\n\n<typed ask>". src/adjudicator/hooks.ts stripLeadingReminders() removes the leading closed reminder blocks. isHarnessEnvelope() is true only when nothing is left after stripping, when another envelope (agent-message / task-notification / an unclosed system-reminder) follows, or for a leading agent-message / task-notification (those are still whole-text skips). onPrompt scores the stripped text, so minPromptChars, slash and chat skips apply to the typed text: a short "yes" after a reminder is the user's turn and ends the tool hint. It still fails open: non-strings and mid-text tags are not envelopes. Open: local transcripts have 28 main-thread turns of the form reminder + <ci-monitor-event>…. Before #122 they were skipped by accident; now they are scored, the same as the 302 turns that start with <ci-monitor-event> and were already scored. Adding ci-monitor-event to HARNESS_ENVELOPE would be a separate decision.
