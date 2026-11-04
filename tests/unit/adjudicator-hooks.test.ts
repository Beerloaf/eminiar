import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncJob } from "../../src/adjudicator/async.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  ProviderResult,
} from "../../src/adjudicator/types.js";
import { TIERS } from "../../src/adjudicator/types.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { suggest } from "../../src/hooks/routing.js";
import type { HookInput, HookOutput } from "../../src/hooks/types.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { ApiCallInput } from "../../src/storage/types.js";

// The adjudicator's hook module, wrapped in spies; `loaded` proves it is imported lazily.
const seen = vi.hoisted(() => ({ loaded: false }));
vi.mock("../../src/adjudicator/hooks.js", async (importOriginal) => {
  seen.loaded = true;
  const actual = await importOriginal<typeof import("../../src/adjudicator/hooks.js")>();
  return {
    ...actual,
    onPrompt: vi.fn(actual.onPrompt),
    afterRouting: vi.fn(actual.afterRouting),
    onPreAgent: vi.fn(actual.onPreAgent),
    onPreTool: vi.fn(actual.onPreTool),
    onSessionStart: vi.fn(actual.onSessionStart),
    onSessionEnd: vi.fn(actual.onSessionEnd),
    onPostAgent: vi.fn(actual.onPostAgent),
  };
});

const hooksModule = () => import("../../src/adjudicator/hooks.js");

let root: string;
let session = 0;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ROUTING_MODE",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
];

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-adj-hooks-home-"));
  root = mkdtempSync(join(tmpdir(), "em-adj-hooks-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  // Swarm enforcement and roots follow the session's project dir: keep them on this project.
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterAll(() => {
  closeAllStorage();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let sid: string;
beforeEach(() => {
  sid = `S${++session}`;
  vi.clearAllMocks();
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
});

/**
 * Write the config and drop the cached context so the next hook sees it. The adjudicator
 * section goes in the personal ~/.eminiar/config.json: the project file may set only a few of
 * its keys (PROJECT_ADJUDICATOR_KEYS), never the provider.
 */
function configure(adjudicator: Record<string, unknown>, routing = "enforce") {
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: routing, deferToContextMode: false } }),
  );
  writeFileSync(
    join(process.env.EMINIAR_HOME as string, "config.json"),
    JSON.stringify({ adjudicator }),
  );
  resetContextCache();
  return getContext(root);
}

const db = () => getStorage(getContext(root), { vectors: false });
const rows = (surface?: string) =>
  db().adjudicator.list({ limit: 500, ...(surface ? { surface } : {}) }).rows;
const rowsOf = (sessionId: string, surface?: string) =>
  rows(surface).filter((r) => r.sessionId === sessionId);

const base = (over: Partial<HookInput>): HookInput => ({
  session_id: sid,
  cwd: root,
  hook_event_name: "x",
  ...over,
});
const prompt = (text: string, over: Partial<HookInput> = {}) =>
  handlers.UserPromptSubmit!(base({ hook_event_name: "UserPromptSubmit", prompt: text, ...over }));
const preTool = (tool: string, input: Record<string, unknown>, over: Partial<HookInput> = {}) =>
  handlers.PreToolUse!(
    base({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...over }),
  ) as Promise<HookOutput | undefined>;

/** PostToolUse for an Agent call, with Claude Code's structured tool_response. */
const postAgent = (
  toolUseId: string,
  response: unknown,
  over: Partial<HookInput> = {},
  input: Record<string, unknown> = AGENT_INPUT_BASE,
) =>
  handlers.PostToolUse!(
    base({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: input,
      tool_use_id: toolUseId,
      tool_response: response,
      ...over,
    }),
  );

const AGENT_INPUT_BASE: Record<string, unknown> = {
  description: "find the parser",
  prompt: "Find where the config parser is defined and list its callers.",
};

const AGENT_INPUT = {
  description: "find the parser",
  prompt: "Find where the config parser is defined and list its callers.",
  subagent_type: "general-purpose",
  run_in_background: true,
  extra_field: { nested: [1, 2] },
};

