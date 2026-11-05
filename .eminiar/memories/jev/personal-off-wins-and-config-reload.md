---
name: jev/personal-off-wins-and-config-reload
kind: decision
tags: [adjudicator, privacy, consent, config]
related: [file:src/config.ts, file:src/context.ts, file:src/decisions/config.ts, file:tests/unit/decisions-config-wave4.test.ts]
created: 2026-11-05T22:58:40.825Z
updated: 2026-11-05T22:58:40.825Z
---

Config precedence and live reload (tasks #307, #313, swarm run 20261105-d18b04, 2026-11-06, branch feature/jev-integrations).

(1) A personal "off" wins for anything that sends text (#313, review F9). src/config.ts withPersonalVetoes() runs after defaults < ~/.eminiar/config.json < <root>/eminiar.config.json < EMINIAR_* env are merged: personal adjudicator.enabled:false beats a project enabled:true AND EMINIAR_ADJUDICATOR=1 (a repo's .claude/settings.json env block reaches the session); personal surfaces.<x>:false beats project true; personal promptMode "heuristic" beats project async/blocking; a project minPromptChars below the personal one is raised to it. A silent personal file still lets a project turn the adjudicator on (team switch), and project false / env =0 can still turn it off. Other project keys (mode, tiers, weights, apply, advice, embedding, learning, cache) send nothing. Follow-up: cli.ts enabledSource() still reports env > project > global and `enable --project` cannot override a personal false.

(2) Long-lived processes reload the config when it changes (#307, review F3). getContext() (src/context.ts) memoises per root with configSourceSignature(root) from src/config.ts: inode/size/mtime/ctime of the personal and project config files (two statSync) plus the EMINIAR_* env vars envOverrides reads. On a change it reloads `ctx.config` IN PLACE (same ctx object), so the MCP server and dashboard honour `features off`, a removed featureConsent/remoteConsent or a personal enabled:false on the next tool call. decisionFeatureActive's memo is keyed per config object plus the env kill switches (EMINIAR_ADJUDICATOR, _FEATURES, _REMOTE). The tool list (em_adjudicate) is still fixed at server start (startConfig in server.ts). New env vars read by envOverrides must be added to CONFIG_ENV.

(3) parseConfig uses a lean adjudicator schema (no features schema) when the section has no `features` key and fills featureDefaults() in the full schema's key order (features before featureConsent); tests/unit/decisions-config-wave4.test.ts pins JSON equality with ConfigSchema.parse.
