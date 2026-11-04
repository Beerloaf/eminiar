import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** #66: lets a test make adjudicatePlan throw; every other call reaches the real module. */
const planFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../../src/adjudicator/swarm.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/adjudicator/swarm.js")>();
  return {
    ...real,
    adjudicatePlan: async (...args: Parameters<typeof real.adjudicatePlan>) => {
      if (planFault.error) throw planFault.error;
      return real.adjudicatePlan(...args);
    },
  };
});

import { envFlagOn, subagentModelForced } from "../../src/adjudicator/env.js";
import { effortFor, MAX_EFFORT_AT } from "../../src/adjudicator/heuristic.js";
import {
  hasProvider,
  registerProvider,
  resetProviders,
} from "../../src/adjudicator/providers/index.js";
import {
  adjudicatePlan,
  effortForced,
  modelForced,
  type PlanAdvice,
  planAdviceBlock,
  planAdviceEnabled,
  planAdviceHead,
  planLines,
  taskRequest,
} from "../../src/adjudicator/swarm.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  AGENT_EFFORT_SINCE,
  EFFORTS,
  TIERS,
} from "../../src/adjudicator/types.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { type CallerStamp, resetSwarmSecret, signCaller } from "../../src/swarm/identity.js";
import type { SwarmSpec, TaskRow } from "../../src/swarm/types.js";
import {
  emAdjudicate,
  NOTE_MAX,
  registerServerProviders,
  runAdjudicate,
  type ServerProviderOptions,
  scoreLine,
  topReasons,
} from "../../src/tools/em_adjudicate.js";
import { emSwarm } from "../../src/tools/em_swarm.js";
import { tools } from "../../src/tools/index.js";
import { availableTools } from "../../src/tools/types.js";

const YAML = `
version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 3
    agents:
      coder:
        description: writes and refactors code
        count: 2
      tester:
        description: writes and runs tests
`;
const SESSION = "sess-adj-swarm";

// The plan advice head reads CLAUDE_CODE_EFFORT_LEVEL from process.env: keep the caller's out.
const savedEffortLevel = process.env.CLAUDE_CODE_EFFORT_LEVEL;
beforeAll(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
});
afterAll(() => {
  if (savedEffortLevel !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = savedEffortLevel;
});

const configWith = (adjudicator: Record<string, unknown>): Config =>
  ConfigSchema.parse({ adjudicator });

/** A provider that answers every key with `tier` and counts its batched calls. */
function fakeProvider(tier = "opus", role?: string) {
  const calls: AdjudicationRequest[][] = [];
  const p: AdjudicatorProvider = {
    id: "embedding",
    remote: false,
    dims: role ? ["complexity", "tier", "role"] : ["complexity", "tier"],
    async adjudicate(reqs) {
      calls.push([...reqs]);
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: tier === "haiku" ? 0.5 : 3.6, confidence: 0.95 },
          tier: { probs: { [tier]: 1 }, confidence: 0.95, calibrated: true },
          ...(role ? { role: { probs: { [role]: 1 }, confidence: 0.95, calibrated: true } } : {}),
        })),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
        latencyMs: 3,
        model: "fake-embed",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 0, detail: "fake" };
    },
  };
  return { p, calls };
}

describe("ToolDef.available", () => {
  it("lists em_adjudicate only when the adjudicator is enabled", () => {
    const off = availableTools(tools, configWith({})).map((t) => t.name);
    const on = availableTools(tools, configWith({ enabled: true })).map((t) => t.name);
    expect(off).not.toContain("em_adjudicate");
    expect(on).toContain("em_adjudicate");
    // every other tool is listed either way
    expect(on.filter((n) => n !== "em_adjudicate")).toEqual(off);
    expect(off.length).toBe(tools.length - 1);
    expect(emAdjudicate.available?.(configWith({ enabled: true }))).toBe(true);
  });

  it("drops a tool whose check throws instead of failing the server", () => {
    const boom = [
      { available: () => true },
      {
        available: (): boolean => {
          throw new Error("x");
        },
      },
      {},
    ];
    expect(availableTools(boom, configWith({}))).toHaveLength(2);
  });
});

