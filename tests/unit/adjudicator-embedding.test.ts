import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { EVAL_SET } from "../../src/adjudicator/data/evalset.js";
import { EXEMPLARS, type Exemplar } from "../../src/adjudicator/data/exemplars.js";
import {
  classify,
  type Embedder,
  embeddingFactory,
  exemplarCacheKey,
  exemplarCachePath,
  nearestTier,
} from "../../src/adjudicator/providers/embedding.js";
import { ProviderError } from "../../src/adjudicator/providers/http.js";
import {
  createProvider,
  registerProvider,
  resetProviders,
} from "../../src/adjudicator/providers/index.js";
import type { AdjudicationRequest } from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";

const DIMS = 128;
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Deterministic bag-of-words embedder: shared words ⇒ cosine similarity. No model download. */
function stubEmbedder(model = "stub/bow"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => {
        const v = new Float32Array(DIMS);
        for (const w of tokens(t)) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
          const at = (h >>> 0) % DIMS;
          v[at] = (v[at] ?? 0) + 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-adj-emb-"));
  process.env.EMINIAR_HOME = dir;
  resetProviders();
});
afterEach(() => {
  delete process.env.EMINIAR_HOME;
  resetProviders();
});

const adj = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({ adjudicator: { enabled: true, provider: "embedding", ...over } })
    .adjudicator;
const resolved = (cfg: AdjudicatorConfig) =>
  resolveAdjudicator(cfg, { context: "server", env: {} });
const req = (key: string, text: string): AdjudicationRequest => ({ key, surface: "prompt", text });
const opts = (deadlineMs = 2000) => ({ signal: new AbortController().signal, deadlineMs });

const SMALL: Exemplar[] = [
  { text: "rename the variable in the file", tier: "haiku", complexity: 0 },
  { text: "rename the function in the file", tier: "haiku", complexity: 1 },
  { text: "design the distributed architecture for the platform", tier: "opus", complexity: 4 },
  { text: "design the plugin architecture for the platform", tier: "opus", complexity: 3 },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both || 1);
}

