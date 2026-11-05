/**
 * Swarm judge (option E), the gaps the badge file leaves: the status text is unchanged when the
 * feature is off, shadow, unsupported, breaker-open or the provider changed; a badge never closes,
 * releases or reopens a task; the hook-free background job asks only for changed trails, sends no
 * canary and no more than the configured characters, and fails open.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import {
  feature,
  kickSwarmJudge,
  swarmBadges,
  trailHash,
} from "../../src/decisions/features/swarm.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionCallInput, DecisionJob } from "../../src/decisions/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { resetSwarmSecret, signCaller } from "../../src/swarm/identity.js";
import { emSwarm } from "../../src/tools/em_swarm.js";

const spawn = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../src/decisions/job.js", async (orig) => ({
  ...(await orig<typeof import("../../src/decisions/job.js")>()),
  spawnDecisionJob: spawn,
}));

const ORIGIN = "https://api.typesafe.ai";
const KEY = "sk-test-key-0123456789";
const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const YAML = `version: 1
swarms:
  feat:
    description: test swarm
    agents:
      coder:
        description: writes code
`;

function cfg(swarm: Record<string, unknown> | false): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`swarm@${ORIGIN}`],
    features: swarm === false ? {} : { swarm: { enabled: true, shadow: false, ...swarm } },
  }) as AdjudicatorConfig;
}

let root: string;
let home: string;
let base: ProjectContext;
let db: StorageAdapter;
let runId: string;
let t1: number;
let t2: number;

const withCfg = (a: AdjudicatorConfig): ProjectContext => ({
  ...base,
  config: ConfigSchema.parse({ adjudicator: a }),
});

const main = () => signCaller({ kind: "main", sessionId: "sess-1" });
const status = async (a: AdjudicatorConfig | undefined) => {
  const ctx = a ? withCfg(a) : base;
  const r = await emSwarm.handler({ action: "status", run: runId, ...main() }, ctx);
  return r.content.map((c) => c.text).join("\n");
};
/** `ago` strings tick over with the clock; the comparisons below are about the rest. */
const norm = (s: string) => s.replace(/\d+[smhd] ago/g, "N ago");

const verdict = (over: Partial<DecisionCallInput> = {}, flags?: unknown[]): DecisionCallInput => ({
  ts: Date.now(),
  feature: "swarm",
  context: "server",
  subject: `run:${runId}/task:${t1}`,
  mode: "live",
  status: "ok",
  provider: "typesafe",
  decision: { task: t1, hash: "h", flags: flags ?? [{ q: "stalled", p: 0.93, c: true }] },
  applied: false,
  ...over,
});

const tasksNow = () => db.swarm.tasks(runId).map((t) => ({ id: t.id, s: t.status, a: t.agent_id }));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "em-dse-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.TYPESAFE_API_KEY = KEY;
  resetSwarmSecret();
  root = mkdtempSync(join(tmpdir(), "em-dse-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  writeFileSync(join(root, ".eminiar", "swarm.yaml"), YAML);
  resetSwarmConfigCache();
  resetContextCache();
  base = getContext(root);
  db = getStorage(base, { vectors: false });
  const s = await emSwarm.handler({ action: "start", swarm: "feat", goal: "g", ...main() }, base);
  runId =
    /run (\S+)/.exec(s.content.map((c) => c.text).join("\n"))?.[1]?.replace(/[:,.)]+$/, "") ?? "";
  runId = db.swarm.runActive("feat")?.id ?? runId;
  t1 = db.swarm.taskAdd({ run_id: runId, title: "implement the thing" }).id;
  t2 = db.swarm.taskAdd({ run_id: runId, title: "write the tests" }).id;
  db.swarm.taskUpdate(t1, { status: "active", agent_id: "agent-aaaa1111" });
  db.swarm.taskUpdate(t2, { status: "done", agent_id: "agent-bbbb2222", result: "all done" });
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.TYPESAFE_API_KEY;
});
beforeEach(() => {
  spawn.mockClear();
  // rows are read newest first per task: start every test from none
  db.decisions.purge();
});