describe("plan advice helpers", () => {
  const swarm = {
    name: "feat",
    roles: [
      { role: "coder", agentType: "swarm-feat-coder", description: "writes code" },
      { role: "tester", agentType: "swarm-feat-tester", description: "tests code" },
    ],
  } as unknown as SwarmSpec;
  const task = (over: Partial<TaskRow> = {}): TaskRow => ({
    id: 5,
    run_id: "r1",
    title: "Add unit tests for the parser",
    detail: "cover the edge cases",
    role: "coder",
    status: "pending",
    agent_id: null,
    deps: [1, 2],
    files: ["src/a.ts"],
    result: null,
    auto_closed: false,
    created_by: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  });

  it("is enabled only with enabled + surfaces.plan", () => {
    expect(planAdviceEnabled(configWith({}))).toBe(false);
    expect(planAdviceEnabled(configWith({ enabled: true }))).toBe(true);
    expect(planAdviceEnabled(configWith({ enabled: true, surfaces: { plan: false } }))).toBe(false);
  });

  it("builds a plan request with the swarm's roles, files and deps as hints", () => {
    const r = taskRequest(task(), swarm);
    expect(r).toMatchObject({ key: "#5", surface: "plan" });
    expect(r.text).toBe("Add unit tests for the parser\ncover the edge cases");
    expect(r.hints).toMatchObject({ role: "coder", files: 1, deps: 2 });
    expect(r.hints?.roles?.map((x) => x.name)).toEqual(["coder", "tester"]);
  });

  it("prints one line per task, with a role-differs note", () => {
    const a: PlanAdvice[] = [
      {
        taskId: 5,
        role: "coder",
        suggestedRole: "tester",
        agentType: "swarm-feat-coder",
        model: "haiku",
        effort: "low",
        complexity: 1.2,
        confidence: 0.823,
      },
      {
        taskId: 6,
        role: "coder",
        suggestedRole: "coder",
        agentType: "swarm-feat-coder",
        model: "opus",
        effort: "high",
        complexity: 3.6,
        confidence: 0.7,
      },
      {
        taskId: 7,
        suggestedRole: "tester",
        agentType: "swarm-feat-tester",
        effort: "medium",
        complexity: 2,
        confidence: 0.5,
      },
    ];
    expect(planLines(a)).toEqual([
      "#5 → swarm-feat-coder · model haiku · effort low (complexity 1, conf 0.82); role suggested: tester (planned: coder)",
      "#6 → swarm-feat-coder · model opus · effort high (complexity 4, conf 0.70)",
      "#7 → swarm-feat-tester · effort medium (complexity 2, conf 0.50); role suggested: tester",
    ]);
    expect(planAdviceBlock([])).toBe("");
    expect(planAdviceBlock(a, {})).toMatch(/^Adjudicator suggestions: pass the model as `model`/);
    expect(planAdviceBlock(a, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" })).toMatch(
      /CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on/,
    );
    expect(modelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" })).toBe(false);
    expect(modelForced({})).toBe(false);
  });

  it("reads CLAUDE_CODE_SUBAGENT_MODEL_FORCE with Claude Code's on/off rule, like the hook (#43)", () => {
    const on = ["1", "true", "TRUE", "yes", "Yes", "on", "ON", " 1 "];
    const off = ["0", "false", "False", "no", "off", "OFF", "", " ", "2", "enabled"];
    for (const v of on) {
      expect(envFlagOn(v), v).toBe(true);
      expect(subagentModelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v }), v).toBe(true);
      expect(modelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v }), v).toBe(true);
    }
    for (const v of off) {
      expect(envFlagOn(v), v).toBe(false);
      expect(modelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v }), v).toBe(false);
    }
    expect(envFlagOn(undefined)).toBe(false);
    const one: PlanAdvice[] = [
      { taskId: 1, agentType: "a", model: "haiku", effort: "low", complexity: 1, confidence: 0.9 },
    ];
    expect(planAdviceBlock(one, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "no" })).toMatch(
      /^Adjudicator suggestions: pass the model/,
    );
  });
});