function call(over: Partial<ApiCallInput>): ApiCallInput {
  return {
    request_id: `r${Math.random()}`,
    message_id: `m${Math.random()}`,
    session_id: sid,
    agent_id: null,
    sidechain: 0,
    ts: Date.now() - 60_000,
    model: "claude-fable-1",
    input_tokens: 100,
    output_tokens: 10,
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
    ...over,
  };
}

/** A provider that answers every request with `tier` and counts its calls. */
function fakeProvider(tier = "haiku"): AdjudicatorProvider & { calls: number } {
  const p = {
    id: "openai-compatible" as const,
    remote: false,
    dims: ["complexity", "tier"] as Array<"complexity" | "tier">,
    calls: 0,
    async adjudicate(reqs: AdjudicationRequest[]): Promise<ProviderResult> {
      p.calls++;
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: 1, confidence: 0.9 },
          tier: { probs: { [tier]: 1 }, confidence: 0.9, calibrated: true },
        })),
        usage: { inTok: 10, outTok: 5, costUsd: 0 },
        latencyMs: 3,
        model: "fake",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 1, detail: "" };
    },
  };
  return p;
}

describe("disabled adjudicator", () => {
  it("costs nothing: the module is never imported, nothing runs and nothing is written", async () => {
    configure({ enabled: false });
    await handlers.SessionStart!(base({ hook_event_name: "SessionStart", source: "startup" }));
    await prompt("Refactor the storage adapter so every store shares one transaction helper.");
    const pre = await preTool("Agent", { ...AGENT_INPUT });
    await preTool("Bash", { command: "pwd" });
    await postAgent("toolu_off", { status: "async_launched", agentId: "aoff", resolvedModel: "x" });
    await handlers.SessionEnd!(base({ hook_event_name: "SessionEnd", reason: "exit" }));
    expect(seen.loaded).toBe(false);
    expect(rows()).toHaveLength(0);
    // Routing's own output, untouched: no model, no effort.
    const ui = pre?.hookSpecificOutput?.updatedInput;
    expect(ui?.model).toBeUndefined();
    expect(ui?.effort).toBeUndefined();
    const m = await hooksModule();
    expect(m.onPrompt).not.toHaveBeenCalled();
    expect(m.afterRouting).not.toHaveBeenCalled();
    expect(m.onSessionStart).not.toHaveBeenCalled();
    expect(m.onSessionEnd).not.toHaveBeenCalled();
    expect(m.onPostAgent).not.toHaveBeenCalled();
  });
});

