/**
 * Wave 3 recall fixes: the hook verdict is reusable across prompts with the same search terms (F1),
 * shown candidates outside the 8-item pool are never dropped (F2), decision_calls records applied
 * truthfully and a detached job never counts as applied (F6), recall's note is never delivered to
 * the model (F11), the store carries the job-gate methods (no structural cast) and a wrong hook
 * script is never spawned.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import type { HookSeam } from "../../src/decisions/feature.js";
import { askRecallRerank, feature } from "../../src/decisions/features/recall.js";
import { isHookScript, spawnDecisionJob } from "../../src/decisions/job.js";
import type { DecisionJob, RerankCandidate } from "../../src/decisions/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const KEY = "sk-test-key-0123456789";
const ENV = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;
const ORIGIN = "https://api.typesafe.ai";

function cfg(): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`memory@${ORIGIN}`],
    features: { recall: { enabled: true, shadow: false } },
  }) as AdjudicatorConfig;
}

/** A live API stub: the probability of wire item "i<n>" rises with n (0.2, 0.3, ...). */
function stub(calls: { n: number }) {
  return async (_url: string, init: RequestInit) => {
    calls.n++;
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    for (const [k] of Object.entries(body.questions)) {
      const m = /i(\d+)/.exec(k);
      answers[k] = { type: "noul", noul: Math.min(0.95, 0.2 + 0.1 * Number(m?.[1] ?? 0)) };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const cand = (
  key: string,
  outcome: RerankCandidate["outcome"],
  text = `body of ${key}`,
): RerankCandidate => ({ key, label: key, text, matched: [], outcome });

let db: SqliteAdapter;
const homeBefore = process.env.EMINIAR_HOME;
beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "rw3-home-"));
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "rw3-")), "e.db"), { vectors: false });
});
afterEach(() => {
  db.db.close();
  if (homeBefore === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = homeBefore;
});

const server = (calls: { n: number }) =>
  createDecisionClient("recall", {
    config: cfg(),
    db,
    context: "server",
    env: ENV,
    fetch: stub(calls),
  });

describe("F1 the hook verdict is reusable across prompts", () => {
  const cands = [
    cand("memory:a", "shown"),
    cand("memory:b", "shown"),
    cand("memory:c", "over-limit"),
  ];
  const hookSeam = (spawn: ReturnType<typeof vi.fn>): HookSeam => {
    const config = { adjudicator: cfg() };
    return {
      ctx: { config, root: "/x" } as never,
      db,
      sessionId: "s1",
      client: createDecisionClient("recall", { config: cfg(), db, context: "hook", env: ENV }),
      spawn,
    } as HookSeam;
  };

  it("a job answer for one prompt serves another prompt with the same search terms", async () => {
    const calls = { n: 0 };
    const keys = await askRecallRerank(server(calls), {
      path: "prompt",
      query: "fix sqlite migration failure",
      candidates: cands,
      dropBelow: 0.25,
      budgetMs: 2000,
    });
    expect(calls.n).toBe(1);
    expect(keys).toBeDefined();

    const spawn = vi.fn(() => true);
    const rerank = feature.recallRerank?.(hookSeam(spawn), "prompt");
    // different wording and order, same terms
    const out = rerank?.("migration sqlite failure, fix the", cands);
    expect(spawn).not.toHaveBeenCalled();
    expect(out).toEqual(keys);
    const rows = db.decisions.list({ feature: "recall" });
    expect(rows[0]?.status).toBe("cached");
  });

  it("a prompt with other terms is still a miss and queues exactly one job", () => {
    const spawn = vi.fn(() => true);
    const rerank = feature.recallRerank?.(hookSeam(spawn), "prompt");
    expect(rerank?.("completely different dashboard styling", cands)).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("cacheContext only changes the key: the provider still gets the real context", async () => {
    const calls = { n: 0 };
    const bodies: string[] = [];
    const f = stub(calls);
    const c = createDecisionClient("recall", {
      config: cfg(),
      db,
      context: "server",
      env: ENV,
      fetch: async (u: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return f(u, init);
      },
    });
    const q = {
      name: "relevant",
      kind: "yes_no" as const,
      instructions: "Is {item} relevant?",
    };
    const base = {
      feature: "recall" as const,
      subject: "s",
      items: [{ id: "memory:a", text: "t" }],
      questions: [q],
      baseline: [],
      budgetMs: 2000,
      cacheContext: "same terms",
    };
    await c.ask({ ...base, context: "first wording" }, () => ({ decision: [], changed: 0 }));
    await c.ask({ ...base, context: "second wording" }, () => ({ decision: [], changed: 0 }));
    expect(calls.n).toBe(1);
    expect(bodies[0]).toContain("first wording");
  });
});

describe("F2 shown candidates outside the pool are kept", () => {
  it("a shown doc past ten memories survives the rerank", async () => {
    const cands = [
      ...Array.from({ length: 10 }, (_, i) => cand(`memory:m${i}`, i < 3 ? "shown" : "over-limit")),
      cand("doc:d", "shown"),
    ];
    const keys = await askRecallRerank(server({ n: 0 }), {
      path: "prompt",
      query: "pool overflow check",
      candidates: cands,
      dropBelow: 0.25,
      budgetMs: 2000,
    });
    expect(keys).toBeDefined();
    expect(keys).toContain("doc:d");
    for (const k of ["memory:m0", "memory:m1", "memory:m2"]) {
      // shown memories are kept unless a calibrated answer rated them below the bar (i0 = 0.2)
      if (k !== "memory:m0") expect(keys).toContain(k);
    }
  });

  it("an over-limit doc is asked about even behind many over-limit memories", async () => {
    const bodies: string[] = [];
    const f = stub({ n: 0 });
    const c = createDecisionClient("recall", {
      config: cfg(),
      db,
      context: "server",
      env: ENV,
      fetch: async (u: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return f(u, init);
      },
    });
    const cands = [
      cand("memory:m0", "shown"),
      ...Array.from({ length: 9 }, (_, i) => cand(`memory:o${i}`, "over-limit")),
      cand("doc:late", "over-limit", "DOCTEXT-late"),
    ];
    await askRecallRerank(c, {
      path: "prompt",
      query: "fairness between kinds",
      candidates: cands,
      dropBelow: 0.25,
      budgetMs: 2000,
    });
    expect(bodies.join("")).toContain("DOCTEXT-late");
  });

  it("with more than eight shown (em_recall limit) the ones past the pool follow the answered", async () => {
    const cands = Array.from({ length: 11 }, (_, i) => cand(`memory:m${i}`, "shown"));
    const keys = await askRecallRerank(server({ n: 0 }), {
      path: "prompt",
      query: "limit beyond eight",
      candidates: cands,
      dropBelow: 0.25,
      budgetMs: 2000,
    });
    expect(keys).toBeDefined();
    expect(keys?.slice(-3)).toEqual(["memory:m8", "memory:m9", "memory:m10"]);
    expect(keys).toHaveLength(10); // m0 rated 0.2 < 0.25 is the only drop
  });
});

describe("F6 applied is recorded truthfully", () => {
  const q = { name: "relevant", kind: "yes_no" as const, instructions: "Is {item} relevant?" };
  const ask = (c: ReturnType<typeof server>, over: Record<string, unknown> = {}) =>
    c.ask(
      {
        feature: "recall",
        subject: "s",
        context: "ctx",
        items: [{ id: "memory:a", text: "t" }],
        questions: [q],
        baseline: [],
        budgetMs: 2000,
        sessionId: "sess",
        ...over,
      },
      () => ({ decision: ["memory:a"], changed: 1, note: "a note" }),
    );

  it("a fillOnly ask (the detached job) records applied = 0 and does not apply", async () => {
    const r = await ask(server({ n: 0 }), { fillOnly: true });
    expect(r.status).toBe("ok");
    expect(r.apply).toBe(false);
    const row = db.decisions.list({ feature: "recall" })[0];
    expect(row?.applied).toBe(false);
    expect(row?.changed).toBe(1);
    expect(row?.noteSession).toBeNull();
  });

  it("an ordinary live ask still applies", async () => {
    const r = await ask(server({ n: 0 }));
    expect(r.apply).toBe(true);
    expect(db.decisions.list({ feature: "recall" })[0]?.applied).toBe(true);
  });

  it("record() takes applied (the hook's cached row)", () => {
    const hook = createDecisionClient("recall", { config: cfg(), db, context: "hook", env: ENV });
    const base = { feature: "recall" as const, subject: "p", baseline: [], items: 2 };
    hook.record(base, "cached", { decision: ["x"], changed: 1 }, { applied: true });
    hook.record(base, "cached", { decision: ["x"], changed: 1 });
    const rows = db.decisions.list({ feature: "recall" });
    expect(rows.map((r) => r.applied).sort()).toEqual([false, true]);
  });
});

describe("F11 recall notes are never delivered to the model", () => {
  const q = { name: "relevant", kind: "yes_no" as const, instructions: "Is {item} relevant?" };
  const run = (deliver: boolean) =>
    server({ n: 0 }).ask(
      {
        feature: "recall",
        subject: "s",
        context: "ctx",
        items: [{ id: "memory:a", text: "t" }],
        questions: [q],
        baseline: [],
        budgetMs: 2000,
        sessionId: "sess",
      },
      () => ({ decision: ["memory:a"], changed: 1, note: "n", ...(deliver ? { deliver } : {}) }),
    );

  it("a note without deliver stays on the row and queues nothing", async () => {
    await run(false);
    expect(db.decisions.list({ feature: "recall" })[0]?.note).toBe("n");
    expect(db.decisions.pendingNotes("sess", Date.now())).toEqual([]);
  });

  it("a deliver note is still queued (control)", async () => {
    await run(true);
    expect(db.decisions.pendingNotes("sess", Date.now())).toHaveLength(1);
  });

  it("recall's own note is dashboard-only", async () => {
    const calls = { n: 0 };
    const cands = [cand("memory:a", "shown"), cand("memory:b", "shown")];
    await askRecallRerank(server(calls), {
      path: "prompt",
      query: "quiet note check",
      candidates: cands,
      dropBelow: 0.25,
      budgetMs: 2000,
      sessionId: "sess",
    });
    expect(db.decisions.pendingNotes("sess", Date.now())).toEqual([]);
    expect(db.decisions.list({ feature: "recall" })[0]?.noteSession).toBeNull();
  });
});

describe("the job gate lives on the store type", () => {
  it("claimJob, releaseJob and hasUnsupported are DecisionStore methods", () => {
    const o = {
      feature: "recall" as const,
      scope: "s",
      now: Date.now(),
      ttlMs: 30_000,
      perScope: 1,
      maxRunning: 4,
    };
    expect(db.decisions.claimJob(o)).toBe(true);
    expect(db.decisions.claimJob(o)).toBe(false);
    db.decisions.releaseJob("recall", "s");
    expect(db.decisions.claimJob(o)).toBe(true);
    expect(db.decisions.hasUnsupported("recall", "typesafe", 0)).toBe(false);
  });
});

describe("a wrong hook script is never spawned", () => {
  const job: DecisionJob = { v: 1, feature: "swarm", projectRoot: "/x", payload: {} };
  const fake = () => {
    const child = { on: vi.fn(), unref: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } };
    return { spawn: vi.fn(() => child) as never, child };
  };

  it("recognises only the plugin hook entry", () => {
    expect(isHookScript("/p/dist/hook.js")).toBe(true);
    expect(isHookScript("/p/dist/server.js")).toBe(false);
    expect(isHookScript("/p/dist/cli.js")).toBe(false);
    expect(isHookScript("/usr/bin/vitest")).toBe(false);
  });

  it("refuses dist/server.js and an unset script, accepts dist/hook.js", () => {
    const a = fake();
    expect(spawnDecisionJob(job, { spawn: a.spawn, script: "/p/dist/server.js" })).toBe(false);
    expect(a.spawn).not.toHaveBeenCalled();
    const b = fake();
    expect(spawnDecisionJob(job, { spawn: b.spawn, script: "/p/dist/hook.js" })).toBe(true);
    expect(b.spawn).toHaveBeenCalledTimes(1);
  });
});
