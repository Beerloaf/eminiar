---
name: jev/project-enable-heuristic-only
kind: decision
tags: []
related: [file:src/config.ts, file:src/adjudicator/cli.ts, file:src/decisions/diff-redact.ts, file:docs/adjudicator.md, file:docs/configuration.md]
created: 2026-11-05T23:29:50.198Z
updated: 2026-11-05T23:29:50.198Z
---

Project config never alone makes a provider run (task #326, review-features-privacy-2 N6, swarm run 20261105-d18b04, 2026-11-06, branch feature/jev-integrations).

src/config.ts withPersonalVetoes():
- If ~/.eminiar/config.json does not itself say adjudicator.enabled: true, then a project eminiar.config.json `enabled: true` or EMINIAR_ADJUDICATOR=1 turns the adjudicator on with provider forced to "heuristic". So no prompt text goes out, and every decision feature reports "disabled" (status shows it as waiting).
- This holds even when the personal file already names a provider, keys, consent and features (a provider set without `enable`).
- An env-picked EMINIAR_ADJUDICATOR_PROVIDER does not get round it.
- A personal enabled:false still turns everything off.
- The env is treated like the project because a repo's .claude/settings.json env block reaches the session.

src/adjudicator/cli.ts enabledSource() appends "(local heuristic only: a provider runs once ~/.eminiar/config.json says enabled: true)" to the project/env source when this rule applies.

Tests that exercise env/project provider and consent mechanics must set a personal enabled: true:
- adjudicator-config #33
- adjudicator-hooks #48 and #62
- decisions-veto-round2.test.ts

Diff scrub companion decisions (tasks #321-#323), in src/decisions/diff-redact.ts:
- Typed continuation kinds: indent, quote incl. triple quotes, backslash, brackets, heredoc, next-line value.
- YAML/TOML/JSON hunks drop leading lines until a rooted line. This is the safe choice for -U0 hunks whose key lies outside the hunk.
- The SECRET_DIRS deny floor covers secret, credentials, creds, vault, private, keys, .docker, .gnupg and similar.
- COMMIT_EXCLUDE adds Helm values*.yaml.