describe("UserPromptSubmit", () => {
  it("adds one advice line and a prompt row; skips short, slash and chat prompts", async () => {
    configure({ enabled: true, promptMode: "heuristic", advice: { mainSession: "off" } });
    const out = await prompt("Where is the function parseConfig defined in src/config.ts?");
    const ctx = out?.hookSpecificOutput?.additionalContext ?? "";
    const line = ctx.split("\n").find((l) => l.startsWith("eminiar adjudicator:"));
    expect(line).toMatch(/^eminiar adjudicator: complexity \d\/4/);
    expect(line).toMatch(/if you delegate: (haiku|sonnet|opus)/);
    expect(line!.length).toBeLessThanOrEqual(220);
    expect(out?.systemMessage).toBeUndefined();
    const r = rowsOf(sid, "prompt");
    expect(r).toHaveLength(1);
    expect(r[0]!.source).toBe("heuristic");

    for (const skipped of [
      "fix it",
      "/model sonnet for this one please",
      "thanks, that looks great!",
    ])
      await prompt(skipped);
    expect(rowsOf(sid, "prompt")).toHaveLength(1);
  });

  it("async mode spawns one job carrying the row id; blocking mode calls the provider inline", async () => {
    const ctx = configure({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      promptMode: "async",
      advice: { mainSession: "off" },
    });
    const { onPrompt } = await hooksModule();
    const jobs: AsyncJob[] = [];
    const provider = fakeProvider();
    const text = "Implement retry with backoff in src/adjudicator/providers/http.ts and add tests.";
    const a = await onPrompt(ctx, db(), base({ prompt: text }), sid, {
      provider,
      spawn: (j) => {
        jobs.push(j);
        return true;
      },
    });
    expect(a?.context).toMatch(/^eminiar adjudicator:/);
    expect(provider.calls).toBe(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.projectRoot).toBe(ctx.root);
    expect(jobs[0]!.rowId).toBe(rowsOf(sid, "prompt")[0]!.id);

    const blocking = configure({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      promptMode: "blocking",
      advice: { mainSession: "off" },
    });
    const sid2 = `${sid}-b`;
    await onPrompt(blocking, db(), base({ prompt: `${text} Again.`, session_id: sid2 }), sid2, {
      provider,
    });
    expect(provider.calls).toBe(1);
    expect(rowsOf(sid2, "prompt")[0]!.source).toBe("blend");
  });

  it("gives the user a main-session note when the session model is 2+ tiers above, with a cooldown", async () => {
    configure({
      enabled: true,
      promptMode: "heuristic",
      tiers: ["haiku", "sonnet", "opus"],
      advice: { mainSession: "user", cooldownPrompts: 3 },
    });
    db().apiCallsUpsert([call({ model: "claude-fable-1" })]);
    const ask = "Where is the function parseConfig defined in src/config.ts?";
    const shown: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) shown.push((await prompt(`${ask} (${i})`))?.systemMessage);
    expect(shown[0]).toMatch(/\/model (haiku|sonnet) would be cheaper than fable/);
    expect(shown[1]).toBeUndefined();
    expect(shown[2]).toBeUndefined();
    expect(shown[3]).toMatch(/would be cheaper/);

    // "context" sends it to Claude instead; "off" says nothing.
    configure({
      enabled: true,
      promptMode: "heuristic",
      advice: { mainSession: "context", cooldownPrompts: 0 },
    });
    const c = await prompt(`${ask} (ctx)`);
    expect(c?.systemMessage).toBeUndefined();
    expect(c?.hookSpecificOutput?.additionalContext).toMatch(/would be cheaper/);
    configure({ enabled: true, promptMode: "heuristic", advice: { mainSession: "off" } });
    const o = await prompt(`${ask} (off)`);
    expect(o?.systemMessage).toBeUndefined();
    expect(o?.hookSpecificOutput?.additionalContext).not.toMatch(/would be cheaper/);
  });
});

