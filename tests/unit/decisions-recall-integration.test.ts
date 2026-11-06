import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { HookSeam } from "../../src/decisions/feature.js";
import { feature as recallFeature } from "../../src/decisions/features/recall.js";
import type { RecallRerank, RerankCandidate } from "../../src/decisions/types.js";
import { write } from "../../src/memory/store.js";
import { recallForError, recallForText } from "../../src/session/recall.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emRecall } from "../../src/tools/em_recall.js";

// Spies over the lazily loaded modules: off must never load a feature or start a job.
const loads: string[] = [];
const spawns: unknown[] = [];
vi.mock("../../src/decisions/registry.js", async (orig) => {
  const real = await orig<typeof import("../../src/decisions/registry.js")>();
  return {
    ...real,
    loadFeature: (f: never) => {
      loads.push(f);
      return real.loadFeature(f);
    },
  };
});
vi.mock("../../src/decisions/job.js", async (orig) => {
  const real = await orig<typeof import("../../src/decisions/job.js")>();
  return {
    ...real,
    spawnDecisionJob: (job: unknown) => {
      spawns.push(job);
      return true;
    },
  };
});

const ORIGIN = "https://api.typesafe.ai";
const ENV_KEY = "sk-test-key-0123456789";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

function cfg(over: Record<string, unknown> = {}): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`memory@${ORIGIN}`],
    features: { recall: { enabled: true, shadow: false } },
    ...over,
  }) as AdjudicatorConfig;
}

const PROMPT = "how does the postgres migration rollback strategy work for the billing tables";
const NAMES = [
  "db/postgres-migration-rollback",
  "db/billing-tables-migration",
  "db/postgres-rollback-plan",
];

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-drec-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
  const bodies = [
    "The postgres migration rollback strategy for billing tables uses down scripts per migration",
    "Billing tables migration order: customers, invoices, payments; postgres migration lock timeout",
    "Postgres rollback plan: take a snapshot before the migration of the billing tables, restore on failure",
  ];
  NAMES.forEach((name, i) => {
    write(ctx, db, { name, kind: "decision", content: bodies[i]! });
  });
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  loads.length = 0;
  spawns.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

const opts = { maxMemories: 2, maxDocs: 0, trace: true };

describe("recallForText rerank seam", () => {
  it("without a seam the result is the term-matched one", async () => {
    const base = await recallForText(db, PROMPT, opts);
    expect(base.keys.length).toBe(2);
    const again = await recallForText(db, PROMPT, { ...opts, rerank: undefined });
    expect(again.text).toBe(base.text);
    expect(again.keys).toEqual(base.keys);
  });

  it("a seam that returns undefined or throws leaves the result byte-identical", async () => {
    const base = await recallForText(db, PROMPT, opts);
    const undef = await recallForText(db, PROMPT, { ...opts, rerank: () => undefined });
    const boom = await recallForText(db, PROMPT, {
      ...opts,
      rerank: () => {
        throw new Error("rerank blew up");
      },
    });
    for (const r of [undef, boom]) {
      expect(r.text).toBe(base.text);
      expect(r.keys).toEqual(base.keys);
    }
    // a non-array return is ignored too
    const junk = await recallForText(db, PROMPT, { ...opts, rerank: (() => "nope") as never });
    expect(junk.text).toBe(base.text);
  });

  it("the seam sees only candidates that cleared the term bar, with the query", async () => {
    let seenQuery = "";
    let seen: RerankCandidate[] = [];
    await recallForText(db, PROMPT, {
      ...opts,
      rerank: (q, c) => {
        seenQuery = q;
        seen = c;
        return undefined;
      },
    });
    expect(seenQuery).toBe(PROMPT);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const c of seen) {
      expect(c.key.startsWith("memory:")).toBe(true);
      expect(["shown", "over-limit"]).toContain(c.outcome);
    }
  });

  it("reorders, swaps in an over-limit candidate, and ignores unknown or duplicate keys", async () => {
    const base = await recallForText(db, PROMPT, opts);
    let all: string[] = [];
    await recallForText(db, PROMPT, {
      ...opts,
      rerank: (_q, c) => {
        all = c.map((x) => x.key);
        return undefined;
      },
    });
    expect(all.length).toBe(3);
    const reversed = [...all].reverse();
    const r = await recallForText(db, PROMPT, {
      ...opts,
      rerank: () => ["memory:ghost", ...reversed, reversed[0]!],
    });
    expect(r.keys).toEqual(reversed.slice(0, 2));
    expect(r.keys).not.toEqual(base.keys);
    // the trace tells why a baseline pick was dropped
    const dropped = r.trace?.candidates.filter((c) => c.why === "reranked out");
    expect(dropped?.length).toBeGreaterThan(0);
  });

  it("an empty verdict shows nothing (a calibrated 'none of these')", async () => {
    const r = await recallForText(db, PROMPT, { ...opts, rerank: () => [] });
    expect(r.keys).toEqual([]);
    expect(r.text).toBe("");
  });

  it("recallForError keeps the term-matched result when the seam throws", async () => {
    const err = "ERROR postgres migration rollback failed for billing tables lock timeout exceeded";
    const base = await recallForError(db, err, { maxMemories: 2 });
    const boom = await recallForError(db, err, {
      maxMemories: 2,
      rerank: () => {
        throw new Error("x");
      },
    });
    expect(boom.text).toBe(base.text);
    expect(boom.keys).toEqual(base.keys);
  });
});

