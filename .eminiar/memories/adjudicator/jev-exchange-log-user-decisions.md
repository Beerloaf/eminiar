---
name: adjudicator/jev-exchange-log-user-decisions
kind: decision
tags: []
related: []
created: 2026-11-05T13:39:36.034Z
updated: 2026-11-05T13:39:36.034Z
---

Jev exchange log decisions by the user (2026-11-05, run 20261105-1d96f4, branch feature/adjudicator): keep only the newest 100 captured Jev requests (named constant EXCHANGE_KEEP, not a setting); capture covers Jev (typesafe) only, not Groq/Cerebras/custom; NO file-permission changes anywhere (no chmod of the project db, WAL or directories), so docs must never claim 0600/0700 on the project database. Capture is opt-in via the personal-only setting adjudicator.privacy.captureExchanges (default false). The Jev impact panel shows only when the adjudicator is enabled and the provider is typesafe. **Why:** captured requests contain redacted prompt text and the docs used to promise prompts are never stored. **How to apply:** do not add chmod, do not widen capture to other providers, do not let a project file or env var enable it; related [[adjudicator/jev-exchange-log-design]] and [[adjudicator/jev-impact-design]].