describe("PreToolUse Agent, apply mode", () => {
  const apply = (over: Record<string, unknown> = {}, routing = "enforce") =>
    configure(
      {
        enabled: true,
        mode: "apply",
        promptMode: "heuristic",
        apply: { scope: "all", minConfidence: 0 },
        ...over,
      },
      routing,
    );

  /** Every original field survives, plus a valid model; never effort, never a denial. */
  function expectFullInput(out: HookOutput | undefined, original: Record<string, unknown>) {
    const h = out?.hookSpecificOutput;
    expect(h?.permissionDecision).toBe("allow");
    const ui = h?.updatedInput as Record<string, unknown>;
    for (const [k, v] of Object.entries(original)) if (k !== "prompt") expect(ui[k]).toEqual(v);
    expect(String(ui.prompt)).toContain(String(original.prompt));
    expect(TIERS).toContain(ui.model);
    expect(ui).not.toHaveProperty("effort");
    return ui;
  }

  it("keeps every field on the enforce prefix path", async () => {
    apply();
    const out = await preTool("Agent", { ...AGENT_INPUT });
    const ui = expectFullInput(out, AGENT_INPUT);
    expect(String(ui.prompt).startsWith("Use the eminiar tools")).toBe(true);
    const r = rowsOf(sid, "agent");
    expect(r).toHaveLength(1);
    expect(r[0]!.action).toBe("applied");
    expect(r[0]!.modelFinal).toBe(ui.model);
    expect(r[0]!.baselineModel).toBeTruthy();
    expect(out?.hookSpecificOutput?.additionalContext).toMatch(/adjudicator: model \w+ applied/);
  });

  it("keeps every field when the prompt is already prefixed (routing's early return)", async () => {
    apply();
    const prefix = suggest("Agent", { prompt: "p" }, root)!.prefixPrompt!;
    const input = { ...AGENT_INPUT, prompt: `${prefix}${AGENT_INPUT.prompt}` };
    const ui = expectFullInput(await preTool("Agent", input), input);
    expect(ui.prompt).toBe(input.prompt);
  });

  it("keeps every field in annotate mode and keeps routing's context", async () => {
    apply({}, "annotate");
    const out = await preTool("Agent", { ...AGENT_INPUT });
    const ui = expectFullInput(out, AGENT_INPUT);
    expect(ui.prompt).toBe(AGENT_INPUT.prompt);
    expect(out?.hookSpecificOutput?.additionalContext).toMatch(/^eminiar: subagents should prefer/);
  });

  it("keeps every field with routing off", async () => {
    apply({}, "off");
    const ui = expectFullInput(await preTool("Task", { ...AGENT_INPUT }), AGENT_INPUT);
    expect(ui.prompt).toBe(AGENT_INPUT.prompt);
  });

  it("respects an explicit model, the FORCE env and a frontmatter pin", async () => {
    apply({}, "off");
    const explicit = await preTool("Agent", { ...AGENT_INPUT, model: "opus" });
    expect(explicit?.hookSpecificOutput?.updatedInput).toBeUndefined();

    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "1";
    const forced = await preTool("Agent", { ...AGENT_INPUT });
    expect(forced?.hookSpecificOutput?.updatedInput).toBeUndefined();
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "0";
    const notForced = await preTool("Agent", { ...AGENT_INPUT, description: "zero means off" });
    expect(notForced?.hookSpecificOutput?.updatedInput?.model).toBeDefined();
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;

    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "agents", "pinned.md"),
      "---\nname: pinned\nmodel: opus\n---\nbody\n",
    );
    writeFileSync(
      join(root, ".claude", "agents", "inherits.md"),
      "---\nname: inherits\nmodel: inherit\n---\nbody\n",
    );
    const pinned = await preTool("Agent", { ...AGENT_INPUT, subagent_type: "pinned" });
    expect(pinned?.hookSpecificOutput?.updatedInput).toBeUndefined();
    const inherits = await preTool("Agent", { ...AGENT_INPUT, subagent_type: "inherits" });
    expect(inherits?.hookSpecificOutput?.updatedInput?.model).toBeDefined();

    const actions = rowsOf(sid, "agent")
      .sort((a, b) => a.id - b.id)
      .map((r) => r.action);
    expect(actions).toEqual(["respected", "respected", "applied", "respected", "applied"]);
    const pinRow = rowsOf(sid, "agent").sort((a, b) => a.id - b.id)[3]!;
    expect(pinRow.baselineModel).toBe("opus");
    expect(pinRow.modelFinal).toBe("opus");
    for (const o of [explicit, forced, pinned])
      expect(o?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("scope swarm leaves a non-worker dispatch to advice", async () => {
    apply({ apply: { scope: "swarm", minConfidence: 0 } }, "off");
    const out = await preTool("Agent", { ...AGENT_INPUT });
    expect(out?.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(out?.hookSpecificOutput?.additionalContext).toMatch(/^adjudicator: /);
    expect(rowsOf(sid, "agent")[0]!.action).toBe("advised");
  });
});

describe("onPreAgent", () => {
  it("advise mode never calls the network; apply mode calls the provider on a miss", async () => {
    const advise = configure({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      mode: "advise",
    });
    const { onPreAgent } = await hooksModule();
    const provider = fakeProvider("haiku");
    const fetch = vi.fn(async () => {
      throw new Error("no network in advise mode");
    });
    const input = base({ tool_name: "Agent", tool_input: { ...AGENT_INPUT } });
    const a = await onPreAgent(advise, input, undefined, { provider, fetch });
    expect(provider.calls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(a?.model).toBeUndefined();
    expect(a?.action).toBe("advised");
    expect(a?.note).toMatch(/^adjudicator: /);
    expect(a?.note).not.toMatch(/applied/);

    const applyCtx = configure({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      mode: "apply",
      apply: { scope: "all", minConfidence: 0 },
    });
    const b = await onPreAgent(
      applyCtx,
      base({ tool_name: "Agent", tool_input: { ...AGENT_INPUT, description: "other" } }),
      undefined,
      { provider, fetch },
    );
    expect(provider.calls).toBe(1);
    expect(b?.action).toBe("applied");
    expect(TIERS).toContain(b?.model);
  });

  it("advises a model the coordinator can pass when it differs from the baseline", async () => {
    const ctx = configure({ enabled: true, mode: "advise" });
    const { onPreAgent } = await hooksModule();
    // The session runs on opus (the baseline); a file listing scores well below it.
    db().apiCallsUpsert([call({ model: "claude-opus-5-5" })]);
    const a = await onPreAgent(
      ctx,
      base({
        tool_name: "Agent",
        tool_input: { description: "x", prompt: "list the files in src" },
      }),
      undefined,
    );
    const r = rowsOf(sid, "agent")[0]!;
    expect(r.baselineModel).toBe("claude-opus-5-5");
    expect(r.modelRequested).toBeNull();
    expect(r.action).toBe("advised");
    expect(r.tier).not.toBe("opus");
    expect(a?.note).toMatch(
      /^adjudicator: model \w+ would do \(complexity \d, conf [\d.]+\): pass model:'\w+'/,
    );
  });

  it("uses the swarm task text and the plan row for a worker", async () => {
    const ctx = configure({
      enabled: true,
      mode: "apply",
      apply: { scope: "swarm", minConfidence: 0.5 },
    });
    const { onPreAgent } = await hooksModule();
    const d = db();
    const run = d.swarm.runCreate({
      id: `run-${sid}`,
      swarm: "feature",
      goal: "g",
      topology: "hierarchical",
    });
    const task = d.swarm.taskAdd({
      run_id: run.id,
      title: "Rename a variable",
      detail: "one file",
      role: "coder",
    });
    const planId = d.adjudicator.insert({
      surface: "plan",
      inputHash: "h",
      runId: run.id,
      taskId: task.id,
      tier: "haiku",
      confidence: 0.9,
      complexity: 1,
      effort: "low",
      role: "coder",
    });
    const a = await onPreAgent(
      ctx,
      base({
        tool_name: "Agent",
        tool_input: { subagent_type: "swarm-feature-coder", prompt: "task #x" },
      }),
      { kind: "worker", agentType: "swarm-feature-coder", runId: run.id, taskId: task.id },
    );
    expect(a?.model).toBe("haiku");
    const r = d.adjudicator.get(a!.rowId!)!;
    expect(r.parentId).toBe(planId);
    expect(r.runId).toBe(run.id);
    expect(r.taskId).toBe(task.id);
    expect(r.tier).toBe("haiku");
    expect(r.action).toBe("applied");
    expect(a?.note).toMatch(/suggested effort low, role coder/);
  });
});

describe("PreToolUse non-Agent tools", () => {
  const READS = [
    "latestForSession",
    "get",
    "list",
    "forTask",
    "nonFinal",
    "cacheGet",
    "providerState",
    "biasAll",
    "summary",
  ] as const;

  function spyReads() {
    const store = db().adjudicator;
    return READS.map((m) => vi.spyOn(store, m));
  }
  const totalCalls = (spies: Array<{ mock: { calls: unknown[] } }>) =>
    spies.reduce((n, s) => n + s.mock.calls.length, 0);

  it("does no SELECT when surfaces.tools is off", async () => {
    configure({ enabled: true, promptMode: "heuristic" });
    const spies = spyReads();
    await preTool("Bash", { command: "pwd" });
    await preTool("Read", { file_path: join(root, "package.json") });
    expect(totalCalls(spies)).toBe(0);
    for (const s of spies) s.mockRestore();
  });

  it("does at most one SELECT and hints once per prompt when routing said nothing", async () => {
    configure({ enabled: true, promptMode: "heuristic", surfaces: { tools: true } });
    db().adjudicator.insert({
      surface: "prompt",
      inputHash: "h",
      sessionId: sid,
      tool: "em_symbols",
      complexity: 1,
    });
    const spies = spyReads();
    const first = await preTool("Bash", { command: "pwd" }, { tool_use_id: "tu1" });
    expect(totalCalls(spies)).toBeLessThanOrEqual(1);
    expect(first?.hookSpecificOutput?.additionalContext).toMatch(/scored for em_symbols/);
    const second = await preTool("Bash", { command: "pwd" }, { tool_use_id: "tu2" });
    expect(second?.hookSpecificOutput?.additionalContext ?? "").not.toMatch(/scored for/);
    for (const s of spies) s.mockRestore();
    expect(rowsOf(sid, "prompt")[0]!.toolUseId).toBe("tu1");
  });
});

describe("PostToolUse Agent: the exact dispatch → subagent link", () => {
  const SONNET = "claude-sonnet-5-5";

  /** Two parallel same-tier dispatches in one session, plus each subagent's own calls. */
  async function twoParallel(prefix: string) {
    await preTool("Agent", { ...AGENT_INPUT, description: "first" }, { tool_use_id: `${prefix}1` });
    await preTool(
      "Agent",
      { ...AGENT_INPUT, description: "second" },
      { tool_use_id: `${prefix}2` },
    );
    const [r1, r2] = rowsOf(sid, "agent").sort((a, b) => a.id - b.id);
    const t = Math.max(r1!.ts, r2!.ts);
    db().apiCallsUpsert([
      call({
        sidechain: 1,
        agent_id: `${prefix}-agent1`,
        model: SONNET,
        ts: t + 1_000,
        input_tokens: 111,
      }),
      call({
        sidechain: 1,
        agent_id: `${prefix}-agent2`,
        model: SONNET,
        ts: t + 1_000,
        input_tokens: 222,
      }),
      // A main-thread call past the link window: ingestion has seen the whole window.
      call({ model: "claude-opus-5-5", ts: t + 2 * 60_000 }),
    ]);
    return { r1: r1!, r2: r2!, t };
  }

  it("links two parallel same-tier dispatches exactly, where window matching cannot", async () => {
    configure({ enabled: true, mode: "advise", promptMode: "heuristic" });
    const { reconcile } = await import("../../src/adjudicator/learn.js");

    // Control: without PostToolUse, reconcile leaves both rows unlinked (ambiguous).
    const control = await twoParallel("toolu_ctl");
    reconcile(db(), { now: control.t + 5 * 60_000 });
    expect(db().adjudicator.get(control.r1.id)!.agentId ?? null).toBeNull();
    expect(db().adjudicator.get(control.r2.id)!.agentId ?? null).toBeNull();

    sid = `S${++session}`;
    const { r1, r2, t } = await twoParallel("toolu_par");
    // Results arrive in the other order; the foreground and background shapes both carry agentId.
    await postAgent("toolu_par2", {
      isAsync: true,
      status: "async_launched",
      agentId: "toolu_par-agent2",
      description: "second",
      prompt: "p",
      outputFile: "/tmp/x",
      resolvedModel: SONNET,
    });
    await postAgent("toolu_par1", {
      status: "completed",
      agentId: "toolu_par-agent1",
      agentType: "general-purpose",
      content: [{ type: "text", text: "done" }],
      resolvedModel: SONNET,
      totalTokens: 10,
      totalDurationMs: 5,
      totalToolUseCount: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { onPostAgent } = await hooksModule();
    expect(onPostAgent).toHaveBeenCalledTimes(2);
    let a = db().adjudicator.get(r1.id)!;
    let b = db().adjudicator.get(r2.id)!;
    expect(a.agentId).toBe("toolu_par-agent1");
    expect(b.agentId).toBe("toolu_par-agent2");
    expect(a.actualModel).toBe(SONNET);
    expect(b.actualModel).toBe(SONNET);

    // Reconcile keeps the exact links and prices each row from its own subagent's calls.
    reconcile(db(), { now: t + 5 * 60_000 });
    a = db().adjudicator.get(r1.id)!;
    b = db().adjudicator.get(r2.id)!;
    expect(a.agentId).toBe("toolu_par-agent1");
    expect(b.agentId).toBe("toolu_par-agent2");
    expect(a.actualTokens).toBe(121);
    expect(b.actualTokens).toBe(232);
  });

  it("keeps an existing link, ignores other tools and unknown ids, and never throws", async () => {
    const ctx = configure({ enabled: true, mode: "advise", promptMode: "heuristic" });
    await preTool("Agent", { ...AGENT_INPUT }, { tool_use_id: "toolu_keep" });
    const row = rowsOf(sid, "agent")[0]!;
    db().adjudicator.update(row.id, { agentId: "earlier", actualModel: "claude-haiku-5" });
    const { onPostAgent } = await hooksModule();
    const post = (over: Partial<HookInput>) =>
      onPostAgent(ctx, db(), base({ hook_event_name: "PostToolUse", tool_name: "Agent", ...over }));
    expect(
      post({ tool_use_id: "toolu_keep", tool_response: { agentId: "later" } }),
    ).toBeUndefined();
    expect(db().adjudicator.get(row.id)!.agentId).toBe("earlier");
    expect(post({ tool_use_id: "toolu_none", tool_response: { agentId: "x" } })).toBeUndefined();
    expect(
      post({ tool_name: "Bash", tool_use_id: "toolu_keep", tool_response: {} }),
    ).toBeUndefined();
    expect(
      post({ tool_use_id: "toolu_keep", tool_response: "User rejected tool use" }),
    ).toBeUndefined();
    expect(post({ tool_use_id: "toolu_keep", tool_response: null })).toBeUndefined();
    expect(db().adjudicator.get(row.id)!.actualModel).toBe("claude-haiku-5");
  });

  it("falls back to subagents/agent-<id>.meta.json when tool_response has no agentId", async () => {
    configure({ enabled: true, mode: "advise", promptMode: "heuristic" });
    const dir = mkdtempSync(join(tmpdir(), "em-adj-transcript-"));
    const transcript = join(dir, `${sid}.jsonl`);
    writeFileSync(transcript, "");
    mkdirSync(join(dir, sid, "subagents"), { recursive: true });
    writeFileSync(
      join(dir, sid, "subagents", "agent-aother.meta.json"),
      JSON.stringify({ agentType: "x", toolUseId: "toolu_other" }),
    );
    writeFileSync(join(dir, sid, "subagents", "agent-abad.meta.json"), "{not json");
    writeFileSync(
      join(dir, sid, "subagents", "agent-a5b21cc6.meta.json"),
      JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_meta" }),
    );
    const { agentLinkOf } = await hooksModule();
    expect(agentLinkOf({ tool_use_id: "toolu_meta", transcript_path: transcript })).toEqual({
      agentId: "a5b21cc6",
    });
    expect(agentLinkOf({ tool_use_id: "toolu_gone", transcript_path: transcript })).toBeUndefined();
    expect(agentLinkOf({ tool_use_id: "toolu_meta" })).toBeUndefined();

    await preTool(
      "Agent",
      { ...AGENT_INPUT },
      { tool_use_id: "toolu_meta", transcript_path: transcript },
    );
    await postAgent("toolu_meta", { status: "completed" }, { transcript_path: transcript });
    const row = rowsOf(sid, "agent")[0]!;
    expect(row.agentId).toBe("a5b21cc6");
    expect(row.actualModel ?? null).toBeNull();
  });
});

describe("Cursor, SessionStart and SessionEnd", () => {
  it("skips the Cursor client on every surface", async () => {
    configure(
      {
        enabled: true,
        mode: "apply",
        promptMode: "heuristic",
        apply: { scope: "all", minConfidence: 0 },
      },
      "off",
    );
    await prompt("Implement the retry loop in src/adjudicator/providers/http.ts", {
      client: "cursor",
    });
    const out = await preTool("Agent", { ...AGENT_INPUT }, { client: "cursor" });
    expect(out?.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(rowsOf(sid)).toHaveLength(0);
    await postAgent("toolu_cursor", { agentId: "acur" }, { client: "cursor" });
    expect((await hooksModule()).onPostAgent).not.toHaveBeenCalled();
  });

  it("SessionEnd reconciles: a settled row without a session goes final", async () => {
    configure({ enabled: true, promptMode: "heuristic" });
    const id = db().adjudicator.insert({
      surface: "prompt",
      inputHash: "h",
      ts: Date.now() - 10 * 60_000,
    });
    expect(db().adjudicator.get(id)!.final).toBe(false);
    await handlers.SessionEnd!(base({ hook_event_name: "SessionEnd", reason: "exit" }));
    const { onSessionEnd } = await hooksModule();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(db().adjudicator.get(id)!.final).toBe(true);
  });

  it("SessionEnd drops the session's main-advice counter and leaves other sessions' alone", async () => {
    configure({
      enabled: true,
      promptMode: "heuristic",
      advice: { mainSession: "user", cooldownPrompts: 3 },
    });
    await prompt("Where is the function parseConfig defined in src/config.ts?");
    const key = `adjudicator:main:${sid}`;
    expect(db().metaGet(key)).toBeDefined();
    db().metaSet("adjudicator:main:other-session", '{"n":1}');

    await handlers.SessionEnd!(base({ hook_event_name: "SessionEnd", reason: "exit" }));
    expect(db().metaGet(key)).toBeUndefined();
    expect(db().metaGet("adjudicator:main:other-session")).toBe('{"n":1}');
    expect(db().metaDelete("adjudicator:main:other-session")).toBe(true);
    expect(db().metaDelete("adjudicator:main:other-session")).toBe(false);
  });

  it("SessionStart says one line only when degraded, and warms ollama up asynchronously", async () => {
    const { onSessionStart } = await hooksModule();
    const healthy = configure({ enabled: true });
    expect(onSessionStart(healthy, db(), {}, { env: {} })).toBeUndefined();
    const out = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(out?.hookSpecificOutput?.additionalContext).not.toMatch(/eminiar adjudicator:/);

    // Consent is personal (never read from the project file), so a remote provider set there
    // is degraded before its key is even looked up.
    const remote = configure({ enabled: true, provider: "typesafe" });
    const line = onSessionStart(remote, db(), {}, { env: {} });
    expect(line).toMatch(/^eminiar adjudicator: typesafe is remote and has no consent/);
    expect(line!.length).toBeLessThanOrEqual(200);

    // An open breaker is reported too.
    const local = configure({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      promptMode: "heuristic",
    });
    db().adjudicator.saveProviderState("openai-compatible", {
      state: "open",
      retryAt: Date.now() + 60_000,
    });
    expect(onSessionStart(local, db(), {}, { env: {} })).toMatch(/openai-compatible breaker open/);
    db().adjudicator.saveProviderState("openai-compatible", {
      state: "closed",
      retryAt: null,
      failures: 0,
    });

    const ollama = configure({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
    });
    const jobs: AsyncJob[] = [];
    onSessionStart(ollama, db(), {}, { env: {}, spawn: (j) => jobs.push(j) > 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.request.surface).toBe("test");
    expect(jobs[0]!.projectRoot).toBe(ollama.root);
  });
});

describe("withModel", () => {
  it("never turns a denial into an allow and merges into routing's updatedInput", async () => {
    const { withModel } = await hooksModule();
    const deny: HookOutput = {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    };
    expect(withModel(deny, { a: 1 }, "haiku")).toBe(deny);
    const routed: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { a: 1, prompt: "PREFIX p" },
      },
    };
    expect(
      withModel(routed, { a: 1, prompt: "p" }, "haiku")?.hookSpecificOutput?.updatedInput,
    ).toEqual({
      a: 1,
      prompt: "PREFIX p",
      model: "haiku",
    });
    expect(withModel(undefined, { a: 1 }, "opus")?.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { a: 1, model: "opus" },
    });
  });
});
