---
name: jev/provider-pin-env
kind: decision
tags: [adjudicator, jev, privacy, consent, env]
related: [file:src/config.ts, file:src/adjudicator/config.ts, file:tests/unit/decisions-provider-pin-round3.test.ts]
created: 2026-11-06T00:21:42.117Z
updated: 2026-11-06T00:21:42.117Z
---

The env may not re-aim the adjudicator at another origin (task #348, round-3 privacy F6, swarm run 20261105-d18b04, 2026-11-06, branch feature/jev-integrations). Threat: a cloned repo's .claude/settings.json `env` block sets EMINIAR_ADJUDICATOR_PROVIDER; a user who once consented to groq (remoteConsentOrigins + featureConsent diffs@groq are never pruned) and went back to provider "heuristic" would have staged diffs sent to groq on the repo's say-so. Rule (src/config.ts envOverrides(personal), comment above it): EMINIAR_ADJUDICATOR_PROVIDER is honoured as is only when it equals the personal file's own provider (default "heuristic" when the personal file names none) or is a provider that never sends text (heuristic, embedding). Any other env choice still applies (status shows it) but sets remoteConsent=false, so a remote target degrades to the heuristic with no_consent and a loopback target still runs locally. Since the project layer can never set provider/openai/typesafe/baseUrl (PROJECT_ADJUDICATOR_KEYS), the origin a remote call can reach is always the one the personal file's provider section names; consent entries for other origins are inert. Consequence: for remote use the personal file must NAME the provider; tests that grant consent and pick the provider only via env must add provider to the personal config. Tests: tests/unit/decisions-provider-pin-round3.test.ts. The #48 control in tests/unit/adjudicator-hooks.test.ts (~line 2013) needed provider:"openai-compatible" in its personal object.