describe("exemplars", () => {
  it("has at least 15 labelled exemplars per tier with integer complexity 0..4", () => {
    for (const t of ["haiku", "sonnet", "opus"] as const)
      expect(EXEMPLARS.filter((e) => e.tier === t).length).toBeGreaterThanOrEqual(15);
    for (const e of EXEMPLARS) {
      expect(Number.isInteger(e.complexity)).toBe(true);
      expect(e.complexity).toBeGreaterThanOrEqual(0);
      expect(e.complexity).toBeLessThanOrEqual(4);
      expect(e.text.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(EXEMPLARS.map((e) => norm(e.text))).size).toBe(EXEMPLARS.length);
  });

  it("keeps complexity consistent with the tier (haiku ≤ 1, sonnet 1..3, opus ≥ 3)", () => {
    for (const e of EXEMPLARS) {
      if (e.tier === "haiku") expect(e.complexity).toBeLessThanOrEqual(1);
      if (e.tier === "sonnet") expect([1, 2, 3]).toContain(e.complexity);
      if (e.tier === "opus") expect(e.complexity).toBeGreaterThanOrEqual(3);
    }
  });

  it("is disjoint from the eval set (no equal or near-identical request)", () => {
    const evalTexts = new Set(EVAL_SET.map((x) => norm(x.text)));
    for (const e of EXEMPLARS) {
      expect(evalTexts.has(norm(e.text)), e.text).toBe(false);
      for (const x of EVAL_SET)
        expect(jaccard(e.text, x.text), `${e.text} ~ ${x.text}`).toBeLessThan(0.5);
    }
  });
});

describe("classify (k-NN)", () => {
  const knn = { k: 3, minSimilarity: 0.3, tiers: ["haiku", "sonnet", "opus"] as const };

  it("votes by similarity and averages complexity", async () => {
    const emb = stubEmbedder();
    const vs = await emb.embed(
      SMALL.map((e) => e.text),
      "passage",
    );
    const [q] = await emb.embed(["design the architecture for the platform"], "passage");
    const a = classify(q as Float32Array, SMALL, vs, { ...knn, tiers: [...knn.tiers] });
    expect(a?.tier?.calibrated).toBe(true);
    const probs = a?.tier?.probs ?? {};
    expect(probs.opus ?? 0).toBeGreaterThan(probs.haiku ?? 0);
    const sum = Object.values(probs).reduce((n, p) => n + p, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(a?.tier?.confidence).toBeCloseTo(Math.max(...Object.values(probs)), 6);
    expect(a?.complexity?.value).toBeGreaterThan(2.5);
    expect(a?.complexity?.value).toBeLessThanOrEqual(4);
  });

  it("ignores neighbours below minSimilarity and returns nothing when none qualify", async () => {
    const emb = stubEmbedder();
    const vs = await emb.embed(
      SMALL.map((e) => e.text),
      "passage",
    );
    const [q] = await emb.embed(["zebra quantum banana"], "passage");
    expect(
      classify(q as Float32Array, SMALL, vs, { ...knn, tiers: [...knn.tiers] }),
    ).toBeUndefined();
  });

  it("maps a tier outside the configured ladder to the nearest configured one", () => {
    expect(nearestTier("opus", ["haiku", "sonnet"])).toBe("sonnet");
    expect(nearestTier("haiku", ["sonnet", "opus"])).toBe("sonnet");
    expect(nearestTier("sonnet", ["haiku", "opus"])).toBe("opus");
    expect(nearestTier("sonnet", ["haiku", "sonnet"])).toBe("sonnet");
  });
});

describe("embedding provider", () => {
  it("registers through registerProvider and answers tier + complexity only", async () => {
    // minSimilarity 0.6 keeps the opus exemplars (which share only "the", cosine ≈ 0.47) out.
    const emb = stubEmbedder();
    registerProvider(
      "embedding",
      embeddingFactory({ getEmbedder: async () => emb, cacheDir: dir, exemplars: SMALL }),
    );
    const cfg = adj({ embedding: { k: 3, minSimilarity: 0.6 } });
    const p = createProvider(resolved(cfg), cfg);
    expect(p?.id).toBe("embedding");
    expect(p?.remote).toBe(false);
    expect(p?.dims).toEqual(["tier", "complexity"]);
    const res = await p!.adjudicate(
      [req("a", "rename the variable in the file please"), req("b", "zebra quantum banana")],
      opts(),
    );
    expect(res.model).toBe("stub/bow");
    expect(res.usage).toEqual({ inTok: 0, outTok: 0, costUsd: 0 });
    expect(res.answers.map((a) => a.key)).toEqual(["a"]);
    const a = res.answers[0]!;
    expect(a.role).toBeUndefined();
    expect(a.tool).toBeUndefined();
    expect(Object.keys(a.tier?.probs ?? {})).toEqual(["haiku"]);
    expect(a.complexity?.value).toBeLessThanOrEqual(1);
  });

  it("is not available in a hook context", () => {
    registerProvider(
      "embedding",
      embeddingFactory({ getEmbedder: async () => stubEmbedder(), cacheDir: dir }),
    );
    const cfg = adj();
    expect(createProvider(resolveAdjudicator(cfg, { context: "hook", env: {} }), cfg)).toBeNull();
  });

  it("caches exemplar vectors on disk keyed by model id + texts and reuses them", async () => {
    const cfg = adj({ embedding: { k: 3, minSimilarity: 0.5 } });
    const emb1 = stubEmbedder();
    const p1 = embeddingFactory({ getEmbedder: async () => emb1, cacheDir: dir, exemplars: SMALL })(
      resolved(cfg),
      cfg,
      {},
    );
    await p1.adjudicate([req("a", "rename the variable")], opts());
    expect(emb1.calls[0]).toEqual(SMALL.map((e) => e.text));
    const file = exemplarCachePath(
      dir,
      "stub/bow",
      SMALL.map((e) => e.text),
    );
    expect(file).toMatch(/adjudicator-exemplars-[0-9a-f]{16}\.json$/);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).vectors).toHaveLength(SMALL.length);

    // A fresh factory (a new process) reads the file: only the request is embedded.
    const emb2 = stubEmbedder();
    const p2 = embeddingFactory({ getEmbedder: async () => emb2, cacheDir: dir, exemplars: SMALL })(
      resolved(cfg),
      cfg,
      {},
    );
    const res = await p2.adjudicate([req("a", "rename the variable")], opts());
    expect(emb2.calls).toEqual([["rename the variable"]]);
    expect(res.answers[0]?.tier?.probs.haiku).toBe(1);

    // Same factory, second provider: vectors are kept in memory.
    const p3 = embeddingFactory({ getEmbedder: async () => emb2, cacheDir: dir, exemplars: SMALL });
    const a = p3(resolved(cfg), cfg, {});
    const b = p3(resolved(cfg), cfg, {});
    await a.adjudicate([req("x", "rename")], opts());
    await b.adjudicate([req("y", "rename")], opts());
    expect(emb2.calls.slice(1)).toEqual([["rename"], ["rename"]]);
  });

  it("changes the cache key with the model id or the texts, and re-embeds a corrupt cache", async () => {
    const texts = SMALL.map((e) => e.text);
    expect(exemplarCacheKey("m1", texts)).not.toBe(exemplarCacheKey("m2", texts));
    expect(exemplarCacheKey("m1", texts)).not.toBe(exemplarCacheKey("m1", [...texts, "more"]));
    expect(exemplarCacheKey("m1", ["ab", "c"])).not.toBe(exemplarCacheKey("m1", ["a", "bc"]));

    const cfg = adj();
    const file = exemplarCachePath(dir, "stub/bow", texts);
    writeFileSync(file, "{not json");
    const emb = stubEmbedder();
    await embeddingFactory({ getEmbedder: async () => emb, cacheDir: dir, exemplars: SMALL })(
      resolved(cfg),
      cfg,
      {},
    ).warm();
    expect(emb.calls[0]).toEqual(texts);
    expect(JSON.parse(readFileSync(file, "utf8")).count).toBe(SMALL.length);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("uses the configured tiers and k", async () => {
    const emb = stubEmbedder();
    const cfg = adj({ tiers: ["haiku", "sonnet"], embedding: { k: 1, minSimilarity: 0.3 } });
    const p = embeddingFactory({ getEmbedder: async () => emb, cacheDir: dir, exemplars: SMALL })(
      resolved(cfg),
      cfg,
      {},
    );
    const res = await p.adjudicate(
      [req("a", "design the distributed architecture for the platform")],
      opts(),
    );
    expect(res.answers[0]?.tier?.probs).toEqual({ sonnet: 1 });
    expect(res.answers[0]?.complexity?.value).toBe(4);
  });

  it("times out on the deadline or an abort, and the load still finishes for the next call", async () => {
    const emb = stubEmbedder();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Embedder = {
      model: emb.model,
      async embed(texts, kind) {
        await gate;
        return emb.embed(texts, kind);
      },
    };
    const cfg = adj({ embedding: { k: 3, minSimilarity: 0.3 } });
    const f = embeddingFactory({ getEmbedder: async () => slow, cacheDir: dir, exemplars: SMALL });
    const p = f(resolved(cfg), cfg, {});
    await expect(p.adjudicate([req("a", "rename")], opts(20))).rejects.toMatchObject({
      kind: "timeout",
    });
    const ac = new AbortController();
    const pending = p.adjudicate([req("a", "rename")], { signal: ac.signal, deadlineMs: 5000 });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderError);
    release();
    const res = await p.adjudicate([req("a", "rename the variable")], opts());
    expect(res.answers).toHaveLength(1);
  });

  it("fails with invalid when embeddings are unavailable, and probes report it", async () => {
    const cfg = adj();
    const p = embeddingFactory({ getEmbedder: async () => undefined, cacheDir: dir })(
      resolved(cfg),
      cfg,
      {},
    );
    await expect(p.adjudicate([req("a", "x")], opts())).rejects.toMatchObject({ kind: "invalid" });
    const probe = await p.probe({ signal: new AbortController().signal });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/unavailable/);

    const ok = embeddingFactory({
      getEmbedder: async () => stubEmbedder(),
      cacheDir: dir,
      exemplars: SMALL,
    })(resolved(cfg), cfg, {});
    const pr = await ok.probe({ signal: new AbortController().signal });
    expect(pr).toMatchObject({ ok: true, detail: `stub/bow loaded, ${SMALL.length} exemplars` });
  });

  it("classifies the shipped exemplars against themselves (leave-one-in sanity)", async () => {
    const emb = stubEmbedder();
    const cfg = adj({ embedding: { k: 1, minSimilarity: 0.1 } });
    const p = embeddingFactory({ getEmbedder: async () => emb, cacheDir: dir })(
      resolved(cfg),
      cfg,
      {},
    );
    const res = await p.adjudicate(
      EXEMPLARS.map((e, i) => req(String(i), e.text)),
      opts(),
    );
    expect(res.answers).toHaveLength(EXEMPLARS.length);
    for (const a of res.answers) {
      const e = EXEMPLARS[Number(a.key)]!;
      expect(a.tier?.probs[e.tier]).toBe(1);
      expect(a.complexity?.value).toBe(e.complexity);
    }
  });
});

describe("module boundaries", () => {
  it("the provider registry never imports the embedding provider", () => {
    const src = readFileSync(join(__dirname, "../../src/adjudicator/providers/index.ts"), "utf8");
    expect(src).not.toMatch(/embedding\.js/);
  });
});
