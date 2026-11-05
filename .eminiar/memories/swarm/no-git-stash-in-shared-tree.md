---
name: swarm/no-git-stash-in-shared-tree
kind: constraint
tags: [swarm, git, workers]
related: [file:.eminiar/swarm.yaml]
created: 2026-11-05T10:34:51.934Z
updated: 2026-11-05T10:34:51.934Z
---

Swarm workers share one working tree with other workers' uncommitted edits. A worker must never use git stash / checkout / reset / restore (even path-limited) to test "without the fix": in run 20261104-672098 (#131) and 20261105-f530e8 (#148) workers stashed and popped src/adjudicator files while other coders were active; no work was lost only by luck of timing. Mutation-check in a scratch copy under the scratchpad instead (copy the file or src/ and run vitest with a probe config). Coordinators should repeat this in spawn prompts until swarm.yaml's project rules say it.
