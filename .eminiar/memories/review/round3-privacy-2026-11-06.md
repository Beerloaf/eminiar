---
name: review/round3-privacy-2026-11-06
kind: note
tags: []
related: []
created: 2026-11-05T23:56:05.282Z
updated: 2026-11-05T23:56:05.282Z
---

Round 3 privacy review of feature/jev-integrations at 319a06d (task #334, swarm run 20261105-d18b04, 2026-11-06). Round-2 N1-N6 and F7/N8 closed. N7 (docs public names) partly closed; F2 left. Fix tasks #343-#349 were planned from the new findings.

Lessons for later reviews:
- Any text transform that runs BEFORE the client's redact() can defeat it. readablePaths() in compaction.ts shortens long tokens containing '/' and drops 'scheme://', so a DSN's user:pass@host is no longer recognised. Redact first, then shorten.
- redact() has no rule for scheme-less user:pass@host.
- Name-based scrubs (isSecretName, diff-redact ASSIGN) miss plural names (tokens, passwords, api_keys), subscripts, typed or modified declarations, ?=/||=/??=, sigil keys ($, @) and space-separated forms (Dockerfile ENV K v, SQL PASSWORD 'x', PHP define()).
- mergedCatalog() merges the team's own docs.catalog, so 'catalog' confidence does not mean a well-known public package.
- EMINIAR_ADJUDICATOR_PROVIDER from a repo's env block can re-aim at any origin the personal file ever consented to; featureConsent entries are never pruned.
- Parallel reviewers share the scratchpad and one of them rm -rf'd p3/. Use a private subdirectory name.