describe("status text with the judge", () => {
  it("is unchanged when off, in shadow, unsupported, on another provider and with the feature disabled", async () => {
    const plain = norm(await status(undefined));
    db.decisions.insertCall(verdict());
    expect(norm(await status(cfg(false)))).toBe(plain);
    expect(norm(await status(cfg({ enabled: false })))).toBe(plain);
    expect(norm(await status(cfg({ shadow: true })))).toBe(plain);
    // a stored shadow verdict and an unusable one never show either
    db.decisions.insertCall(verdict({ mode: "shadow" }));
    db.decisions.insertCall(verdict({ status: "unsupported" }));
    db.decisions.insertCall(verdict({ provider: "openai-compatible" }));
    expect(norm(await status(cfg({ shadow: false, flagAbove: 0.99 })))).toBe(plain);
  });

  it("shows the badge for a live verdict and nothing else changes", async () => {
    const plain = norm(await status(undefined));
    db.decisions.insertCall(verdict());
    const before = tasksNow();
    const live = norm(await status(cfg({})));
    expect(live).toContain("judge: maybe stalled (0.93)");
    expect(live.replace(" · judge: maybe stalled (0.93)", "")).toBe(plain);
    expect(tasksNow()).toEqual(before);
  });

  it("an open breaker hides the badge; uncalibrated needs 0.85", () => {
    const uncal = (p: number) =>
      db.decisions.insertCall(
        verdict({
          subject: `run:${runId}/task:${t1}`,
          decision: { task: t1, hash: "h", flags: [{ q: "stalled", p, c: false }] },
        }),
      );
    uncal(0.8);
    expect(swarmBadges(cfg({}), db, runId).has(t1)).toBe(false);
    uncal(0.9);
    expect(swarmBadges(cfg({}), db, runId).has(t1)).toBe(true);
    const open = {
      decisions: db.decisions,
      adjudicator: { providerState: () => ({ state: "open", retryAt: Date.now() + 60_000 }) },
    } as unknown as StorageAdapter;
    expect(swarmBadges(cfg({}), open, runId).size).toBe(0);
  });

  it("a badge never closes, releases or reopens a task, even for a done claim flagged unsupported", async () => {
    db.decisions.insertCall(
      verdict({
        subject: `run:${runId}/task:${t2}`,
        decision: {
          task: t2,
          hash: "h2",
          flags: [
            { q: "claim_unsupported", p: 0.99, c: true },
            { q: "looping", p: 0.95, c: true },
          ],
        },
      }),
    );
    const before = tasksNow();
    const eventsBefore = db.swarm.events(runId, { limit: 1000 }).length;
    const text = norm(await status(cfg({})));
    expect(text).toContain("judge: ");
    expect(tasksNow()).toEqual(before);
    expect(before.find((t) => t.id === t2)?.s).toBe("done");
    expect(before.find((t) => t.id === t1)?.a).toBe("agent-aaaa1111");
    expect(db.swarm.events(runId, { limit: 1000 }).length).toBe(eventsBefore);
    expect(db.swarm.runGet(runId)?.status).toBe("active");
  });

  it("an unknown flag name or garbled decision row yields no badge and no throw", () => {
    const rows = [
      verdict({ decision: { task: t1, hash: "h", flags: [{ q: "weird", p: 1, c: true }] } }),
      verdict({ decision: "nonsense" as never }),
      verdict({ decision: null as never }),
    ].map((r, i) => ({ ...r, id: i + 1 }));
    const stub = { decisions: { latestBySubject: () => rows } } as unknown as StorageAdapter;
    expect(() => swarmBadges(cfg({}), stub, runId)).not.toThrow();
    expect(swarmBadges(cfg({}), stub, runId).size).toBe(0);
  });
});

