---
name: jev/decision-job-script-trust
kind: constraint
tags: []
related: [file:src/decisions/job.ts, file:src/decisions/features/swarm.ts, file:src/version.ts, file:tests/unit/decisions-script-trust.test.ts]
created: 2026-11-05T23:24:47.520Z
updated: 2026-11-05T23:24:47.520Z
---

A detached decision job (`em-hook --decision`) only ever runs the running installation's own hook.js (task #324, review round 2 N4, swarm run 20261105-d18b04, 2026-11-06, branch feature/jev-integrations). A cloned repo's .claude/settings.json `env` block can set EMINIAR_PLUGIN_ROOT (and EMINIAR_HOME), so neither that variable nor process.argv[1] may choose the spawned script.

Rules (src/decisions/job.ts):
(1) trustedHookScript(moduleUrl = import.meta.url) = realpath of the module's own directory + "hook.js"; it must be a regular file (a symlinked hook.js is refused). The bundle is flat (server.js, cli.js, hook.js and hook-*.js chunks all sit in dist/), so this works from the server and the hook alike; from src/ there is no hook.js, so nothing spawns.
(2) spawnDecisionJob takes no `script` dep; DecisionSpawnDeps has `moduleUrl` (tests point it at a fixture dir with server.js + hook.js) and `cwd`.
(3) isHookScript(script, {moduleUrl, projectRoot, cwd}) requires an absolute, already-canonical path equal to trustedHookScript() (relative paths, symlinks even to the real hook, other hook.js files refused), and refuses one under the project root or cwd unless the running module also lives there (Claude Code started in $HOME, or eminiar developed in place).
(4) The swarm judge (decisions/features/swarm.ts) calls spawnDecisionJob(job) with no options; it does not import version.ts pluginRoot.
Still env-derived elsewhere (not changed, reported): version.ts pluginRoot() is used by cli.ts `hook` (spawns <root>/dist/hook.js), install/materialize.ts (packs <root> into the stable install), ui/server.ts (serves <root>/dist/ui), graph/languages/parser.ts (loads <root>/vendor/grammars/*.wasm); bin/_resolve.sh trusts $EMINIAR_HOME/root-path; adjudicator/async.ts spawnAsyncJob uses process.argv[1] with no check.
