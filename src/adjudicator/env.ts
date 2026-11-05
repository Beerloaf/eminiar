/**
 * Claude Code environment flags the adjudicator must read exactly as Claude Code does, so the
 * hook, the plan advice and the CLI agree on them.
 */

/**
 * Claude Code's on/off rule (code.claude.com/docs/en/env-vars, "Variables"): `1`, `true`, `yes`
 * or `on` in any casing turn a behaviour on; `0`, `false`, `no`, `off`, an empty value or no
 * value leave it off. Values outside both lists are not documented and count as off, like
 * Claude Code's own truthy check.
 */
const ON = new Set(["1", "true", "yes", "on"]);

export function envFlagOn(value: string | undefined): boolean {
  return value !== undefined && ON.has(value.trim().toLowerCase());
}

/**
 * CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on: Claude Code ignores both the Agent call's `model` and
 * the agent file's `model`, so the adjudicator must not try to change a subagent's model.
 */
export function subagentModelForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE);
}
