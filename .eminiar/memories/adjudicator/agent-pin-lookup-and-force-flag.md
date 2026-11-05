---
name: adjudicator/agent-pin-lookup-and-force-flag
kind: decision
tags: []
related: [file:src/adjudicator/agent-pin.ts, file:src/adjudicator/env.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/swarm.ts]
created: 2026-11-04T12:47:47.413Z
updated: 2026-11-04T13:00:31.575Z
---

Adjudicator apply mode: agent model pins and the FORCE flag (tasks #42/#43, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator).
src/adjudicator/agent-pin.ts resolveAgentPin(type, {root, cwd, env, managedDir?}) finds an agent's definition in Claude Code's order:
1. managed <dir>/.claude/agents
2. project .claude/agents dirs from the cwd up to the repo root, closest first
3. user HOME/.claude/agents
4. built-ins: general-purpose, Explore and Plan have no pin; statusline-setup is sonnet, claude-code-guide is haiku
These directories are scanned recursively and matched on the frontmatter `name` only; the file name doesn't count.
Plugin agents (`plugin:agent`, `plugin:sub:agent`): install paths come from <CLAUDE_CODE_PLUGIN_CACHE_DIR or ~/.claude/plugins>/installed_plugins.json plus CLAUDE_CODE_PLUGIN_DIRS. The agents directory is the default agents/, or the manifest's `agents` key, which replaces it.
The result is pinned, unpinned or unknown. It is unknown when no file is found, the name is malformed, copies or same-name files disagree, a scan hits its limits, or a bare name isn't found (a --agents session agent cannot be seen from a hook).
Rule: with apply.respectFrontmatter on, an UNKNOWN pin is never overridden. The action is `advised`, no inline provider call is made, the note says "not applied: the agent's model pin is unknown", and the lookup is stored in the row's scores JSON under `pin`.
CLAUDE_CODE_SUBAGENT_MODEL_FORCE is read only through src/adjudicator/env.ts subagentModelForced (envFlagOn). It follows Claude Code's on/off rule: 1/true/yes/on in any casing are on; everything else (0/false/no/off, empty, unknown values) is off.
swarm.ts modelForced delegates to it. cli.ts status/doctor delegate to it too (task #59).
