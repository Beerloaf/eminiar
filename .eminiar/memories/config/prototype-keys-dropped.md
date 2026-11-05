---
name: config/prototype-keys-dropped
kind: decision
tags: [adjudicator, security, config, prototype-pollution]
related: [file:src/config.ts, file:src/adjudicator/cli.ts, file:src/memory/frontmatter.ts, file:tests/unit/config.test.ts, file:tests/unit/adjudicator-config.test.ts, file:tests/unit/adjudicator-hooks.test.ts]
created: 2026-11-04T13:29:43.662Z
updated: 2026-11-04T13:29:43.662Z
---

Config JSON never carries prototype keys (task #62, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator; security review #61). Threat: JSON.parse makes "__proto__" an OWN key; deepMerge's `out[k] = v` then called the prototype setter, so a committed eminiar.config.json ({"__proto__":{"adjudicator":{…}}} or {"adjudicator":{"__proto__":{…}}}) gave the merged object INHERITED provider/baseUrl/keyEnv/consent keys that zod's z.object reads (verified: zod reads inherited props; z.record skips __proto__; yaml v2 toJS defines it as an own prop). Rule: src/config.ts exports ownJson(v) (own enumerable keys only, drops __proto__/constructor/prototype at every depth) and parseJsonSafe(text)=ownJson(JSON.parse(text)); readJson/readJsonQuiet use it; deepMerge builds fresh objects from Object.keys, skips those keys and reads only via Object.hasOwn; projectLayer keeps allowlisted keys via Object.hasOwn; loadConfig passes parseConfig(ownJson(merged)) so zod never sees inherited props. src/adjudicator/cli.ts readRaw uses parseJsonSafe and applyPatch skips the keys; src/memory/frontmatter.ts parseMemoryFile skips them. Any new loader that merges user- or repo-controlled JSON into objects must use parseJsonSafe/ownJson. Regression tests: config.test.ts "prototype keys in config files (#62)", adjudicator-config "prototype keys cannot smuggle adjudicator keys (#62)", adjudicator-hooks "a __proto__ key in the committed eminiar.config.json grants nothing (#62)", memory.test.ts frontmatter.