describe("plan advice: model pins and the Agent call's effort (#68)", () => {
  const base: PlanAdvice = {
    taskId: 3,
    role: "coder",
    agentType: "swarm-feat-coder",
    model: "haiku",
    effort: "low",
    complexity: 1,
    confidence: 0.9,
  };

  it("names a respected pin and the pick instead of a model to pass", () => {
    expect(
      planLines([
        { ...base, pin: { status: "pinned", model: "opus", source: "project" } },
        {
          ...base,
          taskId: 4,
          pin: { status: "pinned", model: "claude-haiku-4-5", source: "project" },
        },
        { ...base, taskId: 5, pin: { status: "unknown" } },
        { ...base, taskId: 6, pin: { status: "pinned", model: "sonnet", source: "user" } },
        { ...base, taskId: 7 },
      ]),
    ).toEqual([
      "#3 → swarm-feat-coder · pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose) · effort low (complexity 1, conf 0.90)",
      "#4 → swarm-feat-coder · pinned claude-haiku-4-5 (matches the adjudicator's pick) · effort low (complexity 1, conf 0.90)",
      "#5 → swarm-feat-coder · model pin is unknown (adjudicator would pick haiku; not overridden while the agent's definition cannot be read) · effort low (complexity 1, conf 0.90)",
      "#6 → swarm-feat-coder · pinned sonnet (adjudicator would pick haiku; remove the user agent's model pin to let it choose) · effort low (complexity 1, conf 0.90)",
      "#7 → swarm-feat-coder · model haiku · effort low (complexity 1, conf 0.90)",
    ]);
  });

  it("tells the coordinator to pass effort, unless CLAUDE_CODE_EFFORT_LEVEL outranks it", () => {
    expect(AGENT_EFFORT_SINCE).toBe("2.1.292");
    expect(planAdviceHead([base], {})).toBe(
      "Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call (`effort` needs Claude Code 2.1.292 or later):",
    );
    expect(planAdviceHead([{ ...base, pin: { status: "pinned", model: "opus" } }], {})).toMatch(
      /; a pinned agent keeps its model: pass no `model`:$/,
    );
    expect(effortForced({ CLAUDE_CODE_EFFORT_LEVEL: "high" })).toBe(true);
    expect(effortForced({ CLAUDE_CODE_EFFORT_LEVEL: " " })).toBe(false);
    expect(planAdviceHead([base], { CLAUDE_CODE_EFFORT_LEVEL: "high" })).toBe(
      "Adjudicator suggestions: pass the model as `model` on each Agent call (effort is informational: CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`):",
    );
    const forced = planAdviceHead([base], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    expect(forced).toMatch(/CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on/);
    expect(forced).toMatch(/pass the effort as `effort` \(Claude Code 2\.1\.292 or later\)/);
    expect(planAdviceBlock([base], {})).not.toMatch(/set only in the agent file/);
  });

  it("the effort ladder reaches max only at the top of the scale", () => {
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect([3.5, 3.6, MAX_EFFORT_AT - 0.01, MAX_EFFORT_AT, 4].map(effortFor)).toEqual([
      "xhigh",
      "xhigh",
      "xhigh",
      "max",
      "max",
    ]);
  });

  describe("adjudicatePlan resolves each agent's pin", () => {
    let root: string;
    let db: StorageAdapter;
    const savedHome = process.env.HOME;
    beforeAll(() => {
      process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-adj-pin-"));
      process.env.HOME = mkdtempSync(join(tmpdir(), "em-user-adj-pin-"));
      root = mkdtempSync(join(tmpdir(), "em-adj-pin-"));
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, ".claude", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".claude", "agents", "pinned.md"),
        "---\nname: pin-coder\nmodel: opus\n---\nb\n",
      );
      writeFileSync(
        join(root, ".claude", "agents", "free.md"),
        "---\nname: free-coder\nmodel: inherit\n---\nb\n",
      );
      resetContextCache();
      db = getStorage(getContext(root), { vectors: false });
    });
    afterAll(() => {
      closeAllStorage();
      delete process.env.EMINIAR_HOME;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    const spec = {
      name: "pins",
      roles: [
        { role: "pinned", agentType: "pin-coder", description: "pinned coder" },
        { role: "free", agentType: "free-coder", description: "free coder" },
        { role: "ghost", agentType: "ghost-coder", description: "no file" },
      ],
    } as unknown as SwarmSpec;

    const plan = async (adjudicator: Record<string, unknown>) => {
      const ctx = { root, config: configWith({ enabled: true, ...adjudicator }) };
      const run = db.swarm.runCreate({
        id: `pins-${Math.random().toString(36).slice(2, 8)}`,
        swarm: "pins",
        goal: "g",
        topology: "hierarchical",
      });
      const tasks = ["pinned", "free", "ghost"].map((role) =>
        db.swarm.taskAdd({
          run_id: run.id,
          title: `Rename a variable in the ${role} module`,
          role,
        }),
      );
      return adjudicatePlan(ctx, db, run, spec, tasks, { provider: null, env: {} });
    };

    it("pinned and unknown pins are kept; an unpinned agent gets a model", async () => {
      const a = await plan({});
      expect(a.map((x) => x.pin)).toEqual([
        { status: "pinned", model: "opus", source: "project" },
        undefined,
        { status: "unknown", source: undefined },
      ]);
      const lines = planLines(a);
      expect(lines[0]).toMatch(/^#\d+ → pin-coder · pinned opus \(/);
      expect(lines[1]).toMatch(/^#\d+ → free-coder · model (haiku|sonnet|opus|fable) · effort /);
      expect(lines[2]).toMatch(/^#\d+ → ghost-coder · model pin is unknown \(/);
      for (const l of [lines[0], lines[2]])
        expect(l).not.toMatch(/ · model (haiku|sonnet|opus|fable) /);
    });

    it("apply.respectFrontmatter false advises over every pin", async () => {
      const a = await plan({ apply: { respectFrontmatter: false } });
      expect(a.every((x) => x.pin === undefined)).toBe(true);
      expect(planLines(a).every((l) => / · model \w+ · effort /.test(l))).toBe(true);
    });
  });
});

describe("em_swarm plan advice and em_adjudicate", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  let main: CallerStamp;
  const baseConfig = () => ConfigSchema.parse({});
  type Args = Parameters<typeof emSwarm.handler>[0];
  const call = async (args: Args) => {
    const r = await emSwarm.handler({ ...args, ...main }, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  const finishAll = async () => {
    for (const r of db.swarm.runs({ status: "active", limit: 50 }))
      await call({ action: "finish", run: r.id, status: "cancelled" });
  };
  const enable = (over: Record<string, unknown> = {}) => {
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({ enabled: true, provider: "embedding", ...over }).adjudicator,
    };
  };

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-adj-swarm-"));
    resetSwarmSecret();
    main = signCaller({ kind: "main", sessionId: SESSION });
    root = mkdtempSync(join(tmpdir(), "em-adj-swarm-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), YAML);
    resetContextCache();
    resetSwarmConfigCache();
    ctx = getContext(root);
    db = getStorage(ctx, { vectors: false });
  });
  afterAll(() => {
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
  });
  beforeEach(() => {
    resetProviders();
    ctx.config = baseConfig();
  });
  afterEach(async () => {
    await finishAll();
    resetProviders();
  });

  it("leaves start and plan untouched while the adjudicator is off", async () => {
    const { p, calls } = fakeProvider();
    registerProvider("embedding", () => p);
    const start = await call({ action: "start", swarm: "feat", goal: "off goal" });
    expect(start).not.toContain("Adjudicator on");
    const before = db.adjudicator.list().total;
    const out = await call({
      action: "plan",
      tasks: [{ title: "Refactor the storage layer", role: "coder" }],
    });
    expect(out).not.toMatch(/Adjudicator|model/);
    expect(calls).toHaveLength(0);
    expect(db.adjudicator.list().total).toBe(before);
  });

  it("adds one coordinatorBrief line when enabled", async () => {
    enable();
    const start = await call({ action: "start", swarm: "feat", goal: "on goal" });
    expect(start.match(/Adjudicator on:/g)).toHaveLength(1);
    expect(start).toContain(
      "pass them as `model` and `effort` on the Agent call (`effort` needs Claude Code 2.1.292+; a pinned agent keeps its model)",
    );
  });

  it("scores a plan in ONE batched provider call, prints a line per task and stores rows by (run, task)", async () => {
    enable();
    const { p, calls } = fakeProvider("opus", "tester");
    registerProvider("embedding", () => p);
    await call({ action: "start", swarm: "feat", goal: "plan goal" });
    const out = await call({
      action: "plan",
      tasks: [
        { title: "Redesign the storage layer across every adapter and migration", role: "coder" },
        { title: "Write integration tests for the new migration path", role: "tester" },
        {
          title: "Write and run the unit tests, test cases and test coverage for the parser",
          detail: "add vitest test files; run the test suite until the tests pass",
          role: "coder",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(calls[0]?.every((r) => r.surface === "plan")).toBe(true);
    expect(out).toContain(
      "passing each task's suggested model and effort below as `model` and `effort`",
    );
    expect(out).toContain(
      "Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call",
    );
    const lines = out.split("\n").filter((l) => /^#\d+ → /.test(l));
    expect(lines).toHaveLength(3);
    for (const l of lines)
      expect(l).toMatch(
        /^#\d+ → swarm-feat-(coder|tester) · model (haiku|sonnet|opus|fable) · effort (low|medium|high|xhigh|max) \(complexity \d, conf \d\.\d\d\)/,
      );

    const run = db.swarm.runs({ status: "active", limit: 1 })[0]!;
    const tasks = db.swarm.tasks(run.id);
    for (const t of tasks) {
      const rows = db.adjudicator.forTask(run.id, t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        surface: "plan",
        runId: run.id,
        taskId: t.id,
        action: "advised",
        sessionId: SESSION,
      });
      expect((TIERS as readonly string[]).includes(rows[0]!.tier ?? "")).toBe(true);
      expect(lines.some((l) => l.startsWith(`#${t.id} → `))).toBe(true);
    }
    // a coder task the provider calls tester work carries the role-differs note
    const coderIds = tasks.filter((t) => t.role === "coder").map((t) => t.id);
    const noted = lines.filter((l) => l.includes("role suggested: tester (planned: coder)"));
    expect(noted.length, lines.join("\n")).toBeGreaterThan(0);
    for (const l of noted) expect(coderIds.some((id) => l.startsWith(`#${id} `))).toBe(true);
  });

  it("falls back to the heuristic when the provider fails, still within one call", async () => {
    enable();
    let n = 0;
    registerProvider("embedding", () => ({
      id: "embedding",
      remote: false,
      dims: ["tier"],
      async adjudicate() {
        n++;
        throw new Error("boom");
      },
      async probe() {
        return { ok: false, latencyMs: 0, detail: "x" };
      },
    }));
    await call({ action: "start", swarm: "feat", goal: "fail goal" });
    const out = await call({
      action: "plan",
      tasks: [
        { title: "Fix a typo in the README", role: "coder" },
        { title: "Add a test", role: "tester" },
      ],
    });
    expect(n).toBe(1);
    expect(out.split("\n").filter((l) => /^#\d+ → /.test(l))).toHaveLength(2);
  });

  it("fails open when the advice step throws: the plan reports its tasks once (#66)", async () => {
    enable();
    const { p } = fakeProvider();
    registerProvider("embedding", () => p);
    await call({ action: "start", swarm: "feat", goal: "advice throws" });
    const run = db.swarm.runs({ status: "active", limit: 1 })[0]!;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    planFault.error = new Error("Cannot find module app-swarm-X.js");
    let out: string;
    try {
      out = await call({
        action: "plan",
        tasks: [{ title: "Implement exponential backoff in the downloader", role: "coder" }],
      });
    } finally {
      planFault.error = undefined;
      spy.mockRestore();
    }
    expect(out).not.toMatch(/failed|Cannot find module/);
    expect(out).toMatch(/^Planned 1 task\(s\) in run /);
    expect(out).toContain("Implement exponential backoff in the downloader (coder)");
    expect(out).not.toContain("Adjudicator suggestions");
    expect(out).not.toContain("passing each task's suggested model");
    expect(out.split("\n").at(-1)).toBe(
      "Adjudicator advice unavailable for this plan (the tasks are planned).",
    );
    expect(writes.join("")).toContain("adjudicator plan advice skipped: Cannot find module");
    const tasks = db.swarm.tasks(run.id);
    expect(tasks).toHaveLength(1);
  });

  it("skips plan advice when surfaces.plan is off, and adjudicatePlan is a no-op when disabled", async () => {
    enable({ surfaces: { plan: false } });
    const { p, calls } = fakeProvider();
    registerProvider("embedding", () => p);
    const start = await call({ action: "start", swarm: "feat", goal: "plan off" });
    expect(start).not.toContain("Adjudicator on");
    const out = await call({
      action: "plan",
      tasks: [{ title: "Refactor everything", role: "coder" }],
    });
    expect(out).not.toContain("Adjudicator suggestions");
    expect(calls).toHaveLength(0);

    const run = db.swarm.runs({ status: "active", limit: 1 })[0]!;
    const off = { ...ctx, config: baseConfig() };
    const spec = { name: "feat", roles: [] } as unknown as SwarmSpec;
    expect(await adjudicatePlan(off, db, run, spec, db.swarm.tasks(run.id))).toEqual([]);
  });

  it("score: one compact line per item, recorded with surface mcp; explain shows the tables", async () => {
    enable({ provider: "heuristic" });
    const before = db.adjudicator.list().total;
    const r = await runAdjudicate(
      {
        action: "score",
        tasks: [
          { key: "a", title: "Rename a variable in src/util.ts" },
          {
            key: "b",
            title: "Design the new storage architecture and migration plan",
            role: "architect",
          },
        ],
      },
      ctx,
      { db },
    );
    expect(r.isError).toBeFalsy();
    const text = r.content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(1000);
    const lines = text.split("\n").filter((l) => /^\[\d+\] [ab]: /.test(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /complexity \d \(\d\.\d\d\) · (haiku|sonnet|opus|fable)\/\w+ · tool \S+ · role \S+ · conf \d\.\d\d/,
    );
    expect(db.adjudicator.list().total).toBe(before + 2);
    const id = Number(/^\[(\d+)\]/.exec(lines[1]!)![1]);
    expect(db.adjudicator.get(id)?.surface).toBe("mcp");

    const ex = (await runAdjudicate({ action: "explain", id }, ctx, { db })).content[0]!.text;
    expect(ex).toContain(`Decision ${id}`);
    expect(ex).toMatch(/^tier: \w+ \(conf/m);
    expect(ex).toMatch(/^role: \w+ \(conf/m);
    expect(ex).toMatch(/^tool: \S+ \(conf/m);
    expect(ex).toContain("now: provider heuristic");
    expect(ex).toContain("outcome pending");

    expect((await runAdjudicate({ action: "explain", id: 999999 }, ctx, { db })).isError).toBe(
      true,
    );
    expect((await runAdjudicate({ action: "score" }, ctx, { db })).isError).toBe(true);
  });

  it("score with text, and stays under 1 KB for a full batch of 20", async () => {
    enable({ provider: "heuristic" });
    const one = (
      await runAdjudicate({ action: "score", text: "why does the build fail on CI?" }, ctx, { db })
    ).content[0]!.text;
    expect(one).toMatch(/^\[\d+\] text: complexity/);
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      title: `Refactor module ${i} and update every caller across the codebase`,
    }));
    const many = (await runAdjudicate({ action: "score", tasks }, ctx, { db })).content[0]!.text;
    expect(many.length).toBeLessThanOrEqual(1000);
  });

  it("feedback sets the outcome and teaches the bias; stats summarises", async () => {
    enable({ provider: "heuristic" });
    const r = await runAdjudicate(
      { action: "score", text: "Refactor the session store and its tests" },
      ctx,
      { db },
    );
    const id = Number(/^\[(\d+)\]/.exec(r.content[0]!.text)![1]);
    const fb = await runAdjudicate(
      { action: "feedback", id, outcome: "too_small", note: "needed opus" },
      ctx,
      { db },
    );
    expect(fb.content[0]!.text).toMatch(
      new RegExp(
        `^Feedback too_small on decision ${id} .*outcome failure, final; the learned bias was updated\\. Note: needed opus$`,
      ),
    );
    expect(db.adjudicator.get(id)).toMatchObject({
      outcome: "failure",
      outcomeSource: "feedback:too_small",
      final: true,
    });
    expect(db.adjudicator.biasAll().some((b) => b.dimension === "tier")).toBe(true);
    // Review #30 / task #39: re-sending the same feedback (a retried tool call) is idempotent.
    const bias = db.adjudicator.biasAll();
    for (let i = 0; i < 5; i++) {
      const again = await runAdjudicate({ action: "feedback", id, outcome: "too_small" }, ctx, {
        db,
      });
      expect(again.content[0]!.text).toContain("the learned bias already reflects this");
    }
    expect(db.adjudicator.biasAll()).toEqual(bias);
    expect((await runAdjudicate({ action: "feedback", id }, ctx, { db })).isError).toBe(true);
    expect(
      (await runAdjudicate({ action: "feedback", id: 999999, outcome: "good" }, ctx, { db }))
        .isError,
    ).toBe(true);

    const st = (await runAdjudicate({ action: "stats", since: "7d" }, ctx, { db })).content[0]!
      .text;
    expect(st).toMatch(/^Adjudicator since \d{4}-\d{2}-\d{2}: \d+ decision\(s\)/);
    expect(st).toContain("outcomes ");
    expect(st).toContain("spend ");
    expect(st.length).toBeLessThanOrEqual(1000);
    expect((await runAdjudicate({ action: "stats", since: "lately" }, ctx, { db })).isError).toBe(
      true,
    );
  });

  it("stores the feedback note redacted and capped, and shows it in explain", async () => {
    enable({ provider: "heuristic" });
    const r = await runAdjudicate({ action: "score", text: "Rename the flag in the CLI" }, ctx, {
      db,
    });
    const id = Number(/^\[(\d+)\]/.exec(r.content[0]!.text)![1]);
    await runAdjudicate(
      {
        action: "feedback",
        id,
        outcome: "too_big",
        note: "haiku was enough; token sk-abcdefghijklmnopqrstuvwx leaked in the log",
      },
      ctx,
      { db },
    );
    const note = db.adjudicator.get(id)?.feedbackNote;
    expect(note).toBe("haiku was enough; token sk-*** leaked in the log");
    const ex = (await runAdjudicate({ action: "explain", id }, ctx, { db })).content[0]!.text;
    expect(ex).toContain(`feedback note: "${note}"`);

    await runAdjudicate(
      { action: "feedback", id, outcome: "good", note: `${"long note ".repeat(100)}end` },
      ctx,
      { db },
    );
    const long = db.adjudicator.get(id)?.feedbackNote ?? "";
    expect(Array.from(long)).toHaveLength(NOTE_MAX);
    expect(long.endsWith("…")).toBe(true);
    // Feedback without a note keeps the earlier one.
    await runAdjudicate({ action: "feedback", id, outcome: "good" }, ctx, { db });
    expect(db.adjudicator.get(id)?.feedbackNote).toBe(long);
  });

  it("score and feedback refuse while off; explain and stats still read", async () => {
    expect(
      (await runAdjudicate({ action: "score", text: "x y z" }, ctx, { db })).content[0]!.text,
    ).toMatch(/adjudicator is off/);
    expect(
      (await runAdjudicate({ action: "feedback", id: 1, outcome: "good" }, ctx, { db })).content[0]!
        .text,
    ).toMatch(/adjudicator is off/);
    expect((await runAdjudicate({ action: "stats" }, ctx, { db })).isError).toBeFalsy();
  });
});

describe("registerServerProviders", () => {
  beforeEach(() => resetProviders());
  afterEach(() => resetProviders());

  it("registers the embedding provider only when it is the effective provider", async () => {
    expect(await registerServerProviders(configWith({ provider: "embedding" }))).toBe(false);
    expect(hasProvider("embedding")).toBe(false);
    expect(
      await registerServerProviders(configWith({ enabled: true, provider: "heuristic" })),
    ).toBe(false);
    expect(hasProvider("embedding")).toBe(false);
    expect(
      await registerServerProviders(configWith({ enabled: true, provider: "embedding" })),
    ).toBe(true);
    expect(hasProvider("embedding")).toBe(true);
  });

  it("warms the exemplars and then the model in the background, never before returning", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const factory = (() => ({
      id: "embedding",
      remote: false,
      dims: ["tier", "complexity"],
      async adjudicate() {
        throw new Error("not called");
      },
      async warm() {
        order.push("exemplars");
        await gate;
      },
    })) as unknown as NonNullable<ServerProviderOptions["factory"]>;
    const embedder = async () => ({ warm: () => void order.push("model") });
    const cfg = configWith({ enabled: true, provider: "embedding" });

    expect(await registerServerProviders(cfg, { warm: true, factory, embedder })).toBe(true);
    expect(hasProvider("embedding")).toBe(true);
    expect(order).toEqual(["exemplars"]); // registered while the exemplar load is still running
    release();
    await new Promise((res) => setTimeout(res, 0));
    expect(order).toEqual(["exemplars", "model"]);

    // A failing warm-up is swallowed; without warm nothing is loaded.
    order.length = 0;
    const failing = (() => ({
      async warm() {
        order.push("fail");
        throw new Error("no model");
      },
    })) as unknown as NonNullable<ServerProviderOptions["factory"]>;
    expect(await registerServerProviders(cfg, { warm: true, factory: failing, embedder })).toBe(
      true,
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(order).toEqual(["fail"]);
    order.length = 0;
    expect(await registerServerProviders(cfg, { factory, embedder })).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(order).toEqual([]);
    // Disabled: no registration and no warm-up.
    resetProviders();
    expect(
      await registerServerProviders(configWith({ provider: "embedding" }), {
        warm: true,
        factory,
        embedder,
      }),
    ).toBe(false);
    expect(hasProvider("embedding")).toBe(false);
    expect(order).toEqual([]);
  });
});

describe("score line helpers", () => {
  it("keeps the three strongest reasons", () => {
    const r = topReasons([
      { feature: "a", weight: 0.1, note: "small" },
      { feature: "b", weight: -0.9, note: "big negative" },
      { feature: "c", weight: 0.5, note: "mid" },
      { feature: "d", weight: 0.3, note: "" },
    ]);
    expect(r).toEqual(["big negative", "mid", "d"]);
    expect(typeof scoreLine).toBe("function");
  });
});
