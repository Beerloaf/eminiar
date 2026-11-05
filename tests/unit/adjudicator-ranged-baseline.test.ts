/**
 * Savings baseline of a ranged swarm agent with apply.respectFrontmatter off (task #131, review
 * #109 F3). Without the adjudicator Claude Code runs the agent file's `model:` line, the range's
 * fallback, whether or not the adjudicator respects the range, so the baseline is that pin as for
 * a plain pin: never CLAUDE_CODE_SUBAGENT_MODEL or the main session's model. Only the baseline
 * widens: with respectFrontmatter on the ranged path is unchanged, and FORCE keeps its baseline.
 * Tests stub the provider and take no env from the machine.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onPreAgent } from "../../src/adjudicator/hooks.js";
import { FALLBACK_PIN_FIELD, RANGED_FLAG } from "../../src/adjudicator/savings.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import { getContext } from "../../src/context.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { ApiCallInput } from "../../src/storage/types.js";
import { syncAgents } from "../../src/swarm/agents.js";
import { parseSwarmYaml } from "../../src/swarm/config.js";

const ENV_KEYS = [
  "EMINIAR_HOME",
  "HOME",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
];
const saved: Record<string, string | undefined> = {};
let home: string;

beforeAll(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-rbase-home-"));
  // User-level agents are read from HOME: keep the real ~/.claude out.
  home = mkdtempSync(join(tmpdir(), "em-rbase-user-"));
  process.env.HOME = home;
});
afterAll(() => {
  closeAllStorage();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The same coder frontmatter `model: sonnet`, with and without a range. */
const RANGED_YAML = `
version: 1
swarms:
  rb:
    description: ranged swarm
    agents:
      coder:
        description: writes code
        model: sonnet
        model_range: { floor: haiku, ceiling: opus }
`;
const PINNED_YAML = `
version: 1
swarms:
  rb:
    description: pinned swarm
    agents:
      coder:
        description: writes code
        model: sonnet
`;

const MAIN_MODEL = "claude-opus-5-5";

function project(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "em-rbase-proj-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".git"));
  const r = parseSwarmYaml(yaml, join(root, ".eminiar", "swarm.yaml"), ".eminiar/swarm.yaml");
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  syncAgents(root, r.config);
  return root;
}

function mainCall(sessionId: string): ApiCallInput {
  return {
    request_id: `r${Math.random()}`,
    message_id: `m${Math.random()}`,
    session_id: sessionId,
    agent_id: null,
    sidechain: 0,
    ts: Date.now() - 60_000,
    model: MAIN_MODEL,
    input_tokens: 1000,
    output_tokens: 500,
    cache_create_5m: 0,
    cache_create_1h: 0,
    cache_read: 0,
    thinking_tokens: 0,
    web_searches: 0,
    web_fetches: 0,
    service_tier: null,
    speed: null,
    stop_reason: null,
    prompt_id: null,
    git_branch: null,
    cwd: null,
    effort: null,
    version: null,
    entrypoint: null,
  };
}