const rerankOf = (s: HookSeam, path: "prompt" | "error"): RecallRerank => {
  const rr = recallFeature.recallRerank?.(s, path);
  if (!rr) throw new Error("no rerank seam");
  return rr;
};

describe("recall feature module (hook seam)", () => {
  const cands: RerankCandidate[] = [
    { key: "memory:a", label: "a", text: "alpha body", matched: [], outcome: "shown" },
    { key: "memory:b", label: "b", text: "beta body", matched: [], outcome: "shown" },
    { key: "memory:c", label: "c", text: "gamma body", matched: [], outcome: "over-limit" },
    { key: "memory:d", label: "d", text: "delta", matched: [], outcome: "gated" as never },
  ];
  type Rec = { status: string; decision?: { changed: number; decision: unknown } | undefined };
  function seam(over: {
    cachedAnswers?: Record<string, Record<string, unknown>> | undefined;
    mode?: "live" | "shadow";
    spawnOk?: boolean;
  }) {
    const recorded: Rec[] = [];
    const spawned: unknown[] = [];
    const s = {
      ctx: { config: { adjudicator: cfg() } },
      db,
      sessionId: "s1",
      client: {
        active: () => true,
        mode: () => over.mode ?? "live",
        cached: () => over.cachedAnswers,
        ask: async () => {
          throw new Error("hooks never ask");
        },
        record: (_i: unknown, status: string, decision: Rec["decision"]) => {
          recorded.push({ status, decision });
          return 1;
        },
      },
      spawn: (p: unknown) => {
        spawned.push(p);
        return over.spawnOk ?? true;
      },
    } as unknown as HookSeam;
    return { s, recorded, spawned };
  }
  const yes = (p: number) => ({ relevant: { kind: "yes_no", p, calibrated: true } });

  it("a cache miss queues one job and keeps the term-matched result", () => {
    const { s, recorded, spawned } = seam({ cachedAnswers: undefined });
    const rr = recallFeature.recallRerank?.(s, "prompt") as RecallRerank;
    expect(rr("q", cands)).toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(recorded).toHaveLength(0);
    // only shown / over-limit candidates are asked about
    const payload = spawned[0] as { items: Array<{ id: string }>; baseline: string[] };
    expect(payload.items.map((i) => i.id)).toEqual(["memory:a", "memory:b", "memory:c"]);
    expect(payload.baseline).toEqual(["memory:a", "memory:b"]);
  });

  it("a cache hit in live mode reorders; shadow only records", () => {
    const answers = { "memory:a": yes(0.1), "memory:b": yes(0.5), "memory:c": yes(0.9) };
    const live = seam({ cachedAnswers: answers, mode: "live" });
    const out = rerankOf(live.s, "prompt")("q", cands);
    expect(out).toEqual(["memory:c", "memory:b"]);
    expect(live.recorded[0]?.status).toBe("cached");
    expect(live.spawned).toHaveLength(0);

    const shadow = seam({ cachedAnswers: answers, mode: "shadow" });
    const none = rerankOf(shadow.s, "prompt")("q", cands);
    expect(none).toBeUndefined();
    expect(shadow.recorded).toHaveLength(1);
    expect(shadow.recorded[0]?.decision?.changed).toBe(1);
  });

  it("an agreeing verdict changes nothing", () => {
    const answers = { "memory:a": yes(0.9), "memory:b": yes(0.8), "memory:c": yes(0.3) };
    const { s } = seam({ cachedAnswers: answers });
    expect(rerankOf(s, "prompt")("q", cands)).toBeUndefined();
  });

  it("no candidates in the pool, or a throwing client, give undefined", () => {
    const { s } = seam({});
    const rr = recallFeature.recallRerank?.(s, "prompt") as RecallRerank;
    expect(rr("q", [])).toBeUndefined();
    expect(rr("q", [{ ...cands[3]! }])).toBeUndefined();
    const bad = {
      ...s,
      client: {
        ...s.client,
        cached: () => {
          throw new Error("db locked");
        },
      },
    } as HookSeam;
    expect(rerankOf(bad, "error")("q", cands)).toBeUndefined();
  });

  it("the job ignores a malformed payload and never throws", async () => {
    const asked: unknown[] = [];
    const client = { ask: async (i: unknown) => asked.push(i) } as never;
    for (const payload of [
      undefined,
      null,
      {},
      { path: "x" },
      { path: "prompt", query: 1 },
      { path: "prompt", query: "q", items: "no", baseline: [] },
    ]) {
      await recallFeature.runJob?.(
        { v: 1, feature: "recall", projectRoot: root, payload } as never,
        client,
        db,
      );
    }
    expect(asked).toHaveLength(0);
    await recallFeature.runJob?.(
      {
        v: 1,
        feature: "recall",
        projectRoot: root,
        payload: {
          path: "prompt",
          query: "q",
          items: [{ id: "memory:a", text: "t" }, { nope: 1 }],
          baseline: ["memory:a"],
        },
      } as never,
      client,
      db,
    );
    expect(asked).toHaveLength(1);
    expect((asked[0] as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("decisionPromptSeams", () => {
  it("with the features off, no feature module is loaded and no job spawned", async () => {
    const { decisionPromptSeams } = await import("../../src/decisions/hooks.js");
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({ enabled: true }) as AdjudicatorConfig;
    const out = await decisionPromptSeams(ctx, db, "s-off");
    expect(out).toEqual({});
    expect(loads).toEqual([]);
    expect(spawns).toEqual([]);
  });

  it("an enabled recall feature yields seams, loads only recall, and a miss spawns exactly one job with no network", async () => {
    const { decisionPromptSeams } = await import("../../src/decisions/hooks.js");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const prevKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = ENV_KEY;
    try {
      ctx.config.adjudicator = cfg();
      const seams = await decisionPromptSeams(ctx, db, "s-on");
      expect(typeof seams.prompt).toBe("function");
      expect(typeof seams.error).toBe("function");
      expect(loads).toEqual(["recall"]);
      const base = await recallForText(db, PROMPT, opts);
      const r = await recallForText(db, PROMPT, { ...opts, rerank: seams.prompt });
      expect(r.text).toBe(base.text); // a cold cache keeps the term-matched result
      expect(r.keys).toEqual(base.keys);
      expect(spawns).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prevKey;
    }
  });
});

describe("em_recall", () => {
  const run = async (query = "postgres migration rollback billing") =>
    (await emRecall.handler({ query }, ctx)).content.map((c) => c.text).join("\n");

  /** A Jev-shaped mock: ranks the LAST memory first. */
  function jevFetch(calls: { n: number; bodies: string[] }) {
    return vi.fn(async (_u: string, init: RequestInit) => {
      calls.n++;
      calls.bodies.push(String(init.body));
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const ids = Object.keys(body.questions);
      const answers = Object.fromEntries(
        ids.map((k, i) => [k, { type: "noul", noul: i === ids.length - 1 ? 0.95 : 0.4 }]),
      );
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), {
        status: 200,
      });
    });
  }

  let prevKey: string | undefined;
  beforeEach(() => {
    prevKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = ENV_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prevKey;
  });

  it("feature off: same output as no adjudicator, and the network is never touched", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({}) as AdjudicatorConfig;
    const plain = await run();
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "typesafe",
    }) as AdjudicatorConfig;
    expect(await run()).toBe(plain);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(plain).toContain("db/");
  });

  it("shadow: the output is byte-identical to off, yet the verdict is recorded", async () => {
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({}) as AdjudicatorConfig;
    const off = await run();
    const calls = { n: 0, bodies: [] as string[] };
    vi.stubGlobal("fetch", jevFetch(calls));
    ctx.config.adjudicator = cfg({ features: { recall: { enabled: true, shadow: true } } });
    const shadow = await run();
    expect(shadow).toBe(off);
    expect(calls.n).toBe(1);
    expect(db.decisions.list({}).some((r) => r.feature === "recall" && r.mode === "shadow")).toBe(
      true,
    );
  });

  it("live: reorders by the provider's verdict and ids on the wire are positional", async () => {
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({}) as AdjudicatorConfig;
    const off = (await run()).split("\n");
    const calls = { n: 0, bodies: [] as string[] };
    vi.stubGlobal("fetch", jevFetch(calls));
    ctx.config.adjudicator = cfg({
      features: { recall: { enabled: true, shadow: false, mcpMs: 2000 } },
    });
    const live = (await run("postgres migration rollback billing tables")).split("\n");
    expect(live.slice().sort()).toEqual(off.slice().sort());
    expect(live[0]).not.toBe(off[0]);
    // the item text is the consented class; the candidate keys never go out as ids
    for (const b of calls.bodies) {
      expect(b).not.toContain("memory:db/");
      expect(b).toContain('"id":"i0"');
    }
  });

  it("a failing provider (500) or a throwing fetch leaves the hybrid order untouched", async () => {
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({}) as AdjudicatorConfig;
    const off = await run("postgres migration rollback billing tables fail");
    ctx.config.adjudicator = cfg({ features: { recall: { enabled: true, shadow: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    expect(await run("postgres migration rollback billing tables fail")).toBe(off);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await run("postgres migration rollback billing tables fail")).toBe(off);
  });

  it("a hanging provider is cut off at mcpMs and the result stays the same", async () => {
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({}) as AdjudicatorConfig;
    const off = await run("postgres rollback plan migration hang");
    ctx.config.adjudicator = cfg({
      features: { recall: { enabled: true, shadow: false, mcpMs: 60 } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
          }),
      ),
    );
    const t0 = Date.now();
    expect(await run("postgres rollback plan migration hang")).toBe(off);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
