---
name: todo/em-hook-userpromptsubmit-timeout
kind: todo
tags: []
related: []
created: 2026-11-05T16:38:48.844Z
updated: 2026-11-05T16:38:48.844Z
---

TODO (user request 2026-11-05): after the swarm-config-ui batch (run 20261105-12d798, PR for feature/swarm-config-ui) is done, fix on a SEPARATE branch (off main, not stacked on feature/swarm-config-ui): the recurring error shown in the Claude Code UI when swarm workers (e.g. swarm-review-correctness) start: `UserPromptSubmit hook ["${CLAUDE_PLUGIN_ROOT}/bin/em-hook"] timed out after 5s — output discarded. Raise the hook's "timeout" to allow more time.` The user says it is happening more and more. Likely the em-hook UserPromptSubmit path (recall / adjudicator / swarm brief) exceeding the 5s hook timeout, probably under load from many parallel workers. Investigate the real latency (npm run bench, per-stage timing) and fix the cause (a hard internal budget so it fails open well under 5s) rather than only raising the timeout.
**Why:** hooks must fail open and stay within a hard budget (swarm project rules); output is discarded on timeout, so recall and brief context is silently lost.
**How to apply:** start the new branch only after the current PR is opened; reproduce with several concurrent subagents.
