---
name: workflow/always-commit-eminiar-files
kind: preference
tags: [git, workflow, memories]
related: []
created: 2026-11-05T18:39:18.551Z
updated: 2026-11-05T18:39:18.551Z
---

Always commit eminiar's own files (everything under .eminiar/: memories, todos, swarm run memories, docs.json, swarm.yaml) together with the work they came from. Never leave .eminiar/ changes untracked or unstaged; include them in the branch/PR of the change that produced them. Save every memory and todo that eminiar or a swarm run produces.
Why: user instruction 2026-11-05 — eminiar memories are git-shareable project knowledge and must not be lost between sessions/machines.
How to apply: before every commit run git status, stage .eminiar/ alongside code changes; if a run produced memories on another branch, commit them on the branch that did the work.