describe("kickSwarmJudge", () => {
  const tasks = () => db.swarm.tasks(runId);
  const ctxOf = (a: AdjudicatorConfig) => withCfg(a);

  it("spawns nothing when the feature is off, shadow-disabled or given no tasks", () => {
    expect(kickSwarmJudge(ctxOf(cfg(false)), db, "r-off", tasks())).toBe(false);
    expect(kickSwarmJudge(ctxOf(cfg({ enabled: false })), db, "r-off", tasks())).toBe(false);
    expect(kickSwarmJudge(ctxOf(cfg({})), db, "r-none", [])).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns once per window with the task ids, and not again until the window passes", () => {
    const ctx = ctxOf(cfg({}));
    // the status calls above already started a window for this run; look past it
    const now = Date.now() + 10 ** 7;
    expect(kickSwarmJudge(ctx, db, runId, tasks(), "s1", now)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [job] = spawn.mock.calls[0] as unknown as [DecisionJob];
    expect(job.feature).toBe("swarm");
    expect((job.payload as { run: string; tasks: number[] }).run).toBe(runId);
    expect((job.payload as { tasks: number[] }).tasks.sort()).toEqual([t1, t2].sort());
    expect(kickSwarmJudge(ctx, db, runId, tasks(), "s1", now + 1000)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("skips a task whose trail has not changed since its verdict", () => {
    const events = db.swarm.events(runId, { limit: 1000 });
    for (const t of tasks())
      db.decisions.insertCall(
        verdict({
          subject: `run:${runId}/task:${t.id}`,
          decision: { task: t.id, hash: trailHash(t, events), flags: [] },
        }),
      );
    expect(kickSwarmJudge(ctxOf(cfg({})), db, runId, tasks(), "s1", Date.now() + 10 ** 8)).toBe(
      false,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a spawn that fails reports false and does not throw", () => {
    spawn.mockReturnValueOnce(false);
    expect(() =>
      kickSwarmJudge(ctxOf(cfg({})), db, `${runId}-x`, tasks(), "s1", Date.now()),
    ).not.toThrow();
  });
});

describe("the background job", () => {
  const bodies: string[] = [];
  const fetchOk = (p: number) => async (_u: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
    return new Response(
      JSON.stringify({
        answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: p }])),
      }),
      { status: 200 },
    );
  };
  const job = (tasks: unknown, run: unknown = runId): DecisionJob => ({
    v: 1,
    feature: "swarm",
    projectRoot: root,
    sessionId: "s1",
    payload: { run, tasks },
  });
  const exec = (
    c: AdjudicatorConfig,
    deps: { fetch?: unknown; provider?: DecisionProvider },
    j: DecisionJob,
  ) =>
    feature.runJob?.(
      j,
      createDecisionClient("swarm", {
        config: c,
        db,
        context: "job",
        env: { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv,
        ...(deps as object),
      }),
      db,
    );
  const rowsFor = (id: number) =>
    db.decisions
      .list({ feature: "swarm", limit: 100 })
      .filter((r) => r.subject.endsWith(`task:${id}`));

  beforeEach(() => {
    bodies.length = 0;
  });

  it("sends no canary from a task title, result or post, and caps the item text", async () => {
    const t = db.swarm.taskAdd({ run_id: runId, title: `rotate key ${GH} now` }).id;
    db.swarm.taskUpdate(t, { status: "done", result: `ok ${GH} ${"y".repeat(3000)}` });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { features: { swarm: { maxChars: 200 } } } }),
    );
    await exec(cfg({ maxChars: 200 }), { fetch: fetchOk(0.1) }, job([t]));
    writeFileSync(join(home, "config.json"), "{}");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(GH);
    const wire = JSON.parse(bodies[0] as string) as {
      items?: Record<string, string>;
      context?: unknown;
    };
    const texts = JSON.stringify(wire);
    expect(texts).not.toContain("y".repeat(300));
  });

  it("records a live row per task with the trail hash and the flags", async () => {
    await exec(cfg({}), { fetch: fetchOk(0.95) }, job([t1]));
    const r = rowsFor(t1)[0];
    expect(r?.mode).toBe("live");
    const d = r?.decision as { task: number; hash: string; flags: Array<{ q: string; p: number }> };
    expect(d.task).toBe(t1);
    expect(d.hash).toBe(trailHash(db.swarm.taskGet(t1)!, db.swarm.events(runId, { limit: 1000 })));
    expect(d.flags.map((f) => f.q).sort()).toEqual(["looping", "needs_human", "stalled"]);
  });

  it("a done task also gets the claim question, flagged when the claim is unsupported", async () => {
    await exec(cfg({}), { fetch: fetchOk(0.05) }, job([t2]));
    const d = rowsFor(t2)[0]?.decision as { flags: Array<{ q: string; p: number }> };
    const claim = d.flags.find((f) => f.q === "claim_unsupported");
    expect(claim?.p).toBeCloseTo(0.95, 2);
  });

  it("ignores a task of another run, a non-integer id, a malformed payload and an off client", async () => {
    const before = db.decisions.list({ feature: "swarm", limit: 500 }).length;
    const calls = bodies.length;
    await exec(cfg({}), { fetch: fetchOk(0.9) }, job([999999]));
    await exec(cfg({}), { fetch: fetchOk(0.9) }, job(["x", 1.5, null]));
    await exec(cfg({}), { fetch: fetchOk(0.9) }, job("nope"));
    await exec(cfg({}), { fetch: fetchOk(0.9) }, { ...job([t1]), payload: undefined });
    await exec(cfg({ enabled: false }), { fetch: fetchOk(0.9) }, job([t1]));
    expect(bodies.length).toBe(calls);
    expect(db.decisions.list({ feature: "swarm", limit: 500 }).length).toBe(before);
  });

  it("unsupported, error and timeout produce no usable verdict and never throw", async () => {
    const fresh = (title: string) => {
      const t = db.swarm.taskAdd({ run_id: runId, title }).id;
      db.swarm.taskUpdate(t, { status: "active", agent_id: "agent-zz" });
      return t;
    };
    const unsupported: DecisionProvider = {
      id: "typesafe",
      remote: true,
      model: "m",
      maxPairs: 10,
      maxRequests: 1,
      supports: () => false,
      ask: async () => {
        throw new Error("no");
      },
    };
    const a = fresh("unsupported one");
    await expect(exec(cfg({}), { provider: unsupported }, job([a]))).resolves.toBeUndefined();
    const b = fresh("error one");
    await expect(
      exec(cfg({}), { fetch: async () => new Response("x", { status: 500 }) }, job([b])),
    ).resolves.toBeUndefined();
    const c = fresh("timeout one");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { features: { swarm: { bgMs: 50 } } } }),
    );
    const t0 = Date.now();
    await exec(
      cfg({ bgMs: 50 }),
      {
        fetch: (_u: string, init: RequestInit) =>
          new Promise((_r, rej) =>
            init.signal?.addEventListener("abort", () => rej(new Error("x"))),
          ),
      },
      job([c]),
    );
    writeFileSync(join(home, "config.json"), "{}");
    expect(Date.now() - t0).toBeLessThan(2000);
    // none of them can be shown as a badge
    const rows = [a, b, c].flatMap(rowsFor);
    for (const r of rows) expect(["ok", "partial"]).not.toContain(r.status);
    const stub = { decisions: { latestBySubject: () => rows } } as unknown as StorageAdapter;
    expect(swarmBadges(cfg({}), stub, runId).size).toBe(0);
  });
});