/** One swarm dispatch of the coder with a haiku plan verdict, the main session on opus. */
async function dispatch(
  yaml: string,
  opts: { respectFrontmatter: boolean; env?: NodeJS.ProcessEnv },
) {
  const root = project(yaml);
  const ctx = getContext(root);
  const adjudicator: Config["adjudicator"] = ConfigSchema.parse({
    adjudicator: {
      enabled: true,
      mode: "apply",
      apply: { scope: "swarm", minConfidence: 0.7, respectFrontmatter: opts.respectFrontmatter },
    },
  }).adjudicator;
  ctx.config = { ...ctx.config, adjudicator };
  const db = getStorage(ctx, { vectors: false });
  const run = db.swarm.runCreate({
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    swarm: "rb",
    goal: "g",
    topology: "hierarchical",
  });
  const task = db.swarm.taskAdd({
    run_id: run.id,
    title: "Rename a variable",
    detail: "one file",
    role: "coder",
  });
  db.adjudicator.insert({
    surface: "plan",
    inputHash: "h",
    runId: run.id,
    taskId: task.id,
    tier: "haiku",
    confidence: 0.9,
    complexity: 1,
    effort: "low",
    role: "coder",
    scores: JSON.stringify({ role: { confidence: 0.9 } }),
  });
  const sid = `S-${run.id}`;
  db.apiCallsUpsert([mainCall(sid)]);
  const agentType = "swarm-rb-coder";
  const a = await onPreAgent(
    ctx,
    {
      session_id: sid,
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: agentType, prompt: `task #${task.id}` },
    },
    { kind: "worker", agentType, runId: run.id, taskId: task.id },
    { env: { HOME: home, ...opts.env }, provider: null },
  );
  if (!a?.rowId) throw new Error("no adjudication row");
  const row = db.adjudicator.get(a.rowId);
  if (!row) throw new Error("row not stored");
  return { a, row, sc: JSON.parse(row.scores ?? "{}") as Record<string, unknown> };
}

describe("ranged baseline with apply.respectFrontmatter off (#131, review #109 F3)", () => {
  it("is the frontmatter model, as for a plain pin, not the main session's model", async () => {
    const plain = await dispatch(PINNED_YAML, { respectFrontmatter: false });
    const ranged = await dispatch(RANGED_YAML, { respectFrontmatter: false });
    // Both apply the verdict: the range is not respected, so the agent moves like an unpinned one.
    for (const d of [plain, ranged]) {
      expect(d.a.model).toBe("haiku");
      expect(d.row).toMatchObject({ action: "applied", modelFinal: "haiku" });
    }
    expect(plain.row.baselineModel).toBe("sonnet");
    expect(ranged.row.baselineModel).toBe("sonnet");
    expect(ranged.row.baselineModel).not.toBe(MAIN_MODEL);
    // Not a ranged dispatch: no flag or fallback field on the row.
    expect(ranged.sc[RANGED_FLAG]).toBeUndefined();
    expect(ranged.sc[FALLBACK_PIN_FIELD]).toBeUndefined();
  });

  it("is the frontmatter model also with CLAUDE_CODE_SUBAGENT_MODEL set (FORCE off)", async () => {
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: "opus" };
    const plain = await dispatch(PINNED_YAML, { respectFrontmatter: false, env });
    const ranged = await dispatch(RANGED_YAML, { respectFrontmatter: false, env });
    expect(plain.row.baselineModel).toBe("sonnet");
    expect(ranged.row.baselineModel).toBe("sonnet");
  });

  it("FORCE keeps its baseline: CLAUDE_CODE_SUBAGENT_MODEL, over the frontmatter", async () => {
    const env = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "opus" };
    const ranged = await dispatch(RANGED_YAML, { respectFrontmatter: false, env });
    expect(ranged.a.model).toBeUndefined();
    expect(ranged.sc).toMatchObject({ forced: true });
    expect(ranged.row.baselineModel).toBe("opus");
  });
});

describe("ranged dispatch with apply.respectFrontmatter on is unchanged (#131)", () => {
  it("the range still moves the agent (no respected-pin branch); the baseline is the fallback", async () => {
    const ranged = await dispatch(RANGED_YAML, { respectFrontmatter: true });
    expect(ranged.a.model).toBe("haiku");
    expect(ranged.row).toMatchObject({
      action: "applied",
      modelFinal: "haiku",
      baselineModel: "sonnet",
    });
    expect(ranged.sc[RANGED_FLAG]).toBe(true);
    expect(ranged.sc[FALLBACK_PIN_FIELD]).toBe("sonnet");

    // The plain pin is respected and never moves.
    const plain = await dispatch(PINNED_YAML, { respectFrontmatter: true });
    expect(plain.a.model).toBeUndefined();
    expect(plain.row).toMatchObject({ modelFinal: "sonnet", baselineModel: "sonnet" });
  });
});
