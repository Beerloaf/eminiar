---
name: adjudicator/cli-install-onboarding
kind: decision
tags: []
related: [file:src/adjudicator/cli.ts, file:src/cli.ts, file:src/install/install.ts, file:src/install/doctor.ts, file:src/doctor.ts, file:skills/em-onboard/SKILL.md, file:skills/em-doctor/SKILL.md, file:tests/unit/adjudicator-cli.test.ts]
created: 2026-11-04T11:31:38.372Z
updated: 2026-11-04T11:31:38.372Z
---

Adjudicator CLI, install and onboarding (branch feature/adjudicator, swarm run 20261104-483f39, task T11/#16, 2026-11-04):
- `eminiar adjudicator` lives in src/adjudicator/cli.ts (lazy from src/cli.ts): status/enable/disable/provider/key/test/eval/stats. Config writes go through writeAdjudicatorPatch (adjudicator section only; null deletes; validated). `enable --project` writes ONLY adjudicator.enabled to eminiar.config.json; provider, keys and consent stay personal in ~/.eminiar/config.json and ~/.eminiar/adjudicator.key.
- Keys never come from argv: hidden raw-mode prompt on a TTY, else stdin; `key set --from-env NAME` stores only the env var name (keyEnv). `key set <provider> <extra>` exits 2.
- Remote consent: the exact notice "The text of your prompts and subagent tasks (redacted, at most <maxChars> chars) is sent to <host> to score them." then y/N on a TTY, or --accept-remote; no TTY without it refuses; --yes never grants it. Declining during install falls back to the heuristic; declining `enable`/`provider` changes nothing (exit 1).
- The user asked that onboarding ask "Use the adjudicator for tool, model and agent selection?" (default No). Both `eminiar install` (setupAdjudicator; skipped under --yes, by upgrade, and once ~/.eminiar/config.json has adjudicator.enabled) and skills/em-onboard/SKILL.md ask it; the skill never takes keys in chat and points the user to `eminiar adjudicator key set` in their own terminal.
- install no longer freezes the adjudicator defaults into a fresh ~/.eminiar/config.json (frozenDefaults()).
- `test` makes one provider call and replays it into the blend (no double charge), persists nothing.
- Doctor: runDoctor(opts) appends adjudicatorDoctorChecks (no network); fullDoctor adds a 2 s live probe.
